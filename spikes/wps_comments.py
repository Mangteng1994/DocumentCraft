"""验证 Markdown 选区经过模板转换后能否成为 WPS 审阅批注。"""

import argparse
import json
import shutil
from hashlib import sha256
from pathlib import Path
from tempfile import mkdtemp
from zipfile import ZipFile

from docx import Document
from docx.document import Document as DocxDocument
from docx.oxml.ns import qn
from docx.text.run import Run
from lxml import etree

from documentcraft.converter import MARKDOWN_FORMAT, find_pandoc, run_pandoc
from documentcraft.templates import (
    PLACEHOLDER,
    apply_template_styles,
    insert_content,
    select_anchor,
)

MARKDOWN = """# 流量试验

对照组。结果为 **20 L/s**，符合要求。

试验组。结果为 **20 L/s**，符合要求。
"""
SELECTION = "结果为 20 L/s，符合要求。"
TARGET_PREFIX = "试验组。"
BOOKMARK = "DCSpikeSelection"
COMMENT = "请补充试验组的测量依据。"
EDITED_COMMENT = "已在 WPS 更新：请补充仪器型号。"
TEMPLATE_TEXT = "模板保留段。"
TEMPLATE_COMMENT = "模板原有批注。"
WORD_NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def mark_selection(ast: bytes) -> bytes:
    """为样例的第二处选区添加临时书签，保留选区内的粗体。"""
    document = json.loads(ast)
    matches = []
    for block in document["blocks"]:
        if block["t"] != "Para":
            continue
        first, *rest = block["c"]
        if first["t"] == "Str" and first["c"].startswith(TARGET_PREFIX):
            matches.append((block, first["c"], rest))

    assert len(matches) == 1, "试验组选区必须唯一"
    block, first_text, rest = matches[0]
    selected_start = {"t": "Str", "c": first_text[len(TARGET_PREFIX):]}
    selected_inlines = [selected_start, *rest]
    span = {"t": "Span", "c": [[BOOKMARK, [], []], selected_inlines]}
    block["c"] = [{"t": "Str", "c": TARGET_PREFIX}, span]
    return json.dumps(document, ensure_ascii=False).encode("utf-8")


def add_comment_at_bookmark(document: DocxDocument) -> None:
    """从临时书签取得准确的 Word 文本范围，再写入正式批注。"""
    body = document.element.body
    # Pandoc 3.10 使用原名，较新的版本会为书签名添加下划线。
    starts = body.xpath(f'.//w:bookmarkStart[@w:name="{BOOKMARK}" or @w:name="_{BOOKMARK}"]')
    assert len(starts) == 1, "转换后应有一个临时选区书签"
    start = starts[0]
    bookmark_id = start.get(qn("w:id"))
    ends = body.xpath(f'.//w:bookmarkEnd[@w:id="{bookmark_id}"]')
    assert len(ends) == 1, "临时书签必须有唯一结束位置"
    end = ends[0]
    paragraph = start.getparent()
    assert end.getparent() is paragraph, "Spike 只覆盖同段落文字"
    children = list(paragraph)
    selected_elements = children[children.index(start) + 1:children.index(end)]
    runs = [Run(element, document) for element in selected_elements if element.tag == qn("w:r")]
    assert "".join(run.text for run in runs) == SELECTION, "书签应准确框住选中文字"
    assert any(run.bold and run.text == "20 L/s" for run in runs), "选区内应保留粗体"
    document.add_comment(runs=runs, text=COMMENT, author="DocumentCraft")
    paragraph.remove(start)
    paragraph.remove(end)


def export_sample(source: Path, output: Path, mode: str) -> None:
    """沿用现有 Pandoc 和模板合并步骤，生成带批注的样例。"""
    template_path = output.parent / f"{mode}-template.docx"
    template = Document()
    if mode == "full":
        paragraph = template.add_paragraph(TEMPLATE_TEXT)
        template.add_comment(paragraph.runs, text=TEMPLATE_COMMENT, author="模板审阅人")
        template.add_paragraph(PLACEHOLDER)
    template.save(template_path)

    pandoc = find_pandoc()
    ast = run_pandoc(pandoc, source.parent, "--from", MARKDOWN_FORMAT, "--to", "json", str(source))
    marked_ast = mark_selection(ast)
    raw_path = output.parent / f"{mode}-pandoc.docx"
    run_pandoc(
        pandoc,
        source.parent,
        "--from", "json",
        "--to", "docx",
        "--reference-doc", str(template_path),
        "--output", str(raw_path),
        data=marked_ast,
    )
    generated = Document(raw_path)
    apply_template_styles(template, generated)
    anchor = select_anchor(template, mode)
    final = generated
    if anchor is not None:
        insert_content(template, generated, anchor)
        final = template
    add_comment_at_bookmark(final)
    final.save(output)


