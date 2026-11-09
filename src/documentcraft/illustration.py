"""分析报告全文，生成技术图并回插文档副本。"""

from dataclasses import dataclass
from contextlib import suppress
import json
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from uuid import uuid4

from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Cm
from docx.text.paragraph import Paragraph

from .ai import AISettings, analyze
from .converter import find_pandoc, open_docx, run_pandoc
from .diagrams import render_diagram
from .templates import ConversionError


@dataclass
class ReportBlock:
    """保存可提交给分析服务的文本及本地插入位置。"""

    text: str
    section: int
    chapter: int
    kind: str
    picture: bool = False
    anchor: Paragraph | int | None = None


def _contains_image(node: object) -> bool:
    if isinstance(node, dict):
        if node.get("t") == "Image":
            return True
        return _contains_image(node.get("c"))
    if isinstance(node, list):
        return any(_contains_image(child) for child in node)
    return False


def _markdown_blocks(source: Path, original: str) -> list[ReportBlock]:
    raw = run_pandoc(
        find_pandoc(), source.parent, "--from", "commonmark_x+sourcepos",
        "--to", "json", data=original.encode("utf-8"),
    )
    lines = original.splitlines(keepends=True)
    blocks = []
    section, chapter, cursor = 0, 0, 0
    for block in json.loads(raw)["blocks"]:
        kind = block["t"]
        data = block.get("c")
        attributes = data[1] if kind == "Header" else data[0] if kind == "Div" else None
        position = dict(attributes[2]).get("data-pos", "") if attributes else ""
        match = re.fullmatch(r"(\d+):\d+-(\d+):(\d+)", position)
        if match is None:
            continue
        start, stop, column = map(int, match.groups())
        end = stop - 1 if column == 1 else stop
        if cursor < start - 1:
            gap = "".join(lines[cursor:start - 1])
            if gap.strip():
                blocks.append(ReportBlock(gap, section, chapter, "context"))
        if kind == "Header":
            section += 1
            if data[0] == 1:
                chapter += 1
        text = "".join(lines[start - 1:end]).strip()
        picture = _contains_image(block) or bool(re.search(r"<(?:img|picture)\b", text, re.I))
        natural = kind == "Div" and len(data[1]) == 1 and data[1][0]["t"] == "Para"
        anchor = end if natural and not picture else None
        blocks.append(ReportBlock(text, section, chapter, kind, picture, anchor))
        cursor = max(cursor, end)
    remaining = "".join(lines[cursor:])
    if remaining.strip():
        blocks.append(ReportBlock(remaining, section, chapter, "context"))
    return blocks


def _word_blocks(document) -> list[ReportBlock]:
    body = document.element.body
    blocks = []
    section, chapter = 0, 0
    for element in body.iter(qn("w:p")):
        paragraph = Paragraph(element, document._body)
        style = paragraph.style.name
        heading = re.fullmatch(r"(?:Heading |标题\s*)([1-9])", style)
        if heading:
            section += 1
            if heading[1] == "1":
                chapter += 1
        picture = bool(element.xpath(".//w:drawing | .//w:pict | .//w:object"))
        text = "".join(element.xpath(".//w:t/text()"))
        if not text.strip() and not picture:
            continue
        kind = "heading" if heading else style
        insertable = element.getparent() is body and not heading and not picture
        insertable = insertable and style not in {"Caption", "图名", "表名", "Title", "题目"}
        anchor = paragraph if insertable else None
        blocks.append(ReportBlock(text, section, chapter, kind, picture, anchor))
    return blocks


