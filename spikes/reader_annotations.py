"""用 WebView2 验证 Markdown 选区、高亮和独立批注存储。"""

import argparse
import json
import sqlite3
from contextlib import closing
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile

from lxml import html

from documentcraft.converter import MARKDOWN_FORMAT, convert, find_pandoc, run_pandoc
from documentcraft.review_notes import ReviewNote, paragraph_text

ASSETS = Path(__file__).with_name("reader_ui")
ALLOWED_TAGS = set("p h1 h2 h3 h4 h5 h6 strong em s u sup sub code pre blockquote ul ol li table thead tbody tr td th div span a hr br".split())
NOTES_FILE = Path(".documentcraft") / "reader-spike.sqlite3"
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


def render_markdown(data: bytes, directory: Path) -> str:
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
    for element in list(root.iterdescendants()):
        if element.tag not in ALLOWED_TAGS:
            element.drop_tree()
            continue
        # 批注页面带本地存储桥。预览只接收允许的标签，移除导航和事件属性。
        element.attrib.clear()
    for paragraph, index in supported:
        paragraph.set("data-review-block", str(index))
    return html.tostring(root, encoding="unicode")


class Reader:
    """为一个 Markdown 文件提供只读预览和工作区批注。"""

    def __init__(self, root: Path, source: Path, export_paths: tuple[Path, Path] | None = None) -> None:
        self._source = source
        self._window = None
        self._export_paths = export_paths
        self._path = source.relative_to(root).as_posix()
        self._database = root / NOTES_FILE

    def load(self) -> dict:
        """载入一个版本的正文和已保存批注。"""
        data = self._source.read_bytes()
        return {
            "path": self._path,
            "revision": sha256(data).hexdigest(),
            "html": render_markdown(data, self._source.parent),
            "notes": self._notes(),
        }

    def _notes(self) -> list[dict]:
        notes = []
        if self._database.is_file():
            with closing(sqlite3.connect(self._database)) as db:
                db.row_factory = sqlite3.Row
                rows = db.execute("SELECT * FROM notes WHERE path = ? ORDER BY id", (self._path,))
                notes = [dict(row) for row in rows]
        return notes

    def save_note(self, anchor: dict, body: str) -> None:
        """将批注写入 SQLite，发现源版本已改变时要求先重新打开。"""
        current = sha256(self._source.read_bytes()).hexdigest()
        if anchor["revision"] != current:
            raise ValueError("源文件已更新，请重新读取后再选择文字。")
        if not body.strip() or not anchor["quote"].strip():
            raise ValueError("请输入批注并选中正文。")
        self._database.parent.mkdir(exist_ok=True)
        with closing(sqlite3.connect(self._database)) as db:
            db.execute(SCHEMA)
            db.execute(
                INSERT_NOTE,
                (
                    self._path, current, anchor["block"], anchor["offset"],
                    anchor["quote"], anchor["prefix"], anchor["suffix"], body.strip(),
                ),
            )
            db.commit()

    def export_docx(self, revision: str, plan: dict | None, skip: bool) -> dict:
        """导出当前阅读版本，并从 SQLite 读取批注正文。"""
        notes = []
        if plan is not None:
            stored = {row["id"]: row for row in self._notes()}
            resolved = {target["id"]: target for target in plan["targets"]}
            if set(plan["note_ids"]) != stored.keys() or not resolved.keys() <= stored.keys():
                raise ValueError("批注已更新，请重新读取后导出。")
            unresolved = len(stored.keys() - resolved.keys())
            if unresolved and not skip:
                return {"status": "unresolved", "count": unresolved}
            for note_id, target in resolved.items():
                note = stored[note_id]
                notes.append(ReviewNote(target["block"], target["offset"], note["quote"], note["body"]))

        paths = self._export_paths or self._choose_export_paths()
        if paths is None:
            return {"status": "cancelled"}
        template, output = paths
        return convert(self._source, template, output, notes=tuple(notes), source_revision=revision)

    def export_share(self, revision: str) -> dict:
        """将当前 Markdown 与它自己的批注打包，供另一台机器解压阅读。"""
        from webview import FileDialog

        selected = self._window.create_file_dialog(
            FileDialog.SAVE,
            directory=str(self._source.parent),
            save_filename=f"{self._source.stem}-含批注.zip",
            file_types=("ZIP 压缩包 (*.zip)",),
        )
        if not selected:
            return {"status": "cancelled"}
        output = Path(selected[0])
        if output.suffix.lower() != ".zip":
            raise ValueError("分享包需要使用 .zip 扩展名。")

        data = self._source.read_bytes()
        if sha256(data).hexdigest() != revision:
            raise ValueError("源文件已更新，请重新读取后再打包。")
        filename = self._source.name
        notes = self._notes()
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

    def _choose_export_paths(self) -> tuple[Path, Path] | None:
        from webview import FileDialog

        file_types = ("Word 文档 (*.docx)",)
        template = self._window.create_file_dialog(FileDialog.OPEN, file_types=file_types)
        if not template:
            return None
        output = self._window.create_file_dialog(
            FileDialog.SAVE,
            directory=str(self._source.parent),
            save_filename=self._source.with_suffix(".docx").name,
            file_types=file_types,
        )
        if not output:
            return None
        return Path(template[0]), Path(output[0])


def open_reader(root: Path, source: Path, verify=None, *, export_paths: tuple[Path, Path] | None = None) -> None:
    """在 Windows WebView2 中打开 Markdown 阅读原型。"""
    import webview

    page = (ASSETS / "index.html").read_text(encoding="utf-8")
    for filename in ("reader.css", "reader.js"):
        content = (ASSETS / filename).read_text(encoding="utf-8")
        page = page.replace(f"/* {filename} */", content)
    api = Reader(root, source, export_paths)
    window = webview.create_window("DocumentCraft · 批注试读", html=page, js_api=api)
    api._window = window
    webview.start(verify, (window,) if verify else None, gui="edgechromium")


def main() -> None:
    """打开指定工作区内的 Markdown 文件。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--workspace", type=Path)
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    root = args.workspace.resolve(strict=True) if args.workspace else source.parent
    if source.suffix.lower() not in {".md", ".markdown"} or not source.is_file():
        parser.error("请选择 Markdown 文件。")
    if not source.is_relative_to(root):
        parser.error("文件必须位于工作区内。")
    open_reader(root, source)


if __name__ == "__main__":
    main()

