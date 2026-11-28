"""移植单页图片、表格、图表与其包内资源，保留原生编辑能力。"""

from __future__ import annotations

import math
import posixpath
import shutil
from copy import deepcopy
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Callable
from uuid import uuid4
from xml.etree import ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from lxml import etree

from .deck_chart import bind_embedded_chart_ranges
from .deck_preview import (
    MAX_XML_BYTES,
    PRESENTATION,
    TextContext,
    RELATIONSHIP_NAMESPACES,
    _internal_target,
    _relationship_ids,
    _relationships,
    _relationships_part,
    _revision,
    _shape_elements,
    _shape_kind,
    read_text_context,
    text_placeholder_defaults,
)
from .templates import ConversionError

if TYPE_CHECKING:
    from .deck_export import Asset, Box

REL_XML = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NAME = "[Content_Types].xml"
CHART_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
POINT_TO_EMU = 12700
DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main"


def _xml(archive: ZipFile, part: str) -> etree._Element:
    entry = archive.getinfo(part)
    if entry.file_size > MAX_XML_BYTES:
        raise ConversionError(f"PPTX 的 XML 部件超过读取上限：{part}")
    parser = etree.XMLParser(resolve_entities=False, no_network=True, remove_comments=True, remove_pis=True)
    return etree.fromstring(archive.read(entry), parser)


def _encoded(node: etree._Element) -> bytes:
    return etree.tostring(node, encoding="UTF-8", xml_declaration=True, standalone=True)


def _empty_relationships() -> etree._Element:
    return etree.Element(f"{{{REL_XML}}}Relationships", nsmap={None: REL_XML})


def _copy_zip_entry(origin: ZipFile, output: ZipFile, entry: ZipInfo, target: str) -> None:
    """分块复制资源，避免把大视频、图像和嵌入工作簿放进 Python 内存。"""
    target_info = ZipInfo(target)
    target_info.compress_type = entry.compress_type
    target_info.file_size = entry.file_size
    target_info.date_time = entry.date_time
    with origin.open(entry) as reader, output.open(target_info, "w") as writer:
        shutil.copyfileobj(reader, writer, length=1024 * 1024)


def _slide_entry(archive: ZipFile, slide_id: int | None) -> tuple[str, etree._Element]:
    presentation = _xml(archive, PRESENTATION)
    slides = presentation.findall("./{*}sldIdLst/{*}sldId")
    if slide_id is None:
        if len(slides) != 1:
            raise ConversionError("用于封装的中间稿应当只有当前草稿页。")
        slide = slides[0]
    else:
        slide = next((entry for entry in slides if entry.get("id") == str(slide_id)), None)
        if slide is None:
            raise ConversionError("找不到原始幻灯片。")
    links = _relationships(archive, PRESENTATION)
    part = next((links[key][1] for key in _relationship_ids(slide) if key in links), None)
    if part is None:
        raise ConversionError("幻灯片缺少有效的部件关系。")
    return part, _xml(archive, part)


def _source_shape(root: etree._Element, object_id: int, object_kind: str) -> etree._Element:
    tree = root.find("./{*}cSld/{*}spTree")
    if tree is None:
        raise ConversionError("源幻灯片缺少对象树。")
    for shape in _shape_elements(tree):
        kind = _shape_kind(shape)
        if kind is None or kind[0] != object_kind:
            continue
        identity = shape.find(f"./{{*}}{kind[1]}/{{*}}cNvPr")
        if identity is not None and identity.get("id") == str(object_id):
            return deepcopy(shape)
    raise ConversionError("找不到选中的原生对象。")


def _scale_rendered_text(shape: etree._Element, ratio: float, default: int | None = None) -> None:
    """让原生对象内的字级和段距随尺寸缩小，避免 WPS 重排时把表格撑出幻灯片。"""
    if ratio >= 1:
        return
    for node in shape.iter():
        if not isinstance(node.tag, str) or not node.tag.startswith(f"{{{DRAWING}}}"):
            continue
        name = etree.QName(node).localname
        if name in {"rPr", "defRPr", "endParaRPr"} and "sz" in node.attrib:
            node.set("sz", str(max(500, round(int(node.attrib["sz"]) * ratio))))
        if name == "spcPts" and "val" in node.attrib:
            node.set("val", str(round(int(node.attrib["val"]) * ratio)))
    if default is None:
        return
    for paragraph in shape.findall(f".//{{{DRAWING}}}p"):
        properties = paragraph.find(f"./{{{DRAWING}}}pPr")
        if properties is None:
            properties = etree.Element(f"{{{DRAWING}}}pPr")
            paragraph.insert(0, properties)
        run_default = properties.find(f"./{{{DRAWING}}}defRPr")
        if run_default is None:
            run_default = etree.SubElement(properties, f"{{{DRAWING}}}defRPr")
        if "sz" not in run_default.attrib:
            run_default.set("sz", str(max(500, round(default * ratio))))


