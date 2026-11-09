"""区分样式模板和完整模板，并在完整模板中定位正文。"""

from copy import deepcopy
from collections.abc import Iterator

from docx.document import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.opc.oxml import serialize_part_xml
from docx.opc.packuri import PackURI
from docx.opc.part import Part
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn
from docxcompose.composer import Composer
from lxml.etree import _Element

BOOKMARK = "DOCFLOW_CONTENT"
PLACEHOLDER = "{{DOCFLOW_CONTENT}}"
RESOURCE_ATTRIBUTES = tuple(qn(name) for name in ("r:id", "r:embed", "r:link"))
# Pandoc 的默认角色找不到同名样式时，优先使用模板中等价的中文样式。
STYLE_ALIASES = {
    "Title": ("Title", "题目"),
    "ImageCaption": ("Image Caption", "图名"),
    "TableCaption": ("Table Caption", "表名"),
    "CaptionedFigure": ("Captioned Figure", "图片"),
    "Figure": ("Figure", "图片"),
    "FirstParagraph": ("First Paragraph", "Normal"),
    "BodyText": ("Body Text", "Normal"),
}


class ConversionError(Exception):
    """可向调用者报告的转换错误。"""


def has_toc_placeholder(template: Document) -> bool:
    """检测模板正文里的 Word 目录内容控件。"""
    galleries = template.element.body.xpath(".//w:docPartGallery/@w:val")
    return any(value.casefold() == "table of contents" for value in galleries)


def apply_template_styles(template: Document, content: Document) -> bool:
    """应用模板段落角色，并为未定义对齐的生成表格设置默认值。"""
    paragraph_styles = {
        style.name: style.style_id
        for style in template.styles if style.type == WD_STYLE_TYPE.PARAGRAPH
    }
    style_ids = set(paragraph_styles.values())
    normal_style = paragraph_styles.get("正文") or paragraph_styles.get("Normal")
    body_style_ids = {"FirstParagraph", "BodyText"}
    for name in ("First Paragraph", "Body Text"):
        if name in paragraph_styles:
            body_style_ids.add(paragraph_styles[name])
    cell_style = paragraph_styles.get("表格文字")
    body = content.element.body
    changed = False
    for table in content.tables:
        if table.alignment is not None:
            continue
        # Word 表格样式可通过 basedOn 继承对齐，优先保留模板定义。
        style = table.style
        visited = set()
        while style is not None and style.style_id not in visited:
            if style.element.xpath("./w:tblPr/w:jc"):
                break
            visited.add(style.style_id)
            style = style.base_style
        else:
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            changed = True

    for paragraph in body.xpath(".//w:p"):
        style = paragraph.find(f"./{qn('w:pPr')}/{qn('w:pStyle')}")
        style_id = style.get(qn("w:val")) if style is not None else None
        if style_id in {"CaptionedFigure", "TableCaption"}:
            # 题注与图表同页，避免图片或表名落在上一页底部。
            paragraph.get_or_add_pPr().get_or_add_keepNext().val = True
            changed = True
        target = None
        if cell_style and style_id in {None, "Compact", "BodyText", "FirstParagraph"}:
            if next(paragraph.iterancestors(qn("w:tc")), None) is not None:
                target = cell_style
        # Pandoc 区分首段与后续段，且可能直接使用参考模板中的样式 ID。
        if normal_style and style_id in body_style_ids and paragraph.getparent() is body:
            if not paragraph.xpath("./w:pPr/w:numPr"):
                target = normal_style
        if target is None and style_id not in style_ids:
            for name in STYLE_ALIASES.get(style_id, ()):
                target = paragraph_styles.get(name)
                if target is not None:
                    break
        if target is None or target == style_id:
            continue
        paragraph.get_or_add_pPr().get_or_add_pStyle().val = target
        changed = True
    return changed


