"""分析报告全文，生成技术图并回插文档副本。"""

from dataclasses import dataclass
from contextlib import suppress
from hashlib import sha256
import json
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from uuid import uuid4

from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.document import Document
from docx.oxml.ns import qn
from docx.section import Section
from docx.shared import Cm, Pt
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
    kind: str
    picture: bool = False
    anchor: Paragraph | int | None = None
    heading_level: int | None = None


FIGURE_CAPTION = re.compile(r"^(?:图\s*|Figure\s+)\d+(?:[.．－—–-]\d+)*", re.IGNORECASE)
CAPTION_PROSE = re.compile(r"^(?:所示|可见|显示|说明|展示|给出|表示|中[的可])|[。！？；]\s*$")
TABLE_CAPTION = re.compile(r"^(?:表\s*\d|Table\s+\d)", re.IGNORECASE)
FIGURE_REFERENCE = re.compile(
    r"如(?:下)?图|见(?:上|下)?图|下图|图\s*[0-9０-９]|"
    r"[“「][^”」\n]+[”」]\s*图|"
    r"(?:见|参照|结合|详见|对应|参见)[^。！？；\n]{0,30}(?:路线图|流程图|示意图|机制图|框架图|关系图)|"
    r"(?:路线图|流程图|示意图|机制图|框架图|关系图)(?:如下|所示)"
)
FIGURE_TARGET = re.compile(r"图\s*[0-9０-９]+(?:[.．－—–-][0-9０-９]+)*|[“「][^”」\n]+[”」]\s*图")
FIGURE_STYLES = {"Caption", "Image Caption", "图名"}


def _figure_cues(blocks: list[ReportBlock]) -> dict[int, str]:
    """从原文记录图名与引用的线索。实图位置独立记录。"""
    cues = {}
    for index, block in enumerate(blocks, 1):
        if block.picture or block.heading_level:
            continue
        text = block.text.strip()
        if block.kind == "表名" or (block.kind == "Caption" and TABLE_CAPTION.match(text)):
            continue
        label = FIGURE_CAPTION.match(text)
        if block.kind in FIGURE_STYLES or (label and not CAPTION_PROSE.search(text[label.end():].lstrip())):
            cues[index] = "caption"
        elif FIGURE_REFERENCE.search(text) or label:
            cues[index] = "reference"
    return cues


def _contains_image(node: object) -> bool:
    if isinstance(node, dict):
        kind = node.get("t")
        data = node.get("c")
        if kind == "Image":
            return True
        if kind in {"RawBlock", "RawInline"} and data[0] == "html":
            markup = re.sub(r"<!--.*?-->", "", data[1], flags=re.S)
            return bool(re.search(r"<img\b", markup, re.I))
        return _contains_image(data)
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
    section, cursor = 0, 0
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
                blocks.append(ReportBlock(gap, section, "context"))
        if kind == "Header":
            section += 1
        text = "".join(lines[start - 1:end]).strip()
        picture = _contains_image(block)
        natural = kind == "Div" and len(data[1]) == 1 and data[1][0]["t"] == "Para"
        anchor = end if natural and not picture else None
        heading_level = data[0] if kind == "Header" else None
        blocks.append(ReportBlock(text, section, kind, picture, anchor, heading_level))
        cursor = max(cursor, end)
    remaining = "".join(lines[cursor:])
    if remaining.strip():
        blocks.append(ReportBlock(remaining, section, "context"))
    return blocks


def _word_heading_level(paragraph: Paragraph) -> int | None:
    """识别内置标题和用 Word 大纲级别定义的自定义标题。"""
    direct = paragraph._p.xpath("./w:pPr/w:outlineLvl/@w:val")
    if direct:
        return int(direct[0]) + 1 if re.fullmatch(r"[0-8]", direct[0]) else None
    style = paragraph.style
    seen = set()
    while style is not None and style.style_id not in seen:
        levels = style.element.xpath("./w:pPr/w:outlineLvl/@w:val")
        if levels:
            return int(levels[0]) + 1 if re.fullmatch(r"[0-8]", levels[0]) else None
        heading = re.fullmatch(r"(?:Heading\s+|标题\s*)([1-9])", style.name, re.IGNORECASE)
        if heading:
            return int(heading[1])
        seen.add(style.style_id)
        style = style.base_style
    return None