def _native_xml(node: ET.Element) -> etree._Element:
    return etree.fromstring(ET.tostring(node, encoding="utf-8"))


def _explicit_text_theme(shape: etree._Element, context: TextContext) -> None:
    """把源主题的文字颜色和字族落到复制件，避免换模板后改成目标主题值。"""
    if context.theme is None:
        return
    palette = context.theme.find(".//{*}themeElements/{*}clrScheme")
    colors = {}
    if palette is not None:
        for slot in palette:
            if len(slot):
                value = slot[0].get("lastClr") or slot[0].get("val")
                if value is not None and len(value) == 6:
                    colors[slot.tag.rsplit("}", 1)[-1]] = value
    fonts = {}
    scheme = context.theme.find(".//{*}themeElements/{*}fontScheme")
    if scheme is not None:
        for prefix, family in (("mj", "majorFont"), ("mn", "minorFont")):
            for suffix, script in (("lt", "latin"), ("ea", "ea"), ("cs", "cs")):
                rule = scheme.find(f"./{{*}}{family}/{{*}}{script}")
                if rule is not None and rule.get("typeface"):
                    fonts[f"+{prefix}-{suffix}"] = rule.attrib["typeface"]
    for node in shape.iter():
        if node.tag == f"{{{DRAWING}}}schemeClr":
            value = node.get("val", "")
            explicit = colors.get(context.color_map.get(value, value))
            if explicit is not None:
                node.tag = f"{{{DRAWING}}}srgbClr"
                node.set("val", explicit)
        typeface = node.get("typeface")
        if typeface in fonts:
            node.set("typeface", fonts[typeface])


def _copy_text_defaults(body: etree._Element, parents: list[ET.Element], default_style: ET.Element | None) -> None:
    """补足段落层级的来源样式。原对象显式写入的属性优先。"""
    body_pr = body.find(f"./{{{DRAWING}}}bodyPr")
    if body_pr is None:
        body_pr = etree.Element(f"{{{DRAWING}}}bodyPr")
        body.insert(0, body_pr)
    list_style = body.find(f"./{{{DRAWING}}}lstStyle")
    if list_style is None:
        list_style = etree.Element(f"{{{DRAWING}}}lstStyle")
        body.insert(body.index(body_pr) + 1, list_style)
    defaults = []
    for parent in parents:
        inherited_body = parent.find("./{*}txBody/{*}bodyPr")
        if inherited_body is not None:
            for name, value in inherited_body.attrib.items():
                if name not in body_pr.attrib:
                    body_pr.set(name, value)
        inherited_list = parent.find("./{*}txBody/{*}lstStyle")
        if inherited_list is not None:
            defaults.append(inherited_list)
    if default_style is not None:
        defaults.append(default_style)
    ranks = {"defPPr": 0, **{f"lvl{level}pPr": level for level in range(1, 10)}}
    # 保持段落层级节点的 schema 顺序，且跳过属于源母版关系表的图像项目符号等引用。
    for source in defaults:
        for level in source:
            name = level.tag.rsplit("}", 1)[-1]
            if name not in ranks or _relationship_ids(level):
                continue
            current = list_style.find(level.tag)
            if current is None:
                rank = ranks[name]
                index = next(
                    (i for i, node in enumerate(list_style) if ranks.get(etree.QName(node).localname, 10) > rank),
                    len(list_style),
                )
                list_style.insert(index, _native_xml(level))
                continue
            for attribute, value in level.attrib.items():
                if attribute not in current.attrib:
                    current.set(attribute, value)
            default_run = level.find("./{*}defRPr")
            if default_run is None:
                continue
            current_run = current.find("./{*}defRPr")
            if current_run is None:
                extension = current.find("./{*}extLst")
                index = current.index(extension) if extension is not None else len(current)
                current.insert(index, _native_xml(default_run))
            else:
                for attribute, value in default_run.attrib.items():
                    if attribute not in current_run.attrib:
                        current_run.set(attribute, value)

    fit_types = {f"{{{DRAWING}}}{name}" for name in ("noAutofit", "normAutofit", "spAutoFit")}
    fit = next((node for node in body_pr if node.tag == f"{{{DRAWING}}}normAutofit"), None)
    if fit is None:
        for node in list(body_pr):
            if node.tag in fit_types:
                body_pr.remove(node)
        warp = body_pr.find(f"./{{{DRAWING}}}prstTxWarp")
        index = body_pr.index(warp) + 1 if warp is not None else 0
        body_pr.insert(index, etree.Element(f"{{{DRAWING}}}normAutofit"))