def select_anchor(template: Document, mode: str) -> _Element | None:
    """识别正文锚点并验证替换段落不会删除模板对象。"""
    if mode == "style":
        return None

    body = template.element.body
    bookmarks = body.xpath(f'.//w:bookmarkStart[@w:name="{BOOKMARK}"]')
    placeholders = [
        paragraph for paragraph in body.xpath(".//w:p")
        if "".join(paragraph.xpath("./w:r/w:t/text()")).strip() == PLACEHOLDER
    ]
    if not bookmarks and not placeholders and mode == "auto":
        return None
    if len(bookmarks) + len(placeholders) != 1:
        raise ConversionError(f"完整模板需要一个唯一的 {BOOKMARK} 书签或 {PLACEHOLDER} 段落。")

    if bookmarks:
        start = bookmarks[0]
        paragraph = start.getparent()
        bookmark_id = start.get(qn("w:id"))
        ends = body.xpath(".//w:bookmarkEnd")
        matching_ends = [end for end in ends if end.get(qn("w:id")) == bookmark_id]
        if (
            bookmark_id is None or len(matching_ends) != 1
            or matching_ends[0].getparent() is not paragraph
            or paragraph.index(start) >= paragraph.index(matching_ends[0])
        ):
            raise ConversionError(f"{BOOKMARK} 书签的起止位置必须在同一个独立段落。")
        allowed_bookmarks = {start, matching_ends[0]}
    else:
        paragraph = placeholders[0]
        allowed_bookmarks = set()

    if paragraph.tag != qn("w:p") or paragraph.getparent() is not body:
        raise ConversionError("正文锚点必须在模板正文的顶层独立段落。")
    if paragraph.xpath("./w:pPr/w:sectPr"):
        raise ConversionError("正文锚点段落包含分节符，请将锚点移到独立段落。")
    for child in paragraph:
        if child.tag in {qn("w:pPr"), qn("w:proofErr")} or child in allowed_bookmarks:
            continue
        if child.tag == qn("w:r") and all(
            item.tag in {qn("w:rPr"), qn("w:t")} for item in child
        ):
            continue
        raise ConversionError("正文锚点段落包含其他文档对象，请单独放置锚点。")
    if bookmarks and "".join(paragraph.xpath("./w:r/w:t/text()")).strip():
        raise ConversionError(f"{BOOKMARK} 书签必须放在空段落。")
    return paragraph


def footnote_resources(element: _Element) -> Iterator[tuple[_Element, str, str]]:
    """列出脚注内指向外部链接或媒体的 OOXML 属性。"""
    for node in element.iter():
        for attribute in RESOURCE_ATTRIBUTES:
            resource_id = node.get(attribute)
            if resource_id is not None:
                yield node, attribute, resource_id


def repair_generated_footnotes(document: Document) -> bool:
    """将 Pandoc 写在主文档关系表中的脚注图片登记到脚注部件。"""
    try:
        part = document.part.rels.part_with_reltype(RT.FOOTNOTES)
    except KeyError:
        return False

    notes = parse_xml(part.blob)
    original_ids = set(part.rels)
    changed = False
    for node, attribute, resource_id in footnote_resources(notes):
        if resource_id in original_ids:
            continue
        relation = document.part.rels.get(resource_id)
        if relation is None or relation.reltype != RT.IMAGE:
            raise ConversionError(f"生成的脚注引用了不存在的资源：{resource_id}。")
        if relation.is_external:
            new_id = part.relate_to(relation.target_ref, RT.IMAGE, is_external=True)
        else:
            new_id = part.relate_to(relation.target_part, RT.IMAGE)
        node.set(attribute, new_id)
        changed = True

    if changed:
        part._blob = serialize_part_xml(notes)
    return changed