def _word_blocks(document) -> list[ReportBlock]:
    body = document.element.body
    blocks = []
    section = 0
    for element in body.iter(qn("w:p")):
        paragraph = Paragraph(element, document._body)
        style = paragraph.style.name
        level = _word_heading_level(paragraph)
        if level:
            section += 1
        picture = bool(element.xpath(".//w:drawing | .//w:pict"))
        text = "".join(element.xpath(".//w:t/text()"))
        if not text.strip() and not picture:
            continue
        kind = "heading" if level else style
        insertable = element.getparent() is body and not level and not picture
        insertable = insertable and style not in FIGURE_STYLES | {"表名", "Title", "题目"}
        anchor = paragraph if insertable else None
        blocks.append(ReportBlock(text, section, kind, picture, anchor, level))
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


def _block_id(value: object, blocks: list[ReportBlock]) -> bool:
    return type(value) is int and 1 <= value <= len(blocks)


def _report_outline(blocks: list[ReportBlock]) -> list[dict]:
    """用实际标题层级建立节树，每节范围只包含自己的正文。"""
    outline = []
    parents = []
    for index, block in enumerate(blocks, 1):
        level = block.heading_level
        if level is not None:
            while parents and parents[-1]["level"] >= level:
                parents.pop()
            entry = {
                "id": block.section, "level": level, "parent": parents[-1]["id"] if parents else None,
                "title": block.text, "start": index, "end": index, "has_content": False,
            }
            outline.append(entry)
            parents.append(entry)
            continue
        if not outline:
            outline.append({
                "id": block.section, "level": None, "parent": None,
                "title": "无标题正文", "start": index, "end": index, "has_content": False,
            })
        outline[-1]["end"] = index
        if block.text.strip() or block.picture:
            outline[-1]["has_content"] = True
    return outline


def _is_insertable(block: ReportBlock, cue: str | None) -> bool:
    return block.anchor is not None and cue != "caption"


def _allows_multiple_targets(block: ReportBlock, cue: str | None) -> bool:
    if cue != "reference":
        return False
    targets = {re.sub(r"\s+", "", match.group()) for match in FIGURE_TARGET.finditer(block.text)}
    return len(targets) > 1


def _plan_payload(blocks: list[ReportBlock], cues: dict[int, str], outline: list[dict]) -> dict:
    """输出标题树、实图清单、可跨节取证的正文和引用线索。"""
    return {
        "top_level": min((entry["level"] for entry in outline if entry["level"] is not None), default=None),
        "outline": outline,
        "existing_images": [index for index, block in enumerate(blocks, 1) if block.picture],
        "blocks": [
            {"id": index, "text": block.text, "section": block.section, "kind": block.kind,
             "insertable": _is_insertable(block, cues.get(index)), "figure_cue": cues.get(index),
             "multiple_targets": _allows_multiple_targets(block, cues.get(index))}
            for index, block in enumerate(blocks, 1)
        ],
    }


def _validate_placement(diagram: dict, blocks: list[ReportBlock], cues: dict[int, str]) -> str:
    """核对插入锚点、图位引用和取证范围。"""
    anchor = diagram["anchor"]
    if not _block_id(anchor, blocks) or not _is_insertable(blocks[anchor - 1], cues.get(anchor)):
        return "插入位置不是可用的正文段落"
    next_index = anchor + 1 if cues.get(anchor + 1) == "caption" else anchor
    if any(block.picture for block in blocks[anchor:next_index + 1]):
        return "紧邻插入位置已有实图"
    references = diagram["references"]
    placement = diagram["placement"]
    if placement not in {"missing", "new"} or bool(references) != (placement == "missing"):
        return "图位分类与引用不一致"
    if not isinstance(references, list) or any(not _block_id(ref, blocks) or ref not in cues for ref in references):
        return "图位引用无法与原文图题或引用对应"
    evidence_ranges = diagram["evidence_ranges"]
    if not isinstance(evidence_ranges, list) or not evidence_ranges:
        return "缺少取证范围"
    for region in evidence_ranges:
        start, end = region["start"], region["end"]
        if not _block_id(start, blocks) or not _block_id(end, blocks) or start > end:
            return "取证范围无效"
    if type(diagram["overview"]) is not bool or diagram["type"] not in {"route", "flow", "structure"}:
        return "图示类型无效"
    title = diagram["title"]
    if not title.strip() or re.search(r"[\r\n]", title) or re.match(r"^图\s*[0-9０-９]", title.strip()):
        return "图名为空、包含换行或带图号"
    return ""