def _prepare_text_shape(shape: etree._Element, bounds: Box, context: TextContext) -> None:
    """把源文本占位符变成可跨版式移动的可编辑文本框。"""
    parents, style = text_placeholder_defaults(shape, context)
    body = shape.find("./{*}txBody")
    if body is None:
        raise ConversionError("源文字对象缺少可编辑的正文。")
    _copy_text_defaults(body, parents, style)
    nonvisual = shape.find("./{*}nvSpPr/{*}nvPr")
    if nonvisual is not None:
        placeholder = nonvisual.find("./{*}ph")
        if placeholder is not None:
            nonvisual.remove(placeholder)
            textbox = shape.find("./{*}nvSpPr/{*}cNvSpPr")
            if textbox is not None:
                textbox.set("txBox", "1")
    props = shape.find("./{*}spPr")
    if props is None:
        namespace = etree.QName(shape).namespace
        props = etree.Element(f"{{{namespace}}}spPr")
        shape.insert(1, props)
    transform = props.find(f"./{{{DRAWING}}}xfrm")
    if transform is None:
        transform = etree.Element(f"{{{DRAWING}}}xfrm")
        props.insert(0, transform)
    for parent in parents:
        inherited = parent.find("./{*}spPr/{*}xfrm")
        if inherited is None:
            continue
        for name, value in inherited.attrib.items():
            if name not in transform.attrib:
                transform.set(name, value)
        for kind in ("off", "ext"):
            child = inherited.find(f"./{{{DRAWING}}}{kind}")
            if child is not None and transform.find(child.tag) is None:
                transform.append(_native_xml(child))
    offset = transform.find(f"./{{{DRAWING}}}off")
    if offset is None:
        transform.insert(0, etree.Element(f"{{{DRAWING}}}off", x="0", y="0"))
    extent = transform.find(f"./{{{DRAWING}}}ext")
    if extent is None:
        extent = etree.SubElement(transform, f"{{{DRAWING}}}ext")
    if int(extent.get("cx", "0")) <= 0 or int(extent.get("cy", "0")) <= 0:
        extent.set("cx", str(max(1, round(bounds.width * POINT_TO_EMU))))
        extent.set("cy", str(max(1, round(bounds.height * POINT_TO_EMU))))
    _explicit_text_theme(shape, context)


def _position_shape(shape: etree._Element, bounds: Box, kind: str = "") -> float:
    """按版式定位原生形状。宽表格和图表使用其版面宽度，图片保留宽高比。"""
    for path in ("./{*}xfrm", "./{*}spPr/{*}xfrm", "./{*}grpSpPr/{*}xfrm"):
        transform = shape.find(path)
        if transform is not None:
            break
    else:
        raise ConversionError("素材没有可定位的原始尺寸。")
    offset = transform.find("./{*}off")
    extent = transform.find("./{*}ext")
    if offset is None or extent is None:
        raise ConversionError("素材没有可定位的原始尺寸。")
    width = int(extent.get("cx", "0"))
    height = int(extent.get("cy", "0"))
    if width <= 0 or height <= 0:
        raise ConversionError("素材的原始尺寸无效。")
    angle = math.radians(int(transform.get("rot", "0")) / 60000)
    visible_width = abs(width * math.cos(angle)) + abs(height * math.sin(angle))
    visible_height = abs(width * math.sin(angle)) + abs(height * math.cos(angle))
    ratio = min(bounds.width * POINT_TO_EMU / visible_width, bounds.height * POINT_TO_EMU / visible_height)
    table = shape.find("./{*}graphic/{*}graphicData/{*}tbl")
    wide = (table is not None or kind == "chart") and angle == 0
    new_width = max(1, round(bounds.width * POINT_TO_EMU if wide else width * ratio))
    new_height = max(1, round(bounds.height * POINT_TO_EMU if wide else height * ratio))
    offset.set("x", str(round((bounds.left + bounds.width / 2) * POINT_TO_EMU - new_width / 2)))
    offset.set("y", str(round((bounds.top + bounds.height / 2) * POINT_TO_EMU - new_height / 2)))
    extent.set("cx", str(new_width))
    extent.set("cy", str(new_height))
    # 图表在 graphicFrame 内绘制。表格的行高和列宽还会在 DrawingML 网格中单独存一份。
    if table is not None:
        width_ratio = new_width / width
        height_ratio = new_height / height
        for path, key, scale in (("./{*}tr", "h", height_ratio), ("./{*}tblGrid/{*}gridCol", "w", width_ratio)):
            for cell in table.findall(path):
                cell.set(key, str(max(1, round(int(cell.attrib[key]) * scale))))
        font_ratio = min(1.0, width_ratio, height_ratio)
        _scale_rendered_text(table, font_ratio, default=1800)
        for cell in table.findall(".//{*}tcPr"):
            for key, default_margin in (("marL", 91440), ("marR", 91440), ("marT", 45720), ("marB", 45720)):
                cell.set(key, str(round(int(cell.get(key, str(default_margin))) * font_ratio)))
    if kind == "text":
        _scale_rendered_text(shape, min(1.0, ratio))
    return min(1.0, ratio)