def verify_package(path: Path, text: str, mode: str) -> None:
    """直接核对批注 XML，避免其他 DOCX 部件影响选区检查。"""
    with ZipFile(path) as package:
        body = etree.fromstring(package.read("word/document.xml"))
        comments = etree.fromstring(package.read("word/comments.xml"))

    expected = {text: (TARGET_PREFIX + SELECTION, SELECTION, "DocumentCraft")}
    if mode == "full":
        expected[TEMPLATE_COMMENT] = (TEMPLATE_TEXT, TEMPLATE_TEXT, "模板审阅人")

    for comment in comments.findall(qn("w:comment")):
        comment_text = "".join(comment.xpath(".//w:t/text()", namespaces=WORD_NS))
        expected_paragraph, expected_range, expected_author = expected.pop(comment_text)
        assert comment.get(qn("w:author")) == expected_author
        comment_id = comment.get(qn("w:id"))
        start, = body.xpath(f'.//w:commentRangeStart[@w:id="{comment_id}"]', namespaces=WORD_NS)
        end, = body.xpath(f'.//w:commentRangeEnd[@w:id="{comment_id}"]', namespaces=WORD_NS)
        reference, = body.xpath(f'.//w:commentReference[@w:id="{comment_id}"]', namespaces=WORD_NS)
        paragraph = start.getparent()
        assert end.getparent() is paragraph
        assert reference.getparent().getparent() is paragraph
        assert "".join(paragraph.xpath(".//w:t/text()", namespaces=WORD_NS)) == expected_paragraph
        children = list(paragraph)
        selected = children[children.index(start) + 1:children.index(end)]
        selected_text = []
        for item in selected:
            selected_text.extend(item.xpath(".//w:t/text()", namespaces=WORD_NS))
        assert "".join(selected_text) == expected_range
    assert not expected, f"缺少批注：{list(expected)}"


def round_trip_wps(path: Path, mode: str) -> None:
    """在 WPS 里编辑副本，保存并重新打开核对原生批注。"""
    from win32com.client import DispatchEx

    app = DispatchEx("KWPS.Application")
    document = app.Documents.Open(str(path))
    try:
        count = 2 if mode == "full" else 1
        assert document.Comments.Count == count
        for index in range(1, count + 1):
            comment = document.Comments.Item(index)
            if comment.Range.Text.strip() == COMMENT:
                assert comment.Scope.Text == SELECTION
                comment.Range.Text = EDITED_COMMENT
                break
        else:
            raise AssertionError("WPS 审阅集合里未找到导出的批注")
        document.Save()
    finally:
        document.Close(False)

    document = app.Documents.Open(str(path), ReadOnly=True)
    try:
        assert document.Comments.Count == count
        texts = [document.Comments.Item(i).Range.Text.strip() for i in range(1, count + 1)]
        assert EDITED_COMMENT in texts
    finally:
        document.Close(False)
    verify_package(path, EDITED_COMMENT, mode)


def main() -> None:
    """生成隔离样例并按需执行 WPS 往返验证。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wps", action="store_true", help="在本机 WPS 中编辑并重新打开导出副本")
    args = parser.parse_args()
    base = Path("dist").resolve()
    base.mkdir(exist_ok=True)
    workspace = Path(mkdtemp(prefix="wps-comments-", dir=base))
    source = workspace / "流量试验.md"
    source.write_text(MARKDOWN, encoding="utf-8")
    initial_hash = sha256(source.read_bytes()).hexdigest()
    print(f"样例目录：{workspace}", flush=True)

    for mode in ("style", "full"):
        output = workspace / f"{mode}-review.docx"
        export_sample(source, output, mode)
        verify_package(output, COMMENT, mode)
        print(f"{mode}：批注内容、选区和模板批注检查通过", flush=True)
        if args.wps:
            round_trip = workspace / f"{mode}-wps-resaved.docx"
            shutil.copyfile(output, round_trip)
            round_trip_wps(round_trip, mode)
            print(f"{mode}：WPS 原生批注可编辑，保存重开后内容及选区检查通过", flush=True)

    assert sha256(source.read_bytes()).hexdigest() == initial_hash
    print(f"Markdown SHA-256 一致：{initial_hash}", flush=True)


if __name__ == "__main__":
    main()
