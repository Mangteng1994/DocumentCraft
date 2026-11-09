"""在 WebView2 中阅读 Markdown，保存、分享和导出审阅批注。"""

import argparse
from base64 import b64encode
import json
import os
import re
import sqlite3
import stat
from contextlib import closing
from hashlib import sha256
from pathlib import Path, PureWindowsPath
from tempfile import TemporaryDirectory
from urllib.parse import unquote, urlsplit
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile

from lxml import html

from .converter import MARKDOWN_FORMAT, convert, find_pandoc, run_pandoc
from .reader_assistant import organize_workspace, reader_settings, search_workspace
from .review_notes import ReviewNote, paragraph_text

ASSETS = Path(__file__).with_name("reader_ui")
ALLOWED_TAGS = set("p h1 h2 h3 h4 h5 h6 strong em s u sup sub code pre blockquote ul ol li table thead tbody tr td th div span a hr br figure figcaption img".split())
NUMERIC_ATTRIBUTES = {
    "ol": {"start": (-2_147_483_648, 2_147_483_647)},
    "li": {"value": (-2_147_483_648, 2_147_483_647)},
    "td": {"colspan": (1, 1000), "rowspan": (0, 65_534)},
    "th": {"colspan": (1, 1000), "rowspan": (0, 65_534)},
}
NOTES_FILE = Path(".documentcraft") / "reader-spike.sqlite3"
MARKDOWN_SUFFIXES = {".md", ".markdown"}
MARKDOWN_DIALOG = ("Markdown 文档 (*.md;*.markdown)",)
READER_SIZE = (1220, 800)
READER_MIN_SIZE = (650, 480)
IMAGE_TYPES = {".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif", ".webp": "webp"}
MAX_IMAGE_BYTES = 6_000_000
MAX_DOCUMENT_IMAGE_BYTES = 18_000_000
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


def _markdown_file(path: Path) -> Path:
    source = path.resolve(strict=True)
    if source.suffix.lower() not in MARKDOWN_SUFFIXES or not source.is_file():
        raise ValueError("请选择 Markdown 文件。")
    return source


def _workspace_paths(root: Path) -> tuple[list[str], list[str]]:
    """列出工作区目录和文件，跳过隐藏目录和目录链接。"""
    directories = []
    files = []
    for folder, folders, names in os.walk(root):
        directory = Path(folder)
        folders[:] = [name for name in folders if not name.startswith(".")
                      and _ordinary_path(directory / name)]
        directories.extend((directory / name).relative_to(root).as_posix() for name in folders)
        for name in names:
            path = directory / name
            if _ordinary_path(path):
                files.append(path.relative_to(root).as_posix())
    return sorted(directories, key=str.casefold), sorted(files, key=str.casefold)