def _rename_shape(shape: etree._Element, name: str, next_id: int) -> int:
    """重编源形状 ID，避免与新页占位符和其他旧稿对象冲突。"""
    ids = {}
    for index, item in enumerate(shape.findall(".//{*}cNvPr")):
        old_id = item.get("id")
        ids[old_id] = str(next_id)
        item.set("id", str(next_id))
        next_id += 1
        if index == 0:
            item.set("name", name)
    for tag in ("stCxn", "endCxn"):
        for connection in shape.findall(f".//{{*}}{tag}"):
            old_id = connection.get("id")
            if old_id in ids:
                connection.set("id", ids[old_id])
            else:
                connection.getparent().remove(connection)
    return next_id


class PartTransfer:
    """为一个源包重定位依赖部件，内部关系保留 ID，并重算相对关系地址。"""

    def __init__(self, origin: ZipFile, output: ZipFile, output_types: etree._Element) -> None:
        self.origin = origin
        self.output = output
        self.output_types = output_types
        types = _xml(origin, CONTENT_TYPES_NAME)
        self.defaults = {item.get("Extension", "").lower(): item.get("ContentType") for item in types if "Extension" in item.attrib}
        self.overrides = {item.get("PartName", "").lstrip("/"): item.get("ContentType") for item in types if "PartName" in item.attrib}
        self.copied: dict[str, str] = {}
        self.chart_text_ratio = 1.0
        self.prefix = f"dc_{uuid4().hex[:10]}_"

    def _register(self, source: str, target: str) -> str:
        suffix = PurePosixPath(source).suffix.lower().removeprefix(".")
        content_type = self.overrides.get(source) or self.defaults.get(suffix)
        if not content_type:
            raise ConversionError(f"源素材缺少部件类型：{source}")
        namespace = etree.QName(self.output_types).namespace
        etree.SubElement(self.output_types, f"{{{namespace}}}Override", PartName="/" + target, ContentType=content_type)
        return content_type

    def _copy_part(self, part: str) -> str:
        if part in self.copied:
            return self.copied[part]
        folder, name = posixpath.split(part)
        destination = posixpath.join(folder, self.prefix + name)
        self.copied[part] = destination
        content_type = self._register(part, destination)
        if content_type == CHART_CONTENT_TYPE:
            chart = _xml(self.origin, part)
            bind_embedded_chart_ranges(self.origin, part, chart)
            _scale_rendered_text(chart, max(0.55, self.chart_text_ratio))
            self.output.writestr(destination, _encoded(chart))
        else:
            _copy_zip_entry(self.origin, self.output, self.origin.getinfo(part), destination)
        rels_part = _relationships_part(part)
        if rels_part in self.origin.NameToInfo:
            relationships = _xml(self.origin, rels_part)
            for relation in relationships:
                self._transfer_target(relation, part, destination)
            self.output.writestr(_relationships_part(destination), _encoded(relationships))
        return destination

    def _transfer_target(self, relation: etree._Element, part: str, destination: str) -> None:
        if relation.get("TargetMode") == "External":
            # 外部超链接随素材保留。外链媒体或工作簿无法作为可移植的原生素材交付。
            if not relation.get("Type", "").endswith("/hyperlink"):
                raise ConversionError("素材依赖外部文件。请先在源稿中嵌入资源。")
            return
        source = _internal_target(part, relation.attrib["Target"])
        if source is None:
            raise ConversionError("素材包含无效的内部关系。")
        target = self._copy_part(source)
        folder = posixpath.dirname(destination)
        relation.set("Target", posixpath.relpath(target, folder))

    def add_shape_relations(
        self, shape: etree._Element, part: str, destination: str, destination_links: etree._Element,
    ) -> None:
        used = _relationship_ids(shape)
        if not used:
            return
        source_links = {item.get("Id"): item for item in _xml(self.origin, _relationships_part(part))}
        existing = {item.get("Id") for item in destination_links}
        remap = {}
        number = 1
        for identifier in sorted(used):
            if identifier not in source_links:
                raise ConversionError("素材引用了不存在的部件关系。")
            while f"rId{number}" in existing:
                number += 1
            relation = deepcopy(source_links[identifier])
            new_id = f"rId{number}"
            remap[identifier] = new_id
            existing.add(new_id)
            relation.set("Id", new_id)
            self._transfer_target(relation, part, destination)
            destination_links.append(relation)
        for node in shape.iter():
            for name, value in node.attrib.items():
                namespace, _, _ = name.partition("}")
                if namespace.lstrip("{") in RELATIONSHIP_NAMESPACES and value in remap:
                    node.set(name, remap[value])