class TemplateComposer(Composer):
    """保留主模板的书签，并按部件合并生成内容的脚注。"""

    def renumber_bookmarks(self) -> None:
        # 插入前已按起止 ID 成对重排新书签，保留模板中已有书签。
        return

    def add_footnotes(self, doc: Document, element: _Element) -> None:
        """为脚注分配新 ID，并将资源引用绑定到复制后的脚注。"""
        references = list(element.iter(qn("w:footnoteReference")))
        if not references:
            return

        source = doc.part.rels.part_with_reltype(RT.FOOTNOTES)
        target = self.footnote_part()
        incoming = parse_xml(source.blob)
        notes = parse_xml(target.blob)
        id_attr = qn("w:id")
        existing_ids = [int(note.get(id_attr)) for note in notes.iter(qn("w:footnote"))]
        next_id = max(existing_ids, default=0) + 1

        for reference in references:
            old_id = reference.get(id_attr)
            original = incoming.find(f"w:footnote[@w:id='{old_id}']", incoming.nsmap)
            if original is None:
                raise ConversionError(f"生成的正文引用了不存在的脚注：{old_id}。")
            note = deepcopy(original)
            for node, attribute, resource_id in footnote_resources(note):
                relationship = source.rels[resource_id]
                if relationship.reltype == RT.IMAGE and not relationship.is_external:
                    # 使用独立命名空间，避免与正文合并时分配的媒体路径冲突。
                    image = relationship.target_part
                    partname = self.pkg.next_partname(
                        f"/word/media/footnote-image%d.{image.partname.ext}"
                    )
                    copied = Part(PackURI(partname), image.content_type, image.blob, self.pkg)
                    new_id = target.relate_to(copied, RT.IMAGE)
                else:
                    new_id = self.add_relationship(source, target, relationship).rId
                node.set(attribute, new_id)

            self.add_styles(doc, note)
            self.add_numberings(doc, note)
            new_note_id = str(next_id)
            note.set(id_attr, new_note_id)
            reference.set(id_attr, new_note_id)
            notes.append(note)
            next_id += 1

        target._blob = serialize_part_xml(notes)


def insert_content(template: Document, content: Document, anchor: _Element) -> None:
    """将生成内容合入主模板，保留模板正文和分节。"""
    body = template.element.body
    template_starts = body.xpath(".//w:bookmarkStart")
    reserved_names = {
        start.get(qn("w:name"), "").casefold()
        for start in template_starts if start.getparent() is not anchor
    }
    used_ids = {
        mark.get(qn("w:id"))
        for mark in body.xpath(".//w:bookmarkStart | .//w:bookmarkEnd")
    }
    bookmark_ids = {}
    next_id = 0
    for start in content.element.body.xpath(".//w:bookmarkStart"):
        name = start.get(qn("w:name"), "")
        if name.casefold() in reserved_names:
            raise ConversionError(f"生成内容的书签与模板冲突：{name}。请调整 Markdown 标题标识符。")
        while str(next_id) in used_ids:
            next_id += 1
        bookmark_ids[start.get(qn("w:id"))] = str(next_id)
        start.set(qn("w:id"), str(next_id))
        next_id += 1
    for end in content.element.body.xpath(".//w:bookmarkEnd"):
        end.set(qn("w:id"), bookmark_ids[end.get(qn("w:id"))])

    # docxcompose 合并主文档正文中的媒体、链接和列表编号关系。
    index = body.index(anchor)
    body.remove(anchor)
    TemplateComposer(template).insert(index, content, remove_property_fields=False)


def request_field_updates(document: Document) -> None:
    """标记目录等域应由编辑器在打开文档时刷新。"""
    settings = document.settings.element
    update = settings.find(qn("w:updateFields"))
    if update is None:
        update = OxmlElement("w:updateFields")
        settings.insert_element_before(
            update, "w:hdrShapeDefaults", "w:footnotePr", "w:endnotePr",
            "w:compat", "w:docVars", "w:rsids", "m:mathPr",
            "w:attachedSchema", "w:themeFontLang", "w:clrSchemeMapping",
        )
    update.set(qn("w:val"), "true")
