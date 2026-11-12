"""为 DocumentCraft 阅读编辑器提供的 sidecar 接口。

编辑器（Tauri 应用）通过 `docflow <命令> --json` 调用本模块。每个命令向标准输出写一个
JSON 对象，失败时写 `{"status": "error", "message": ...}` 并返回非零退出码。需要较多输入的命令
从标准输入读取 JSON，避免把批注正文或检索摘录放进命令行参数。
"""

import json
import os
import sqlite3
import stat
from collections.abc import Callable
from contextlib import closing
from hashlib import sha256
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile

from .ai import AISettings, DEFAULT_ENDPOINT, DEFAULT_MODEL, settings_path
from .converter import MARKDOWN_FORMAT, TemplateMode, convert, find_pandoc, run_pandoc
from .review_notes import ReviewNote, paragraph_text
from .templates import ConversionError

NOTES_FILE = Path(".documentcraft") / "reader-spike.sqlite3"
MARKDOWN_SUFFIXES = {".md", ".markdown"}
# API Key 只经环境变量传给本次进程，不写入设置文件，也不出现在命令行参数中。
API_KEY_ENV = "DOCUMENTCRAFT_API_KEY"
CHATGPT_PROVIDERS = {"Sign in with ChatGPT", "ChatGPT（Codex CLI）", "chatgpt"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    revision TEXT NOT NULL,
    block INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    quote TEXT NOT NULL,
    prefix TEXT NOT NULL,
    suffix TEXT NOT NULL,
    body TEXT NOT NULL
)
"""
NOTE_FIELDS = ("revision", "block", "offset", "quote", "prefix", "suffix", "body")
INSERT_NOTE = """
INSERT INTO notes(path, revision, block, offset, quote, prefix, suffix, body)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
"""
# 编辑器新建的批注只按原文和前后文锚定。旧阅读器用 block 序号优先定位，-1 让它回退到文本匹配。
UNANCHORED_BLOCK = -1
MAX_NOTE_LENGTH = 20_000


# ---------------------------------------------------------------------------
# 工作区与批注存储
# ---------------------------------------------------------------------------


def _ordinary_path(path: Path) -> bool:
    """排除符号链接和 Windows 目录联接，防止批注库或检索越出工作区。"""
    try:
        info = path.lstat()
    except OSError:
        return False
    is_link = stat.S_ISLNK(info.st_mode)
    is_reparse = getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    return not is_link and not is_reparse


def _markdown_file(path: Path) -> Path:
    source = Path(path).resolve(strict=True)
    if source.suffix.lower() not in MARKDOWN_SUFFIXES or not source.is_file():
        raise ConversionError("请选择 Markdown 文件。")
    return source


def workspace_markdown(root: Path) -> list[str]:
    """列出工作区内的 Markdown 相对路径，跳过隐藏目录和链接。"""
    files = []
    for folder, folders, names in os.walk(root):
        directory = Path(folder)
        kept = []
        for name in folders:
            if name.startswith("."):
                continue
            if _ordinary_path(directory / name):
                kept.append(name)
        folders[:] = kept
        for name in names:
            path = directory / name
            if path.suffix.lower() not in MARKDOWN_SUFFIXES:
                continue
            if _ordinary_path(path):
                files.append(path.relative_to(root).as_posix())
    return sorted(files, key=str.casefold)


def _notes_database(root: Path) -> Path:
    database = root / NOTES_FILE
    for path in (database.parent, database):
        try:
            path.lstat()
        except FileNotFoundError:
            break
        if not _ordinary_path(path):
            raise ConversionError("批注数据库必须是文件夹内的普通文件。")
    return database


def _notes_in_folder(root: Path, source: Path) -> list[dict]:
    database = _notes_database(root)
    if not database.is_file():
        return []
    with closing(sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        table = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes'")
        if table.fetchone() is None:
            return []
        relative = source.relative_to(root).as_posix()
        rows = db.execute("SELECT * FROM notes WHERE path = ? ORDER BY id", (relative,))
        return [dict(row) for row in rows]


def stored_notes(source: Path) -> list[dict]:
    """读取文件旁的批注，并保留此前写在上级工作区里的记录。

    返回的 id 形如 `距离:行号`，距离 0 表示文档所在目录的批注库。
    """
    notes = []
    for distance, root in enumerate(source.parents):
        try:
            rows = _notes_in_folder(root, source)
        except (sqlite3.Error, OSError, ConversionError):
            if distance == 0:
                raise
            continue
        for row in rows:
            row["id"] = f"{distance}:{row['id']}"
            notes.append(row)
    return notes


def _note_location(source: Path, note_id: str) -> tuple[Path, Path, int]:
    """把批注 id 解析为所在批注库和行号，拒绝不属于本文档的 id。"""
    distance_text, _, row_text = note_id.partition(":")
    if not distance_text.isdigit() or not row_text.isdigit():
        raise ConversionError("批注编号无效。")
    distance = int(distance_text)
    parents = list(source.parents)
    if distance >= len(parents):
        raise ConversionError("批注编号无效。")
    root = parents[distance]
    return root, _notes_database(root), int(row_text)


def _public_note(row: dict) -> dict:
    fields = ("id", "quote", "prefix", "suffix", "body")
    return {name: row[name] for name in fields}


def list_notes(source: Path) -> dict:
    """列出当前文档的批注。"""
    source = _markdown_file(source)
    notes = [_public_note(row) for row in stored_notes(source)]
    return {"status": "ok", "notes": notes}


def _note_text(value: object, name: str, *, required: bool) -> str:
    if not isinstance(value, str):
        raise ConversionError(f"批注字段 {name} 必须是文本。")
    if len(value) > MAX_NOTE_LENGTH:
        raise ConversionError("批注内容过长。")
    if required and not value.strip():
        raise ConversionError("请输入批注并选中正文。")
    return value


def add_note(source: Path, payload: dict) -> dict:
    """在文档所在目录的批注库新增一条按原文锚定的批注。"""
    source = _markdown_file(source)
    quote = _note_text(payload.get("quote"), "quote", required=True)
    prefix = _note_text(payload.get("prefix", ""), "prefix", required=False)
    suffix = _note_text(payload.get("suffix", ""), "suffix", required=False)
    body = _note_text(payload.get("body"), "body", required=True).strip()
    revision = sha256(source.read_bytes()).hexdigest()
    database = _notes_database(source.parent)
    database.parent.mkdir(exist_ok=True)
    with closing(sqlite3.connect(database)) as db:
        db.execute(SCHEMA)
        values = (source.name, revision, UNANCHORED_BLOCK, 0, quote, prefix, suffix, body)
        cursor = db.execute(INSERT_NOTE, values)
        db.commit()
        row_id = cursor.lastrowid
    note = {"id": f"0:{row_id}", "quote": quote, "prefix": prefix, "suffix": suffix, "body": body}
    return {"status": "ok", "note": note}


def update_note(source: Path, note_id: str, payload: dict) -> dict:
    """修改批注正文。"""
    source = _markdown_file(source)
    body = _note_text(payload.get("body"), "body", required=True).strip()
    root, database, row = _note_location(source, note_id)
    relative = source.relative_to(root).as_posix()
    with closing(sqlite3.connect(database)) as db:
        cursor = db.execute("UPDATE notes SET body = ? WHERE id = ? AND path = ?", (body, row, relative))
        db.commit()
    if cursor.rowcount != 1:
        raise ConversionError("批注已不存在，请刷新后重试。")
    return {"status": "ok"}


def delete_note(source: Path, note_id: str) -> dict:
    """删除一条批注。"""
    source = _markdown_file(source)
    root, database, row = _note_location(source, note_id)
    relative = source.relative_to(root).as_posix()
    with closing(sqlite3.connect(database)) as db:
        cursor = db.execute("DELETE FROM notes WHERE id = ? AND path = ?", (row, relative))
        db.commit()
    if cursor.rowcount != 1:
        raise ConversionError("批注已不存在，请刷新后重试。")
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# 导出 Word 与分享包
# ---------------------------------------------------------------------------


def _paragraph_texts(ast: bytes) -> list[tuple[int, str]]:
    tree = json.loads(ast)
    paragraphs = []
    for index, block in enumerate(tree["blocks"]):
        if block["t"] != "Para":
            continue
        text = paragraph_text(block["c"])
        if text:
            paragraphs.append((index, text))
    return paragraphs


def locate_notes(ast: bytes, notes: list[dict]) -> tuple[list[ReviewNote], list[str]]:
    """在 Pandoc AST 的顶层段落中定位批注。

    先要求原文与前后文都吻合；没有完整匹配时，全文仅出现一次的原文也视为可定位。
    多处匹配或找不到时返回批注 id，由编辑器提示用户跳过。
    """
    paragraphs = _paragraph_texts(ast)
    located = []
    unresolved = []
    for note in notes:
        quote = note["quote"]
        exact = []
        loose = []
        for block, text in paragraphs:
            offset = text.find(quote)
            while offset != -1:
                end = offset + len(quote)
                loose.append((block, offset))
                prefix_matches = text[:offset].endswith(note["prefix"])
                suffix_matches = text[end:].startswith(note["suffix"])
                if prefix_matches and suffix_matches:
                    exact.append((block, offset))
                offset = text.find(quote, offset + 1)
        candidates = exact if exact else loose
        if len(candidates) != 1:
            unresolved.append(note["id"])
            continue
        block, offset = candidates[0]
        located.append(ReviewNote(block, offset, quote, note["body"]))
    return located, unresolved


def export_word(
    source: Path,
    template: Path,
    output: Path,
    *,
    mode: TemplateMode,
    overwrite: bool,
    with_notes: bool,
    skip_unresolved: bool,
) -> dict:
    """把当前 Markdown 按模板导出为 DOCX，可选写入批注。

    导出读取磁盘上的已保存版本，编辑器在调用前负责保存。
    """
    source = _markdown_file(source)
    if not with_notes:
        return convert(source, template, output, mode=mode, overwrite=overwrite)

    snapshot = source.read_bytes()
    revision = sha256(snapshot).hexdigest()
    ast = run_pandoc(find_pandoc(), source.parent, "--from", MARKDOWN_FORMAT, "--to", "json", data=snapshot)
    notes = stored_notes(source)
    located, unresolved = locate_notes(ast, notes)
    if unresolved and not skip_unresolved:
        return {"status": "unresolved", "count": len(unresolved), "note_ids": unresolved}
    report = convert(
        source, template, output,
        mode=mode, overwrite=overwrite, notes=tuple(located), source_revision=revision,
    )
    report["notes"] = len(located)
    report["skipped_notes"] = len(unresolved)
    return report


def share_package(source: Path, output: Path) -> dict:
    """将 Markdown 与它自己的批注打包，供另一台机器解压阅读。"""
    source = _markdown_file(source)
    output = Path(output)
    if output.suffix.lower() != ".zip":
        raise ConversionError("分享包需要使用 .zip 扩展名。")
    if output.exists() or output.is_symlink():
        raise ConversionError("已有同名分享包，请选择其他文件名。")
    data = source.read_bytes()
    filename = source.name
    notes = stored_notes(source)

    # 独立数据库仅写入本篇批注。解压后 Markdown 位于分享包根目录。
    with TemporaryDirectory(prefix=".documentcraft-share-", dir=output.parent) as folder:
        staging = Path(folder)
        database = staging / NOTES_FILE.name
        with closing(sqlite3.connect(database)) as db:
            db.execute(SCHEMA)
            for note in notes:
                values = tuple(note[field] for field in NOTE_FIELDS)
                db.execute(INSERT_NOTE, (filename, *values))
            db.commit()
        archive = staging / "share.zip"
        with ZipFile(archive, mode="x", compression=ZIP_DEFLATED) as package:
            package.writestr(filename, data)
            package.write(database, NOTES_FILE.as_posix())
        # 在 Windows 上 rename 不覆盖目标，即使同名文件在打包期间才出现。
        try:
            archive.rename(output)
        except FileExistsError as error:
            raise ConversionError("已有同名分享包，请选择其他文件名。") from error
    return {"status": "shared", "output": str(output), "notes": len(notes)}


# ---------------------------------------------------------------------------
# AI 设置
# ---------------------------------------------------------------------------


def _saved_values() -> dict:
    try:
        values = json.loads(settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(values, dict):
        return {}
    return values


def _text_value(values: dict, name: str, default: str = "") -> str:
    selected = values.get(name, default)
    if isinstance(selected, str):
        return selected
    return default


def ai_settings() -> AISettings:
    """按保存的设置和本次进程收到的 API Key 构造连接设置。"""
    values = _saved_values()
    provider = _text_value(values, "provider", "API Key")
    if provider in CHATGPT_PROVIDERS:
        model = _text_value(values, "chatgpt_model")
        effort = _text_value(values, "chatgpt_effort")
        return AISettings("chatgpt", model=model, reasoning_effort=effort)
    endpoint = _text_value(values, "endpoint", DEFAULT_ENDPOINT)
    model = _text_value(values, "model", DEFAULT_MODEL)
    key = os.environ.get(API_KEY_ENV, "") or os.environ.get("OPENAI_API_KEY", "")
    return AISettings("api", endpoint, model, key)


def ai_status() -> dict:
    """返回保存的连接设置与本机 ChatGPT 账号，不发起网络请求。"""
    from .siwc import saved_account

    values = _saved_values()
    provider = _text_value(values, "provider", "API Key")
    return {
        "status": "ok",
        "provider": "chatgpt" if provider in CHATGPT_PROVIDERS else "api",
        "endpoint": _text_value(values, "endpoint", DEFAULT_ENDPOINT),
        "model": _text_value(values, "model", DEFAULT_MODEL),
        "chatgpt_model": _text_value(values, "chatgpt_model"),
        "chatgpt_effort": _text_value(values, "chatgpt_effort"),
        "account": saved_account(),
        "env_key": bool(os.environ.get("OPENAI_API_KEY")),
    }


def save_ai_settings(payload: dict) -> dict:
    """保存连接设置。API Key 不进入持久化配置。"""
    provider = payload.get("provider")
    if provider not in {"api", "chatgpt"}:
        raise ConversionError("未知的 AI 连接方式。")
    values = {
        # 沿用旧桌面版写入的取值，旧版本仍可读取同一设置文件。
        "provider": "Sign in with ChatGPT" if provider == "chatgpt" else "API Key",
        "endpoint": _text_value(payload, "endpoint", DEFAULT_ENDPOINT).strip(),
        "model": _text_value(payload, "model", DEFAULT_MODEL).strip(),
        "chatgpt_model": _text_value(payload, "chatgpt_model").strip(),
        "chatgpt_effort": _text_value(payload, "chatgpt_effort").strip(),
    }
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        json.dump(values, file, ensure_ascii=False)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return {"status": "ok"}


def ai_login() -> dict:
    """在系统浏览器完成 ChatGPT 授权。编辑器取消登录时直接结束本进程。"""
    from .siwc import sign_in

    account = sign_in()
    return {"status": "ok", "account": account}


def ai_logout() -> dict:
    from .siwc import sign_out

    sign_out()
    return {"status": "ok"}


def ai_models() -> dict:
    """列出当前 ChatGPT 账号可用的模型和推理强度。"""
    from .siwc import account_models

    models = []
    for model in account_models():
        models.append({"name": model.display_name, "slug": model.slug, "efforts": list(model.efforts)})
    return {"status": "ok", "models": models}


# ---------------------------------------------------------------------------
# Copilot 与科研配图
# ---------------------------------------------------------------------------


def _workspace(path: Path) -> Path:
    root = Path(path).resolve(strict=True)
    if not root.is_dir():
        raise ConversionError("工作区必须是文件夹。")
    return root


def assistant_search(workspace: Path, question: str) -> dict:
    """在本地检索工作区，返回拟提交给 AI 的摘录供用户确认。"""
    from .reader_assistant import search_workspace

    root = _workspace(workspace)
    sources = search_workspace(root, workspace_markdown(root), question)
    return {"status": "ok", "sources": sources}


def assistant_organize(workspace: Path, question: str, payload: dict) -> dict:
    """只把用户确认过的摘录发给 AI，生成带来源编号的整理稿。"""
    from .reader_assistant import organize_workspace

    root = _workspace(workspace)
    sources = payload.get("sources")
    if not isinstance(sources, list):
        raise ConversionError("请先检索并确认摘录。")
    known = set(workspace_markdown(root))
    for source in sources:
        if not isinstance(source, dict) or source.get("path") not in known:
            raise ConversionError("摘录来源不在当前工作区内。")
    result = organize_workspace(ai_settings(), question.strip(), sources)
    return {"status": "ok", **result}


def figure_stage(source: Path, stage: str, payload: dict) -> dict:
    """为编辑器执行科研配图的一个阶段，校验和回插在本机完成。"""
    from .figure_workflow import commit_figures, plan_figures, refine_figure

    settings = None
    if stage in {"plan", "generate", "review"}:
        settings = ai_settings()
        connection = payload.get("connection")
        if connection is not None:
            if not isinstance(connection, dict) or connection.get("provider") != settings.provider:
                raise ConversionError("AI 连接已变更，请重新分析并确认发送目标。")
            if settings.provider == "api" and connection.get("endpoint") != settings.endpoint:
                raise ConversionError("AI 接口地址已变更，请重新分析并确认发送目标。")
    if stage == "commit":
        result = commit_figures(source, payload)
    elif stage == "plan":
        result = plan_figures(source, settings, payload)
    else:
        result = refine_figure(source, settings, stage, payload)
    return {"status": "ok", **result} if stage != "review" else result


def illustrate_document(source: Path, *, colored: bool) -> dict:
    """对当前文档执行科研配图，生成配图版和审核清单。"""
    from .illustration import illustrate

    result = illustrate(Path(source), ai_settings(), colored=colored)
    return {"status": "ok", **result}


CHAT_ROLES = {"user", "assistant"}
# 单次对话请求的文字上限。上下文由编辑器拼好后发来，过大的请求先在本地拒绝。
MAX_CHAT_CHARACTERS = 600_000


def chat_stream(payload: dict, emit: Callable[[dict], None]) -> dict:
    """Copilot 多轮对话：按保存的 AI 设置流式生成回答。

    payload 为 {"system": str, "messages": [{"role", "content"}...]}，由编辑器拼好上下文。
    每段文字以 {"type": "delta", "text": ...} 交给 emit，结束时返回 {"type": "done"}。
    """
    from .ai import stream_chat

    system = payload.get("system", "")
    messages = payload.get("messages")
    if not isinstance(system, str) or not isinstance(messages, list) or not messages:
        raise ConversionError("对话内容为空。")
    total = len(system)
    cleaned = []
    for message in messages:
        if not isinstance(message, dict):
            raise ConversionError("对话消息格式无效。")
        role = message.get("role")
        content = message.get("content")
        if role not in CHAT_ROLES or not isinstance(content, str):
            raise ConversionError("对话消息格式无效。")
        total += len(content)
        cleaned.append({"role": role, "content": content})
    if cleaned[-1]["role"] != "user":
        raise ConversionError("最后一条消息必须来自用户。")
    if total > MAX_CHAT_CHARACTERS:
        raise ConversionError("附加的上下文过长，请减少附带的笔记或选区。")
    for text in stream_chat(ai_settings(), system, cleaned):
        emit({"type": "delta", "text": text})
    return {"type": "done"}