def _validate(diagram: dict, blocks: list[ReportBlock], cues: dict[int, str]) -> str:
    """核对旧版 CLI 的节点与连线。"""
    problem = _validate_placement(diagram, blocks, cues)
    if problem:
        return problem
    anchor = diagram["anchor"]
    evidence_ranges = diagram["evidence_ranges"]
    evidence_sections = [
        "\n".join(block.text for block in blocks[region["start"] - 1:region["end"]])
        for region in evidence_ranges
    ]
    nodes, edges = diagram["nodes"], diagram["edges"]
    if len(nodes) < 2 or not edges:
        return "技术关系不足"
    anchor_text = blocks[anchor - 1].text
    for item in nodes + edges:
        evidence = item["evidence"].strip()
        if not evidence:
            return "节点或连线缺少取证范围内的逐字原文依据"
        if any(evidence in section for section in evidence_sections):
            continue
        if evidence not in anchor_text:
            return "节点或连线缺少取证范围内的逐字原文依据"
        # 模型有时遗漏正在引用的锚点。只补入确有逐字证据的这一段。
        evidence_ranges.append({"start": anchor, "end": anchor})
        evidence_sections.append(anchor_text)
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


def _insert_word(
    document: Document, anchor: Paragraph, image: Path, title: str | None, width: float | None = None,
) -> None:
    figure = document.add_paragraph()
    figure.alignment = WD_ALIGN_PARAGRAPH.CENTER
    figure.paragraph_format.keep_with_next = True
    figure.add_run().add_picture(str(image), width=Pt(width) if width is not None else Cm(14))
    anchor._p.addnext(figure._p)
    if title is None:
        return
    caption = document.add_paragraph(title)
    caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
    figure._p.addnext(caption._p)


OMISSION_LABELS = {
    "merged": "并入其他图",
    "insufficient_evidence": "原文依据不足",
    "not_useful": "无需单独出图",
    "uncertain": "待确认",
}


def _review_sections(
    plan: dict, blocks: list[ReportBlock], outline: list[dict], generated: dict[int, str],
) -> tuple[list[tuple], list[tuple]]:
    """列出模型说明的遗漏，并显式标出未收到说明的节。"""
    sections = {entry["id"]: entry for entry in outline}
    diagram_sections = {blocks[anchor - 1].section for anchor in generated}
    image_sections = {block.section for block in blocks if block.picture}
    reviewed = set()
    seen_topics = set()
    rows = []
    pending = []
    for item in plan.get("omissions", []):
        if not isinstance(item, dict):
            continue
        section = item.get("section")
        status = item.get("status")
        topic = item.get("topic")
        reason = item.get("reason")
        anchor = item.get("diagram_anchor")
        if type(section) is not int or section not in sections:
            continue
        if not isinstance(status, str) or status not in OMISSION_LABELS:
            continue
        if not isinstance(topic, str) or not topic.strip() or not isinstance(reason, str) or not reason.strip():
            continue
        key = (section, topic.strip())
        if key in seen_topics:
            continue
        seen_topics.add(key)
        reviewed.add(section)
        section_label = f"节 {section} · {sections[section]['title']}"
        disposition = OMISSION_LABELS[status]
        if status == "merged":
            if type(anchor) is int and anchor in generated:
                disposition += f"（段落 {anchor}：{generated[anchor]}）"
            else:
                disposition = "待确认"
                reason = f"计划并入的图未成功生成。{reason}"
                pending.append((f"节 {section} · {topic}", reason))
        elif status == "uncertain":
            pending.append((f"节 {section} · {topic}", reason))
        rows.append((section_label, topic, disposition, reason))

    for entry in outline:
        section = entry["id"]
        if not entry["has_content"] or section in diagram_sections | image_sections | reviewed:
            continue
        section_label = f"节 {section} · {entry['title']}"
        reason = "本节未单独出图，分析计划也未说明原因。"
        rows.append((section_label, "—", "未说明", reason))
        pending.append((section_label, reason))
    return rows, pending