def _ordinary_path(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError:
        return False
    return not stat.S_ISLNK(info.st_mode) and not (
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )


def _local_workspace_path(value: str, directory: Path, workspace: Path) -> Path | None:
    """先拒绝设备和网络地址，再沿工作区内的普通目录定位文件。"""
    windows = PureWindowsPath(value)
    path = Path(value)
    if not windows.parts or windows.anchor or path.anchor or re.search(r"[:\x00-\x1f]", value):
        return None
    if any(PureWindowsPath(part).is_reserved() for part in windows.parts):
        return None
    target = Path(os.path.abspath(directory / path))
    if not target.is_relative_to(workspace):
        return None
    current = workspace
    for part in target.relative_to(workspace).parts:
        current = current / part
        if not _ordinary_path(current):
            return None
    return target


def _notes_database(root: Path) -> Path:
    database = root / NOTES_FILE
    for path in (database.parent, database):
        try:
            path.lstat()
        except FileNotFoundError:
            break
        if not _ordinary_path(path):
            raise ValueError("批注数据库必须是文件夹内的普通文件。")
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
        rows = db.execute("SELECT * FROM notes WHERE path = ? ORDER BY id",
                          (source.relative_to(root).as_posix(),))
        return [dict(row) for row in rows]


def _stored_notes(source: Path) -> list[dict]:
    """读取文件旁的批注，并保留此前写在上级工作区里的记录。"""
    notes = []
    for distance, root in enumerate(source.parents):
        try:
            rows = _notes_in_folder(root, source)
        except (sqlite3.Error, OSError, ValueError):
            if distance == 0:
                raise
            continue
        for row in rows:
            row["id"] = f"{distance}:{row['id']}"
            notes.append(row)
    return notes


def _saved_workspace(source: Path) -> Path:
    for root in source.parents:
        try:
            if _notes_in_folder(root, source):
                return root
        except (sqlite3.Error, OSError, ValueError):
            continue
    return source.parent


def _markdown_paths(files: list[str]) -> list[str]:
    return [path for path in files if Path(path).suffix.lower() in MARKDOWN_SUFFIXES]


def _local_image(url: str, directory: Path, workspace: Path, remaining: int) -> tuple[str, int] | None:
    try:
        parsed = urlsplit(url)
        if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
            return None
        limit = min(MAX_IMAGE_BYTES, remaining)
        if limit <= 0:
            return None
        source = _local_workspace_path(unquote(parsed.path), directory, workspace)
        if source is None:
            return None
        media = IMAGE_TYPES.get(source.suffix.lower())
        if not media or not source.is_file():
            return None
        with source.open("rb") as stream:
            raw = stream.read(limit + 1)
    except (OSError, ValueError, RuntimeError):
        return None
    if len(raw) > limit:
        return None
    return f"data:image/{media};base64,{b64encode(raw).decode('ascii')}", len(raw)


def render_markdown(data: bytes, directory: Path, workspace: Path | None = None) -> str:
    """按转换器的 Markdown 方言渲染，保留正文和基础格式。"""
    executable = find_pandoc()
    ast = run_pandoc(
        executable, directory, "--from", MARKDOWN_FORMAT, "--to", "json",
        "--sandbox", data=data,
    )
    tree = json.loads(ast)
    markers = {}
    for index, block in enumerate(tree["blocks"]):
        if block["t"] != "Para":
            continue
        text = paragraph_text(block["c"])
        if not text:
            continue
        marker = "DCReader" + uuid4().hex
        markers[marker] = (index, text)
        block["c"] = [{"t": "Span", "c": [[marker, [], []], block["c"]]}]

    fragment = run_pandoc(
        executable, directory, "--from", "json", "--to", "html", "--wrap=none",
        "--sandbox", data=json.dumps(tree).encode("utf-8"),
    )
    root = html.fragment_fromstring(fragment.decode("utf-8"), create_parent="div")
    supported = []
    for marker in root.xpath(".//p/span[@id]"):
        target = markers.get(marker.get("id"))
        paragraph = marker.getparent()
        if target and paragraph.text_content() == target[1]:
            supported.append((paragraph, target[0]))
            marker.drop_tag()
    remaining = MAX_DOCUMENT_IMAGE_BYTES
    for element in list(root.iterdescendants()):
        if element.tag not in ALLOWED_TAGS:
            element.drop_tree()
            continue
        if element.tag == "img":
            alt = element.get("alt", "")
            image = _local_image(element.get("src", ""), directory, workspace or directory, remaining)
            if image is None:
                element.tag = "span"
                element.attrib.clear()
                element.text = f"[图片不可预览：{alt}]" if alt else "[图片不可预览]"
                continue
            url, length = image
            remaining -= length
            element.attrib.clear()
            element.set("src", url)
            element.set("alt", alt)
            continue
        # 批注页面带本地存储桥。预览只接收允许的标签，移除导航和事件属性。
        numeric = {name: element.get(name) for name in NUMERIC_ATTRIBUTES.get(element.tag, {})}
        element.attrib.clear()
        for name, value in numeric.items():
            if value is None or re.fullmatch(r"-?[0-9]{1,10}", value) is None:
                continue
            low, high = NUMERIC_ATTRIBUTES[element.tag][name]
            number = int(value)
            if low <= number <= high:
                element.set(name, str(number))
    for paragraph, index in supported:
        paragraph.set("data-review-block", str(index))
    return html.tostring(root, encoding="unicode")


class Reader:
    """为工作区内的 Markdown 提供只读预览和独立批注。"""

    def __init__(self, root: Path, source: Path | None, export_paths: tuple[Path, Path] | None = None) -> None:
        self._source = source
        self._root = root
        self._window = None
        self._export_paths = export_paths
        self._ai_settings = reader_settings()
        self._search: tuple[Path, str, list[dict]] | None = None

    def load(self) -> dict:
        """载入一个版本的正文和已保存批注。"""
        return self._load_document(self._root, self._source)

    def _load_document(self, root: Path, source: Path | None) -> dict:
        data = source.read_bytes() if source is not None else b""
        relative = source.relative_to(root).as_posix() if source is not None else ""
        directories, entries = _workspace_paths(root)
        files = _markdown_paths(entries)
        if relative and relative not in files:
            files.insert(0, relative)
        return {
            "path": relative,
            "workspace": root.name or str(root),
            "workspace_path": str(root),
            "directories": directories,
            "entries": entries,
            "files": files,
            "revision": sha256(data).hexdigest() if source is not None else "",
            "html": render_markdown(data, source.parent, root) if source is not None else "",
            "notes": _stored_notes(source) if source is not None else [],
        }

    def _open(self, root: Path, source: Path | None) -> dict:
        view = self._load_document(root, source)
        if root != self._root:
            self._search = None
        self._root, self._source = root, source
        return view

    def _current_source(self) -> Path:
        if self._source is None:
            raise ValueError("请先打开 Markdown 文件。")
        return self._source

    def open_document(self, path: str) -> dict:
        """打开工作区列表中的文件，并拒绝越出工作区的路径。"""
        target = _local_workspace_path(path, self._root, self._root)
        if target is None:
            raise ValueError("文件必须位于当前工作区内。")
        source = _markdown_file(target)
        return self._open(self._root, source)

    def choose_file(self) -> dict | None:
        """从系统对话框打开 Markdown，必要时切换工作区。"""
        from webview import FileDialog

        selected = self._window.create_file_dialog(FileDialog.OPEN, file_types=MARKDOWN_DIALOG)
        if not selected:
            return None
        source = _markdown_file(Path(selected[0]))
        root = self._root if source.is_relative_to(self._root) else _saved_workspace(source)
        return self._open(root, source)

    def choose_folder(self) -> dict | None:
        """打开工作区目录，当前文档不在其中时选择首篇 Markdown。"""
        from webview import FileDialog

        selected = self._window.create_file_dialog(FileDialog.FOLDER)
        if not selected:
            return None
        root = Path(selected[0]).resolve(strict=True)
        _, entries = _workspace_paths(root)
        files = _markdown_paths(entries)
        source = root / files[0] if files else None
        if self._source is not None and self._source.is_relative_to(root):
            source = self._source
        return self._open(root, source)

    def search_workspace(self, question: str) -> list[dict]:
        """在本地检索当前工作区，供用户查看拟提交给 AI 的摘录。"""
        root = self._root
        _, entries = _workspace_paths(root)
        query = question.strip()
        sources = search_workspace(root, _markdown_paths(entries), query)
        self._search = root, query, sources
        return sources

    def organize_workspace(self, question: str) -> dict:
        """使用最近一轮本地检索的快照生成带来源的整理稿。"""
        if self._search is None or self._search[:2] != (self._root, question.strip()):
            raise ValueError("请先检索并确认当前工作区的摘录。")
        _, query, sources = self._search
        return organize_workspace(self._ai_settings, query, sources)

    def save_note(self, anchor: dict, body: str) -> None:
        """将批注写入 SQLite，发现源版本已改变时要求先重新打开。"""
        source = self._current_source()
        current = sha256(source.read_bytes()).hexdigest()
        relative = source.relative_to(self._root).as_posix()
        if anchor["revision"] != current or anchor.get("path", relative) != relative:
            raise ValueError("源文件已更新，请重新读取后再选择文字。")
        if not body.strip() or not anchor["quote"].strip():
            raise ValueError("请输入批注并选中正文。")
        database = _notes_database(source.parent)
        database.parent.mkdir(exist_ok=True)
        with closing(sqlite3.connect(database)) as db:
            db.execute(SCHEMA)
            db.execute(
                INSERT_NOTE,
                (
                    source.name, current, anchor["block"], anchor["offset"],
                    anchor["quote"], anchor["prefix"], anchor["suffix"], body.strip(),
                ),
            )
            db.commit()

    def export_docx(self, revision: str, plan: dict | None, skip: bool) -> dict:
        """导出当前阅读版本，并从 SQLite 读取批注正文。"""
        source = self._current_source()
        notes = []
        if plan is not None:
            stored = {row["id"]: row for row in _stored_notes(source)}
            resolved = {target["id"]: target for target in plan["targets"]}
            if set(plan["note_ids"]) != stored.keys() or not resolved.keys() <= stored.keys():
                raise ValueError("批注已更新，请重新读取后导出。")
            unresolved = len(stored.keys() - resolved.keys())
            if unresolved and not skip:
                return {"status": "unresolved", "count": unresolved}
            for note_id, target in resolved.items():
                note = stored[note_id]
                notes.append(ReviewNote(target["block"], target["offset"], note["quote"], note["body"]))

        paths = self._export_paths or self._choose_export_paths(source)
        if paths is None:
            return {"status": "cancelled"}
        template, output = paths
        return convert(source, template, output, notes=tuple(notes), source_revision=revision)

    def export_share(self, revision: str) -> dict:
        """将当前 Markdown 与它自己的批注打包，供另一台机器解压阅读。"""
        from webview import FileDialog

        source = self._current_source()
        selected = self._window.create_file_dialog(
            FileDialog.SAVE,
            directory=str(source.parent),
            save_filename=f"{source.stem}-含批注.zip",
            file_types=("ZIP 压缩包 (*.zip)",),
        )
        if not selected:
            return {"status": "cancelled"}
        output = Path(selected[0])
        if output.suffix.lower() != ".zip":
            raise ValueError("分享包需要使用 .zip 扩展名。")

        data = source.read_bytes()
        if sha256(data).hexdigest() != revision:
            raise ValueError("源文件已更新，请重新读取后再打包。")
        filename = source.name
        notes = _stored_notes(source)
        if output.exists() or output.is_symlink():
            raise FileExistsError("已有同名分享包，请选择其他文件名。")

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
                raise FileExistsError("已有同名分享包，请选择其他文件名。") from error
        return {"status": "shared", "output": str(output)}

    def _choose_export_paths(self, source: Path) -> tuple[Path, Path] | None:
        from webview import FileDialog

        file_types = ("Word 文档 (*.docx)",)
        template = self._window.create_file_dialog(FileDialog.OPEN, file_types=file_types)
        if not template:
            return None
        output = self._window.create_file_dialog(
            FileDialog.SAVE,
            directory=str(source.parent),
            save_filename=source.with_suffix(".docx").name,
            file_types=file_types,
        )
        if not output:
            return None
        return Path(template[0]), Path(output[0])


def open_reader(root: Path, source: Path | None, verify=None, *, export_paths: tuple[Path, Path] | None = None) -> None:
    """在 Windows WebView2 中打开 Markdown 审阅窗口。"""
    import webview

    page = (ASSETS / "index.html").read_text(encoding="utf-8")
    for filename in ("reader.css", "reader.js"):
        content = (ASSETS / filename).read_text(encoding="utf-8")
        page = page.replace(f"/* {filename} */", content)
    api = Reader(root, source, export_paths)
    window = webview.create_window("DocumentCraft · Markdown 阅读器", html=page, js_api=api,
                                   width=READER_SIZE[0], height=READER_SIZE[1], min_size=READER_MIN_SIZE)
    api._window = window
    webview.start(verify, (window,) if verify else None, gui="edgechromium")


def main(argv: list[str] | None = None) -> None:
    """打开指定工作区内的 Markdown 文件。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, nargs="?")
    parser.add_argument("--workspace", type=Path)
    args = parser.parse_args(argv)
    if args.source is None and args.workspace is None:
        parser.error("请选择 Markdown 文件或工作区文件夹。")
    source = _markdown_file(args.source) if args.source else None
    root = args.workspace.resolve(strict=True) if args.workspace else _saved_workspace(source)
    if not root.is_dir():
        raise ValueError("工作区必须是文件夹。")
    if source is not None and not source.is_relative_to(root):
        parser.error("文件必须位于工作区内。")
    if source is None:
        _, entries = _workspace_paths(root)
        files = _markdown_paths(entries)
        if files:
            source = root / files[0]
    open_reader(root, source)


if __name__ == "__main__":
    main()