def assemble_native_assets(
    template_page: Path, output_file: Path, assets: list[Asset], slots: list[Box], emit: Callable[[dict], None]
) -> None:
    """在单位模板的一页上放入历史原生对象，按源文件分组顺序读取。"""
    with ZipFile(template_page) as template, ZipFile(output_file, "w", compression=ZIP_DEFLATED) as output:
        slide_part, slide = _slide_entry(template, None)
        tree = slide.find("./{*}cSld/{*}spTree")
        if tree is None:
            raise ConversionError("中间稿缺少幻灯片对象树。")
        relation_part = _relationships_part(slide_part)
        links = _xml(template, relation_part) if relation_part in template.NameToInfo else _empty_relationships()
        types = _xml(template, CONTENT_TYPES_NAME)
        reserved = {slide_part, relation_part, CONTENT_TYPES_NAME}
        for entry in template.infolist():
            if entry.filename not in reserved and not entry.is_dir():
                _copy_zip_entry(template, output, entry, entry.filename)

        next_id = max((int(item.attrib["id"]) for item in tree.findall(".//{*}cNvPr")), default=0) + 1
        by_path = {}
        for asset in assets:
            by_path.setdefault(asset.path, []).append(asset)
        shapes = {}
        for path, references in by_path.items():
            if _revision(path) != references[0].revision:
                raise ConversionError(f"「{path.name}」在核对后发生变化，请重新导出。")
            emit({"status": "progress", "stage": "open_source", "done": len(shapes), "total": len(assets), "name": path.name})
            with ZipFile(path) as origin:
                transfer = PartTransfer(origin, output, types)
                pages = {}
                text_contexts = {}
                for asset in references:
                    try:
                        if asset.slide_id not in pages:
                            pages[asset.slide_id] = _slide_entry(origin, asset.slide_id)
                        part, original = pages[asset.slide_id]
                        if etree.QName(original).namespace != etree.QName(slide).namespace:
                            raise ConversionError("源稿与模板的 Open XML 版本不同。请先在 WPS 另存源稿。")
                        shape = _source_shape(original, asset.shape_id, asset.kind)
                        bounds = slots[asset.index]
                        if asset.kind == "text":
                            if part not in text_contexts:
                                text_contexts[part] = read_text_context(origin, part, original)
                            _prepare_text_shape(shape, bounds, text_contexts[part])
                        transfer.chart_text_ratio = _position_shape(shape, bounds, asset.kind)
                        next_id = _rename_shape(shape, asset.output_name, next_id)
                        emit({"status": "progress", "stage": "copy", "done": len(shapes), "total": len(assets), "name": asset.label})
                        transfer.add_shape_relations(shape, part, slide_part, links)
                        shapes[asset.index] = shape
                    except (ConversionError, KeyError, ValueError, OSError, etree.XMLSyntaxError) as error:
                        raise ConversionError(f"无法保留「{asset.label}」的原生对象。\n{error}") from error
            if _revision(path) != references[0].revision:
                raise ConversionError(f"「{path.name}」在复制期间发生变化，请重新导出。")
        for index in sorted(shapes):
            tree.append(shapes[index])
        output.writestr(slide_part, _encoded(slide))
        output.writestr(relation_part, _encoded(links))
        output.writestr(CONTENT_TYPES_NAME, _encoded(types))