def _append_review_rows(rows: list[str], entries: list[tuple]) -> None:
    """将正文和模型输出作为表格文字写入 Markdown。"""
    for entry in entries:
        fields = [_markdown_text(" ".join(str(value).splitlines())) for value in entry]
        rows.append("| " + " | ".join(fields) + " |")


def _read_report(source: Path, work: Path) -> tuple[bytes, str, Document | None, list[ReportBlock]]:
    """读取原始报告以及仅在本地使用的插入锚点。"""
    extension = source.suffix.lower()
    if extension in {".md", ".markdown"}:
        raw = source.read_bytes()
        original = raw.decode("utf-8-sig")
        return raw, original, None, _markdown_blocks(source, original)
    if extension not in {".doc", ".docx"}:
        raise ConversionError("请选择 Markdown、DOCX 或 DOC 文件。")
    docx = source
    if extension == ".doc":
        docx = work / "source.docx"
        _legacy_docx(source, docx)
    document = open_docx(docx)
    return b"", "", document, _word_blocks(document)


def source_digest(source: Path) -> str:
    """对源报告取指纹，以便回插时检测文件变动。"""
    digest = sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def figure_page(document: Document | None, anchor: Paragraph | int | None) -> tuple[float, float]:
    """返回图位所在节的可用宽高（pt），高度预留图题空间。"""
    if document is None or not isinstance(anchor, Paragraph):
        return 450.0, 650.0
    section = document.sections[-1]
    # Word 的分节属性写在该节的最后一段或正文末尾。
    for paragraph in (anchor._p, *anchor._p.itersiblings(tag=qn("w:p"))):
        properties = paragraph.find(qn("w:pPr"))
        if properties is None:
            continue
        section_properties = properties.find(qn("w:sectPr"))
        if section_properties is not None:
            section = Section(section_properties, document.part)
            break
    width = (section.page_width or Cm(21)) - (section.left_margin or 0) - (section.right_margin or 0)
    width -= section.gutter or 0
    columns = section._sectPr.find(qn("w:cols"))
    if columns is not None:
        explicit_widths = [int(item.get(qn("w:w"))) for item in columns if item.get(qn("w:w"))]
        count = int(columns.get(qn("w:num"), "1"))
        if explicit_widths:
            width = min(width, min(explicit_widths) * 635)
        elif count > 1:
            gap = int(columns.get(qn("w:space"), "720")) * 635
            width = (width - gap * (count - 1)) / count
    height = (section.page_height or Cm(29.7)) - (section.top_margin or 0) - (section.bottom_margin or 0)
    if width < Pt(90) or height < Pt(100):
        raise ConversionError("该节可用版心过小。")
    return round(width / 12700, 2), round(height / 12700 - 28, 2)