def _legacy_docx(source: Path, destination: Path) -> None:
    """在独立 WPS 会话内将旧版 DOC 另存为临时 DOCX。"""
    if os.name != "nt":
        raise ConversionError("旧版 DOC 需要 Windows 上的 WPS Writer。")
    import pythoncom
    from win32com.client import DispatchEx

    pythoncom.CoInitialize()
    app = None
    document = None
    try:
        app = DispatchEx("KWPS.Application")
        app.DisplayAlerts = 0
        app.AutomationSecurity = 3
        document = app.Documents.Open(str(source), False, True, False)
        baseline = (document.Content.Text, document.Tables.Count, document.InlineShapes.Count, document.Shapes.Count)
        document.SaveAs(str(destination), 12)
        document.Close(0)
        document = app.Documents.Open(str(destination), False, True, False)
        converted = (document.Content.Text, document.Tables.Count, document.InlineShapes.Count, document.Shapes.Count)
        if converted != baseline:
            raise ConversionError("WPS 另存 DOCX 后正文、表格或图形数量发生变化。")
    except pythoncom.com_error as error:
        raise ConversionError("WPS 无法安全转换旧版 DOC。请先用 WPS 另存为 DOCX。") from error
    finally:
        try:
            if document is not None:
                with suppress(pythoncom.com_error):
                    document.Close(0)
        finally:
            try:
                if app is not None:
                    with suppress(pythoncom.com_error):
                        app.Quit(0)
            finally:
                pythoncom.CoUninitialize()


def _validate(diagram: dict, blocks: list[ReportBlock]) -> str:
    """核对插入锚点、原文证据和技术图约束。"""
    start, end = diagram["start"], diagram["end"]
    if type(start) is not int or type(end) is not int or not 1 <= start <= end <= len(blocks):
        return "技术单元定位无效"
    unit = blocks[start - 1:end]
    if unit[-1].anchor is None or unit[0].section != unit[-1].section:
        return "无法确定同一小节内的插入段落"
    following = blocks[end:end + 1]
    if any(block.picture for block in unit + following):
        return "技术单元或紧邻位置已有图片，需确认覆盖范围"
    if type(diagram["overview"]) is not bool or diagram["type"] not in {"route", "flow", "structure"}:
        return "图示类型无效"
    if diagram["overview"] and (unit[-1].chapter not in {1, 2} or diagram["type"] != "route"):
        return "总览图须来自第一或第二章的技术路线"
    title = diagram["title"]
    if not title.strip() or re.search(r"[\r\n]", title) or re.match(r"^图\s*[0-9０-９]", title.strip()):
        return "图名为空、包含换行或带图号"
    nodes, edges = diagram["nodes"], diagram["edges"]
    if len(nodes) < 2 or not edges:
        return "技术关系不足"
    evidence_text = "\n".join(block.text for block in unit)
    for item in nodes + edges:
        evidence = item["evidence"].strip()
        if not evidence or evidence not in evidence_text:
            return "节点或连线缺少可核对的逐字原文依据"
    for node in nodes:
        label = node["label"]
        if not label.strip() or len(label) > 14 or any(ord(char) < 32 for char in label):
            return "节点标签为空、含控制字符或超过 14 个字符"
        if not isinstance(node["group"], str):
            return "功能分区无效"
    participants = set()
    pairs = set()
    for edge in edges:
        pair = (edge["from"], edge["to"])
        if any(type(index) is not int or not 0 <= index < len(nodes) for index in pair):
            return "连线指向不存在的节点"
        if pair[0] == pair[1] or pair in pairs:
            return "包含重复连线或自连接"
        pairs.add(pair)
        participants.update(pair)
    if len(participants) != len(nodes):
        return "包含没有明确关系的孤立节点"
    return ""


def _markdown_text(value: str) -> str:
    return re.sub(r"([\\`*_{}\[\]()#+.!|<>~-])", r"\\\1", value)


def _insert_word(document, anchor: Paragraph, image: Path, title: str) -> None:
    figure = document.add_paragraph()
    figure.alignment = WD_ALIGN_PARAGRAPH.CENTER
    figure.paragraph_format.keep_with_next = True
    figure.add_run().add_picture(str(image), width=Cm(14))
    anchor._p.addnext(figure._p)
    caption = document.add_paragraph(title)
    caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
    figure._p.addnext(caption._p)


