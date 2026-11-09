"""把已定位的 Markdown 批注写入合并后的 DOCX。"""

import json
from collections import defaultdict
from copy import deepcopy
from dataclasses import dataclass

from docx.document import Document
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph
from docx.text.run import Run

from .templates import ConversionError

FORMATTED = {"Emph", "Strong", "Strikeout", "SmallCaps", "Subscript", "Superscript", "Underline"}


@dataclass(frozen=True)
class ReviewNote:
    """记录顶层段落编号、字符偏移、原文和批注。"""

    block: int
    offset: int
    quote: str
    body: str


def paragraph_text(inlines: list[dict]) -> str | None:
    """投影第一版支持的普通正文和行内格式。"""
    parts = []
    for inline in inlines:
        kind = inline["t"]
        if kind == "Str":
            parts.append(inline["c"])
        elif kind == "Space":
            parts.append(" ")
        elif kind in FORMATTED:
            text = paragraph_text(inline["c"])
            if text is None:
                return None
            parts.append(text)
        else:
            return None
    return "".join(parts)


def mark_paragraphs(ast: bytes, notes: tuple[ReviewNote, ...], prefix: str) -> tuple[bytes, dict]:
    """为带批注的正文段落加临时书签，并验证选区与 AST 相符。"""
    tree = json.loads(ast)
    groups = defaultdict(list)
    for note in notes:
        groups[note.block].append(note)

    marked = {}
    for index, items in groups.items():
        if not 0 <= index < len(tree["blocks"]):
            raise ConversionError("批注的段落已不存在。")
        block = tree["blocks"][index]
        text = paragraph_text(block["c"]) if block["t"] == "Para" else None
        for note in items:
            end = note.offset + len(note.quote)
            if text is None or note.offset < 0 or not note.quote or text[note.offset:end] != note.quote:
                raise ConversionError("批注选区与导出正文不一致，请重新定位。")
        name = f"{prefix}{index}"
        block["c"] = [{"t": "Span", "c": [[name, [], []], block["c"]]}]
        marked[name] = (text, items)
    return json.dumps(tree, ensure_ascii=False).encode("utf-8"), marked


def _split_runs(paragraph: Paragraph, boundaries: set[int]) -> dict[int, Run]:
    """拆分纯文本 run，保留原格式，使每个批注端点落在 run 边界。"""
    position = 0
    starts = {}
    ordered = sorted(boundaries)
    for run in paragraph.runs:
        text = run.text
        end = position + len(text)
        if not text:
            continue
        cuts = [cut for cut in ordered if position < cut < end]
        starts[position] = run
        if cuts:
            if any(child.tag not in {qn("w:rPr"), qn("w:t")} for child in run._element):
                raise ConversionError("批注端点落在无法安全拆分的 DOCX 内容中。")
            offsets = [position, *cuts, end]
            previous = run
            run.text = text[:cuts[0] - position]
            for start, stop in zip(offsets[1:-1], offsets[2:]):
                element = deepcopy(run._element)
                previous._element.addnext(element)
                piece = Run(element, paragraph)
                piece.text = text[start - position:stop - position]
                starts[start] = piece
                previous = piece
        position = end
    return starts


def write_notes(document: Document, marked: dict) -> None:
    """在最终文档上创建标准审阅批注，并移除临时书签。"""
    body = document.element.body
    for name, (text, notes) in marked.items():
        # Pandoc 3.10 和较新版本的书签名前缀不同。
        starts = body.xpath(f'.//w:bookmarkStart[@w:name="{name}" or @w:name="_{name}"]')
        if len(starts) != 1:
            raise ConversionError("未找到批注对应的唯一 DOCX 书签。")
        bookmark = starts[0]
        bookmark_id = bookmark.get(qn("w:id"))
        ends = body.xpath(f'.//w:bookmarkEnd[@w:id="{bookmark_id}"]')
        element = bookmark.getparent()
        if len(ends) != 1 or ends[0].getparent() is not element or element.tag != qn("w:p"):
            raise ConversionError("批注对应的 DOCX 段落结构不受支持。")
        paragraph = Paragraph(element, document)
        if paragraph.text != text or "".join(run.text for run in paragraph.runs) != text:
            raise ConversionError("导出段落发生变化，无法准确添加批注。")

        boundaries = set()
        for note in notes:
            boundaries.add(note.offset)
            boundaries.add(note.offset + len(note.quote))
        runs = _split_runs(paragraph, boundaries)
        offsets = list(runs)
        last_by_end = dict(zip([*offsets[1:], len(text)], runs.values()))
        for note in notes:
            last = last_by_end[note.offset + len(note.quote)]
            document.add_comment([runs[note.offset], last], text=note.body, author="DocumentCraft")
        element.remove(bookmark)
        element.remove(ends[0])