def illustrate(
    source: Path, settings: AISettings | None, *, colored: bool, prepared: dict | None = None,
) -> dict:
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
        if prepared is not None and prepared.get("digest") != source_digest(source):
            raise ConversionError("源报告已变动，请重新分析后再回插。")
        raw, original, document, blocks = _read_report(source, work)
        if not blocks:
            raise ConversionError("报告没有可分析的正文。")
        cues = _figure_cues(blocks)
        outline = _report_outline(blocks)
        if prepared is None:
            if settings is None:
                raise ConversionError("缺少 AI 连接设置。")
            plan = analyze(settings, _plan_payload(blocks, cues, outline))
        else:
            from .figure_workflow import validate_plan, write_approved_png

            plan = validate_plan(prepared.get("plan"))
            if not isinstance(prepared.get("images"), dict):
                raise ConversionError("缺少已确认的配图清单。")
            if any(not isinstance(prepared.get(key, {}), dict) for key in ("skipped", "notes")):
                raise ConversionError("跳过或复核清单格式错误。")
        staged_assets = work / job
        staged_assets.mkdir()
        issues = []
        for item in plan["issues"]:
            if isinstance(item, dict) and isinstance(item.get("reason"), str):
                issues.append((str(item.get("id", "—")), item["reason"]))
        edits = []
        review_rows = []
        generated = {}
        resolved = set()
        failed_references = {}
        overview = False
        fingerprints = set()
        for index, block in enumerate(blocks, 1):
            if block.picture:
                review_rows.append(("已有实图", index, "原稿包含图像", "—", "保留"))
        covered_pairs = set()
        for item in plan["covered"]:
            if not isinstance(item, dict):
                continue
            ref, image = item.get("reference"), item.get("image")
            if _block_id(ref, blocks) and ref in cues and _block_id(image, blocks) and blocks[image - 1].picture:
                if (ref, image) in covered_pairs:
                    continue
                if ref in resolved and not _allows_multiple_targets(blocks[ref - 1], cues[ref]):
                    issues.append((ref, "同一图题或单一引用被关联到多张实图，请核对对应关系。"))
                    continue
                covered_pairs.add((ref, image))
                resolved.add(ref)
                review_rows.append(("已有实图", image, f"原文引用 {ref}", "—", "保留"))
        candidates = enumerate(plan["diagrams"], 1)
        ordered = sorted(candidates, key=lambda entry: not (
            isinstance(entry[1], dict) and entry[1].get("placement") == "missing"
        ))
        for index, diagram in ordered:
            stage = "候选校验未通过"
            image = staged_assets / f"figure-{index}.png"
            try:
                validator = _validate if prepared is None else _validate_placement
                problem = validator(diagram, blocks, cues)
                if problem:
                    raise ConversionError(problem)
                if prepared is not None and str(index) not in prepared["images"]:
                    stage = "未回插"
                    reason = prepared.get("skipped", {}).get(str(index))
                    detail = reason[:500] if isinstance(reason, str) and reason.strip() else "未选择这张图"
                    raise ConversionError(detail)
                duplicates = sorted({
                    ref for ref in diagram["references"] if ref in resolved
                    and not _allows_multiple_targets(blocks[ref - 1], cues[ref])
                })
                if duplicates:
                    locations = ", ".join(map(str, duplicates))
                    raise ConversionError(f"单一图题或引用已处理（段落 {locations}），请核对是否重复补图")
                anchor = diagram["anchor"]
                if anchor in generated:
                    raise ConversionError("同一正文位置已插图")
                if overview and diagram["overview"]:
                    raise ConversionError("全文已生成一张总览图")
                width = None
                if prepared is None:
                    fingerprint = frozenset(
                        (diagram["nodes"][edge["from"]]["label"], diagram["nodes"][edge["to"]]["label"])
                        for edge in diagram["edges"]
                    )
                else:
                    fingerprint = frozenset((region["start"], region["end"]) for region in diagram["evidence_ranges"])
                    fingerprint = (diagram["title"], fingerprint)
                if fingerprint in fingerprints:
                    raise ConversionError("节点关系与已有新图重复")
                stage = "候选绘制失败"
                if prepared is None:
                    render_diagram(diagram, image, colored)
                else:
                    width, height = figure_page(document, blocks[anchor - 1].anchor)
                    write_approved_png(
                        prepared["images"].get(str(index)), image, diagram, blocks, width, height,
                    )
            except (ConversionError, OSError, TypeError, ValueError, KeyError, AttributeError) as error:
                image.unlink(missing_ok=True)
                image.with_suffix(".json").unlink(missing_ok=True)
                reason = f"{stage}：{error}"
                issues.append((f"候选图 {index}", reason))
                candidate = diagram if isinstance(diagram, dict) else {}
                anchor = candidate.get("anchor")
                location = anchor if _block_id(anchor, blocks) else "—"
                review_rows.append(("待确认", location, candidate.get("title", "—"), "—", reason))
                refs = candidate.get("references")
                if isinstance(refs, list):
                    for ref in refs:
                        if _block_id(ref, blocks) and ref in cues:
                            failed_references.setdefault(ref, []).append(f"候选图 {index} · {reason}")
                continue
            title = diagram["title"].strip()
            reuse_caption = cues.get(anchor + 1) == "caption" and anchor + 1 in diagram["references"]
            edits.append((blocks[anchor - 1].anchor, image, None if reuse_caption else title, width))
            generated[anchor] = title
            resolved.update(diagram["references"])
            spans = ", ".join(f"{region['start']}–{region['end']}" for region in diagram["evidence_ranges"])
            category = "有引用但缺图" if diagram["placement"] == "missing" else "原文适合新增"
            reference_ids = ", ".join(str(ref) for ref in diagram["references"])
            result = f"已生成 {image.name}"
            if reference_ids:
                result += f"。对应引用 {reference_ids}"
            if prepared is not None:
                note = prepared.get("notes", {}).get(str(index))
                if isinstance(note, str) and note.strip():
                    result += f"。{note[:500]}"
            review_rows.append((category, anchor, title, spans, result))
            fingerprints.add(fingerprint)
            overview = overview or diagram["overview"]

        issue_by_id = {str(location): reason for location, reason in issues}
        for ref in cues:
            if ref in resolved:
                continue
            if ref in failed_references:
                reason = "；".join(failed_references[ref])
            elif str(ref) in issue_by_id:
                reason = issue_by_id[str(ref)]
            else:
                reason = "规划未给出图位或实图对应关系"
                issues.append((str(ref), reason))
            review_rows.append(("待确认", ref, blocks[ref - 1].text[:120], "—", reason))
        section_rows, section_issues = _review_sections(plan, blocks, outline, generated)
        issues.extend(section_issues)

        staged_output = work / output.name
        if markdown:
            lines = original.splitlines(keepends=True)
            newline = "\r\n" if "\r\n" in original else "\n"
            for anchor, image, title, _width in sorted(edits, reverse=True, key=lambda edit: edit[0]):
                prefix = newline if not lines[anchor - 1].endswith(("\n", "\r")) else ""
                snippet = f"{prefix}{newline}![]({job}/{image.name}){newline}{newline}"
                if title is not None:
                    snippet += f"{_markdown_text(title)}{newline}{newline}"
                lines.insert(anchor, snippet)
            encoding = "utf-8-sig" if raw.startswith(b"\xef\xbb\xbf") else "utf-8"
            staged_output.write_bytes("".join(lines).encode(encoding))
        else:
            for anchor, image, title, width in edits:
                _insert_word(document, anchor, image, title, width)
            document.save(staged_output)
            open_docx(staged_output)
        review = staged_assets / "审核清单.md"
        top_level = min((entry["level"] for entry in outline if entry["level"] is not None), default=None)
        heading_note = f"本稿顶层为 {top_level} 级标题。" if top_level is not None else "本稿无显式标题。"
        rows = ["# 配图审核清单", "", "段落编号来自本次分析，取证范围可跨节。" + heading_note, "",
                f"原稿实图位置 {sum(block.picture for block in blocks)} 处；引用和图题 {len(cues)} 处，"
                f"其中 {len(resolved)} 处已对应至少一张实图或生成图；共生成 {len(edits)} 张图。", "",
                "| 分类 | 插入位置或引用 | 图题或线索 | 取证范围 | 处理结果 |",
                "| --- | --- | --- | --- | --- |"]
        _append_review_rows(rows, review_rows or [("—", "—", "—", "—", "无图位记录")])
        rows.extend(["", "## 未单独出图的主题", "", "| 节 | 主题 | 处理 | 理由 |", "| --- | --- | --- | --- |"])
        _append_review_rows(rows, section_rows or [("—", "—", "—", "无单列记录")])
        rows.extend(["", "## 待确认问题", "", "| 位置 | 待确认问题 |", "| --- | --- |"])
        _append_review_rows(rows, issues or [("—", "无待确认问题")])
        review.write_text("\n".join(rows) + "\n", encoding="utf-8")
        # 输出先在同一磁盘完成写入，再发布；发生冲突时回收本次新资源目录。
        if prepared is not None and prepared["digest"] != source_digest(source):
            raise ConversionError("源报告已变动，请重新分析后再回插。")
        if output.exists() or assets.exists():
            raise ConversionError("输出路径已存在，请重新运行。")
        staged_assets.rename(assets)
        try:
            staged_output.rename(output)
        except OSError:
            assets.rename(staged_assets)
            raise
    return {"output": str(output), "review": str(assets / review.name), "images": len(edits), "issues": len(issues)}