def illustrate(source: Path, settings: AISettings, *, colored: bool) -> dict:
    """生成图片、配图版报告和人工复核清单，保留输入文件。"""
    source = source.resolve(strict=True)
    extension = source.suffix.lower()
    markdown = extension in {".md", ".markdown"}
    if not markdown and extension not in {".docx", ".doc"}:
        raise ConversionError("请选择 Markdown、DOCX 或 DOC 文件。")
    job = f"illustrations-{uuid4().hex[:12]}"
    output_extension = source.suffix if markdown else ".docx"
    output = source.with_name(f"{source.stem}-配图-{job[-8:]}{output_extension}")
    assets = source.parent / job
    with TemporaryDirectory(prefix=".documentcraft-", dir=source.parent) as folder:
        work = Path(folder)
        if markdown:
            raw = source.read_bytes()
            original = raw.decode("utf-8-sig")
            blocks = _markdown_blocks(source, original)
        else:
            docx = source
            if extension == ".doc":
                docx = work / "source.docx"
                _legacy_docx(source, docx)
            document = open_docx(docx)
            blocks = _word_blocks(document)
        if not blocks:
            raise ConversionError("报告没有可分析的正文。")
        payload = [
            {"id": index, "text": block.text, "section": block.section, "chapter": block.chapter,
             "kind": block.kind, "existing_image": block.picture, "insertable": block.anchor is not None}
            for index, block in enumerate(blocks, 1)
        ]
        plan = analyze(settings, payload)
        staged_assets = work / job
        staged_assets.mkdir()
        issues = []
        for item in plan["issues"]:
            if isinstance(item, dict) and isinstance(item.get("reason"), str):
                issues.append((str(item.get("id", "—")), item["reason"]))
        edits = []
        used_ranges = []
        overview = False
        fingerprints = set()
        for index, diagram in enumerate(plan["diagrams"], 1):
            try:
                problem = _validate(diagram, blocks)
                if problem:
                    raise ConversionError(problem)
                start, end = diagram["start"], diagram["end"]
                if any(start <= old_end and old_start <= end for old_start, old_end in used_ranges):
                    raise ConversionError("技术单元与已生成图示重叠")
                if overview and diagram["overview"]:
                    raise ConversionError("全文已生成一张总览图")
                fingerprint = frozenset(
                    (diagram["nodes"][edge["from"]]["label"], diagram["nodes"][edge["to"]]["label"])
                    for edge in diagram["edges"]
                )
                if fingerprint in fingerprints:
                    raise ConversionError("节点关系与已有新图重复")
                image = staged_assets / f"figure-{index}.png"
                render_diagram(diagram, image, colored)
            except (ConversionError, OSError, TypeError, ValueError, KeyError, AttributeError) as error:
                issues.append((f"候选图 {index}", str(error)))
                continue
            edits.append((blocks[end - 1].anchor, image, diagram["title"].strip()))
            used_ranges.append((start, end))
            fingerprints.add(fingerprint)
            overview = overview or diagram["overview"]

        staged_output = work / output.name
        if markdown:
            lines = original.splitlines(keepends=True)
            newline = "\r\n" if "\r\n" in original else "\n"
            for anchor, image, title in sorted(edits, reverse=True):
                prefix = newline if not lines[anchor - 1].endswith(("\n", "\r")) else ""
                caption = _markdown_text(title)
                snippet = f"{prefix}{newline}![]({job}/{image.name}){newline}{newline}{caption}{newline}{newline}"
                lines.insert(anchor, snippet)
            encoding = "utf-8-sig" if raw.startswith(b"\xef\xbb\xbf") else "utf-8"
            staged_output.write_bytes("".join(lines).encode(encoding))
        else:
            for anchor, image, title in edits:
                _insert_word(document, anchor, image, title)
            document.save(staged_output)
            open_docx(staged_output)
        review = staged_assets / "审核清单.md"
        rows = ["# 配图审核清单", "", "| 位置 | 待确认问题 |", "| --- | --- |"]
        for location, reason in issues or [("—", "无待确认问题")]:
            clean_reason = _markdown_text(" ".join(reason.splitlines()))
            clean_location = _markdown_text(" ".join(location.splitlines()))
            rows.append(f"| {clean_location} | {clean_reason} |")
        review.write_text("\n".join(rows) + "\n", encoding="utf-8")
        # 输出先在同一磁盘完成写入，再发布；发生冲突时回收本次新资源目录。
        if output.exists() or assets.exists():
            raise ConversionError("输出路径已存在，请重新运行。")
        staged_assets.rename(assets)
        try:
            staged_output.rename(output)
        except OSError:
            assets.rename(staged_assets)
            raise
    return {"output": str(output), "review": str(assets / review.name), "images": len(edits), "issues": len(issues)}
