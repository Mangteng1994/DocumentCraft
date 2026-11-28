"""读取指定 PPTX 页的素材，并按需生成原页预览。"""

import base64
import hashlib
import json
import os
import posixpath
import zipfile
from collections.abc import Iterator
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Callable
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET

from PIL import Image

from .templates import ConversionError

MAX_XML_BYTES = 32 * 1024 * 1024
PREVIEW_EDGE = 1280
PRESENTATION = "ppt/presentation.xml"
RELATIONSHIP_NAMESPACES = {
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
}
SHAPE_LABELS = {"image": "图片", "chart": "图表", "table": "表格", "group": "组合", "text": "文字"}


def _read_xml(package: zipfile.ZipFile, name: str) -> ET.Element:
    """仅读取有大小上限的 XML 部件，大媒体保留在源文件中。"""
    entry = package.getinfo(name)
    if entry.file_size > MAX_XML_BYTES:
        raise ConversionError("幻灯片 XML 超过读取上限。")
    return ET.fromstring(package.read(entry))


def _relationships_part(part: str) -> str:
    folder, name = posixpath.split(part)
    return posixpath.join(folder, "_rels", name + ".rels")


def _internal_target(part: str, target: str) -> str | None:
    uri = urlsplit(target)
    if uri.scheme or uri.netloc or not uri.path:
        return None
    if uri.path.startswith("/"):
        resolved = posixpath.normpath(uri.path).lstrip("/")
    else:
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(part), uri.path))
    if resolved == ".." or resolved.startswith("../"):
        return None
    return resolved


def _relationships(package: zipfile.ZipFile, part: str) -> dict[str, tuple[str, str | None]]:
    """记录外部链接的地址作为比对信息，预览清单不会访问这些链接。"""
    try:
        root = _read_xml(package, _relationships_part(part))
    except KeyError:
        return {}
    relationships = {}
    for item in root:
        relation_id = item.attrib["Id"]
        target = item.attrib["Target"]
        external = item.get("TargetMode") == "External"
        relationships[relation_id] = (target, None if external else _internal_target(part, target))
    return relationships


def _relationship_ids(element: ET.Element) -> set[str]:
    """收集对象直接引用的包内关系，例如图片、图表、超链接。"""
    ids = set()
    for node in element.iter():
        for name, value in node.attrib.items():
            namespace, _, _ = name.partition("}")
            if namespace.lstrip("{") in RELATIONSHIP_NAMESPACES:
                ids.add(value)
    return ids


def _asset_fingerprint(
    package: zipfile.ZipFile,
    element: ET.Element,
    relationships: dict[str, tuple[str, str | None]],
) -> str:
    """记录形状 XML 和依赖部件的版本。用 ZIP 校验值识别媒体与图表数据替换。"""
    digest = hashlib.sha256(ET.tostring(element))
    pending = []
    for relation_id in sorted(_relationship_ids(element)):
        target = relationships.get(relation_id)
        digest.update(json.dumps([relation_id, target]).encode())
        if target and target[1]:
            pending.append(target[1])
    seen: set[str] = set()
    while pending:
        part = pending.pop()
        if part in seen:
            continue
        seen.add(part)
        info = package.getinfo(part)
        digest.update(json.dumps([part, info.CRC, info.file_size]).encode())
        rel_path = _relationships_part(part)
        if rel_path not in package.NameToInfo:
            continue
        info = package.getinfo(rel_path)
        digest.update(json.dumps([rel_path, info.CRC, info.file_size]).encode())
        nested = sorted(_relationships(package, part).items())
        pending.extend(target for _, (_, target) in nested if target)
    return digest.hexdigest()


def _shape_text(shape: ET.Element) -> str:
    """拼接同一段中的文字片段，并保留段落和手动换行。"""
    paragraphs = []
    for paragraph in shape.findall("./{*}txBody/{*}p"):
        parts = []
        for element in paragraph:
            name = element.tag.rsplit("}", 1)[-1]
            if name == "br":
                parts.append("\n")
            elif name in {"r", "fld"}:
                parts.append(element.findtext("./{*}t", ""))
        paragraphs.append("".join(parts))
    return "\n".join(paragraphs).strip()


def _shape_kind(shape: ET.Element) -> tuple[str, str] | None:
    """识别顶层图片、原生图表、表格、组合和有文字内容的形状。"""
    tag = shape.tag.rsplit("}", 1)[-1]
    if tag == "sp" and _shape_text(shape):
        return "text", "nvSpPr"
    if tag == "pic":
        # 视频也以图片形状存放封面，在此保留给视频复用流程。
        media_tags = {"videoFile", "audioFile", "media", "quickTimeFile"}
        if any(node.tag.rsplit("}", 1)[-1] in media_tags for node in shape.iter()):
            return None
        return "image", "nvPicPr"
    if tag == "grpSp":
        return "group", "nvGrpSpPr"
    if tag == "graphicFrame":
        data = shape.find("./{*}graphic/{*}graphicData")
        if data is None:
            return None
        if data.find("./{*}tbl") is not None:
            return "table", "nvGraphicFramePr"
        if data.find("./{*}chart") is not None:
            return "chart", "nvGraphicFramePr"
    return None


@dataclass(frozen=True)
class TextContext:
    layout: ET.Element | None
    master: ET.Element | None
    theme: ET.Element | None
    color_map: dict[str, str]
    versions: tuple[tuple[str, int, int], ...]


def _related_part(package: zipfile.ZipFile, owner: str, kind: str) -> str | None:
    links = _relationships(package, owner)
    if not links:
        return None
    root = _read_xml(package, _relationships_part(owner))
    for item in root:
        if item.get("Type", "").endswith("/" + kind):
            return links[item.attrib["Id"]][1]
    return None


def read_text_context(package: zipfile.ZipFile, part: str, slide: ET.Element) -> TextContext:
    """读取源页关联的版式、母版和主题，用于定位占位符及恢复文字的源格式。"""
    layout_part = _related_part(package, part, "slideLayout")
    master_part = _related_part(package, layout_part, "slideMaster") if layout_part else None
    theme_part = _related_part(package, master_part, "theme") if master_part else None
    layout = _read_xml(package, layout_part) if layout_part else None
    master = _read_xml(package, master_part) if master_part else None
    theme = _read_xml(package, theme_part) if theme_part else None
    color_map = {}
    master_map = master.find("./{*}clrMap") if master is not None else None
    if master_map is not None:
        color_map.update(master_map.attrib)
    for node in (layout, slide):
        if node is None:
            continue
        override = node.find("./{*}clrMapOvr")
        if override is not None:
            mapping = override.find("./{*}overrideClrMapping")
            if mapping is not None:
                color_map.update(mapping.attrib)
            elif override.find("./{*}masterClrMapping") is not None and master_map is not None:
                color_map = dict(master_map.attrib)
    versions = tuple(
        (entry.filename, entry.CRC, entry.file_size)
        for name in (layout_part, master_part, theme_part)
        if name is not None
        for entry in (package.getinfo(name),)
    )
    return TextContext(layout, master, theme, color_map, versions)


def text_placeholder_defaults(shape: ET.Element, context: TextContext) -> tuple[list[ET.Element], ET.Element | None]:
    """按版式索引和母版类型查找文字默认值，无显式坐标的标题也可用于选材。"""
    path = "./{*}nvSpPr/{*}nvPr/{*}ph"
    source = shape.find(path)
    title_types = {"title", "ctrTitle"}
    shape_type = source.get("type", "obj") if source is not None else "shape"
    inherited = []
    if source is not None and context.layout is not None:
        for candidate in context.layout.findall("./{*}cSld/{*}spTree/{*}sp"):
            placeholder = candidate.find(path)
            if placeholder is not None and placeholder.get("idx", "0") == source.get("idx", "0"):
                inherited.append(candidate)
                shape_type = placeholder.get("type", shape_type)
                break
    style = None
    if context.master is not None:
        body_types = {"body", "obj", "subTitle"}
        level = "titleStyle" if shape_type in title_types else "bodyStyle" if shape_type in body_types else "otherStyle"
        style = context.master.find(f"./{{*}}txStyles/{{*}}{level}")
        parent_types = title_types if level == "titleStyle" else {"body"} if level == "bodyStyle" else {shape_type}
        if source is not None:
            for candidate in context.master.findall("./{*}cSld/{*}spTree/{*}sp"):
                placeholder = candidate.find(path)
                if placeholder is not None and placeholder.get("type", "obj") in parent_types:
                    inherited.append(candidate)
                    break
    return inherited, style


def _shape_bounds(shape: ET.Element, width: int, height: int) -> dict | None:
    """把源页的对象矩形换算成页面比例，供前端叠放可点选的区域。"""
    for path in ("./{*}xfrm", "./{*}spPr/{*}xfrm", "./{*}grpSpPr/{*}xfrm"):
        transform = shape.find(path)
        if transform is not None:
            break
    else:
        return None
    offset = transform.find("./{*}off")
    extent = transform.find("./{*}ext")
    if offset is None or extent is None:
        return None
    bounds = {
        "left": int(offset.attrib["x"]) / width,
        "top": int(offset.attrib["y"]) / height,
        "width": int(extent.attrib["cx"]) / width,
        "height": int(extent.attrib["cy"]) / height,
        "rotation": int(transform.get("rot", "0")) / 60000,
    }
    if bounds["width"] <= 0 or bounds["height"] <= 0:
        return None
    return bounds


def _shape_elements(container: ET.Element) -> Iterator[ET.Element]:
    """展开兼容分支，同一对象只取首个包含可选素材的分支。"""
    for shape in container:
        if shape.tag.rsplit("}", 1)[-1] != "AlternateContent":
            yield shape
            continue
        for branch in shape:
            if any(_shape_kind(item) for item in branch):
                yield from branch
                break


def _chart_title(
    package: zipfile.ZipFile,
    shape: ET.Element,
    relationships: dict[str, tuple[str, str | None]],
) -> str:
    """用图表部件的标题区辅助识别「图表 1」等默认命名的原生图表。"""
    for relation_id in sorted(_relationship_ids(shape)):
        target = relationships.get(relation_id)
        if not target or not target[1] or not target[1].endswith(".xml"):
            continue
        chart = _read_xml(package, target[1])
        title = chart.find(".//{*}chart/{*}title")
        if title is not None:
            fields = {node.tag.rsplit("}", 1)[-1] for node in title.iter() if node.text}
            text_tag = "t" if "t" in fields else "v"
            return " ".join(node.text for node in title.findall(f".//{{*}}{text_tag}") if node.text)
    return ""


def _asset_entries(
    package: zipfile.ZipFile, part: str, slide: ET.Element, width: int, height: int
) -> list[dict]:
    """返回可加入新页的对象及其原始对象 ID。图片裁剪和位置包含在形状指纹内。"""
    tree = slide.find("./{*}cSld/{*}spTree")
    if tree is None:
        raise ConversionError("源幻灯片缺少形状清单。")
    relationships = _relationships(package, part)
    assets = []
    text_context = None
    shape_ids: set[int] = set()
    for shape in _shape_elements(tree):
        kind = _shape_kind(shape)
        if kind is None:
            continue
        asset_type, properties = kind
        identity = shape.find(f"./{{*}}{properties}/{{*}}cNvPr")
        if identity is None or not identity.get("id"):
            continue
        shape_id = int(identity.attrib["id"])
        if shape_id in shape_ids:
            raise ConversionError("源幻灯片包含重复的素材 ID，无法定位对象。")
        shape_ids.add(shape_id)
        labels = (identity.get(key, "").strip() for key in ("descr", "title", "name"))
        name = next((label for label in labels if label), SHAPE_LABELS[asset_type])
        bounds = _shape_bounds(shape, width, height)
        fingerprint = _asset_fingerprint(package, shape, relationships)
        text = " ".join(node.text for node in shape.findall(".//{*}t") if node.text)
        content = None
        if asset_type == "text":
            content = _shape_text(shape)
            text = content
            if text_context is None:
                text_context = read_text_context(package, part, slide)
            if bounds is None:
                parents, _ = text_placeholder_defaults(shape, text_context)
                bounds = next((found for parent in parents if (found := _shape_bounds(parent, width, height))), None)
            style_data = json.dumps([fingerprint, text_context.versions, text_context.color_map], sort_keys=True)
            fingerprint = hashlib.sha256(style_data.encode()).hexdigest()
        elif asset_type == "chart":
            text = _chart_title(package, shape, relationships) or text
        asset = {
            "shape_id": shape_id,
            "kind": asset_type,
            "name": name[:160],
            "summary": " ".join(text.split())[:160],
            "bounds": bounds,
            "fingerprint": fingerprint,
        }
        if content is not None:
            asset["text"] = content
        assets.append(asset)
    return assets


def _read_slide(source: Path, slide_id: int) -> dict:
    """按稳定 ID 选中源页，同时返回当前页码和页面比例。"""
    with zipfile.ZipFile(source) as package:
        presentation = _read_xml(package, PRESENTATION)
        slide_size = presentation.find("./{*}sldSz")
        if slide_size is None:
            raise ConversionError("源演示文稿缺少页面尺寸。")
        width = int(slide_size.attrib["cx"])
        height = int(slide_size.attrib["cy"])
        if width <= 0 or height <= 0:
            raise ConversionError("源演示文稿的页面尺寸无效。")
        slides = presentation.findall("./{*}sldIdLst/{*}sldId")
        for number, entry in enumerate(slides, 1):
            if entry.get("id") != str(slide_id):
                continue
            relationships = _relationships(package, PRESENTATION)
            for namespace in RELATIONSHIP_NAMESPACES:
                relation_id = entry.get(f"{{{namespace}}}id")
                if relation_id:
                    break
            if not relation_id or relation_id not in relationships:
                raise ConversionError("源幻灯片的关联已失效，请刷新搜索。")
            _, part = relationships[relation_id]
            if part is None:
                raise ConversionError("源幻灯片引用了外部文件。")
            slide = _read_xml(package, part)
            return {
                "path": str(source),
                "slide_id": slide_id,
                "number": number,
                "width": width,
                "height": height,
                "assets": _asset_entries(package, part, slide, width, height),
            }
    raise ConversionError("源稿已变动，找不到这张幻灯片。请刷新搜索后再选。")


def _revision(source: Path) -> str:
    stat = source.stat()
    return f"{stat.st_mtime_ns}:{stat.st_size}"


def find_office_slide(slides: Any, slide_id: int, number: int, com_error: type[Exception]) -> Any:
    """定位演示软件中的源页。WPS 可能用空对象表示按 ID 查找失败。"""
    try:
        slide = slides.FindBySlideID(slide_id)
    except (com_error, AttributeError):
        slide = None
    if slide is None:
        slide = slides.Item(number)
    if slide is None or int(slide.SlideID) != slide_id:
        raise ConversionError(f"演示软件打开的第 {number} 页与源幻灯片 ID 不一致。")
    return slide


def _export_png(app: Any, source: Path, slide: dict, directory: Path, com_error: type[Exception]) -> str:
    """只读打开源稿，并按稳定 ID 导出单页。在已打开文稿上只读取已保存版本。"""
    presentations = app.Presentations
    presentation = None
    opened_here = False
    for index in range(1, presentations.Count + 1):
        opened = presentations.Item(index)
        opened_path = os.path.normcase(os.path.realpath(str(opened.FullName)))
        if opened_path == os.path.normcase(str(source)):
            if not opened.Saved:
                raise ConversionError("源稿在演示软件中有未保存修改。保存后可重新生成原页图像。")
            presentation = opened
            break
    try:
        if presentation is None:
            presentation = presentations.Open(str(source), -1, 0, 0)
            opened_here = True
        original = find_office_slide(presentation.Slides, slide["slide_id"], slide["number"], com_error)
        scale = PREVIEW_EDGE / max(slide["width"], slide["height"])
        width = max(1, round(slide["width"] * scale))
        height = max(1, round(slide["height"] * scale))
        destination = directory / "slide.png"
        original.Export(str(destination), "PNG", width, height)
        # WPS 版本之间自动添加扩展名的行为可能不同。只从新建的临时目录读取。
        files = list(directory.glob("*.png"))
        if len(files) != 1:
            raise ConversionError("演示软件没有生成单页 PNG。")
        image_path = files[0]
        with Image.open(image_path) as image:
            if image.format != "PNG" or image.width * image.height > PREVIEW_EDGE ** 2:
                raise ConversionError("演示软件返回了无效的预览尺寸或格式。")
        return base64.b64encode(image_path.read_bytes()).decode("ascii")
    finally:
        # COM 可能复用已有的演示应用实例，避免退出应用或关闭用户自己打开的文稿。
        if opened_here:
            with suppress(com_error):
                presentation.Close()


def _render_slide(source: Path, slide: dict) -> tuple[str | None, str]:
    """优先使用 WPS 演示，失败时尝试本机 PowerPoint。"""
    if os.name != "nt":
        return None, "单页原图需要 Windows 上的 WPS 演示或 PowerPoint。"
    try:
        import pythoncom
        from win32com.client import DispatchEx
    except ImportError:
        return None, "当前 docflow 缺少演示软件自动化组件。"

    warning = "未能生成原页图像。可从素材清单中继续选择。"
    pythoncom.CoInitialize()
    try:
        for program in ("KWPP.Application", "PowerPoint.Application"):
            try:
                app = DispatchEx(program)
                with TemporaryDirectory(prefix="documentcraft-slide-") as folder:
                    return _export_png(app, source, slide, Path(folder), pythoncom.com_error), ""
            except ConversionError as error:
                warning = str(error)
            except (pythoncom.com_error, AttributeError, OSError):
                continue
    finally:
        pythoncom.CoUninitialize()
    return None, warning


def preview_deck_slide(source: Path, slide_id: int, emit: Callable[[dict], None]) -> dict:
    """先返回可选对象，再生成指定页的原图预览。始终保护源 PPTX。"""
    source = source.resolve(strict=True)
    if source.suffix.lower() != ".pptx" or not source.is_file():
        raise ConversionError("请选择 PPTX 文件。")
    revision = _revision(source)
    try:
        slide = _read_slide(source, slide_id)
    except (zipfile.BadZipFile, ET.ParseError, KeyError, RuntimeError) as error:
        raise ConversionError("无法读取此 PPTX 的幻灯片或素材。") from error
    if _revision(source) != revision:
        raise ConversionError("读取期间源稿已变动，请重新选择该页。")
    emit({"status": "assets", **slide, "revision": revision})
    png, warning = _render_slide(source, slide)
    if _revision(source) != revision:
        raise ConversionError("生成预览期间源稿已变动，请重新选择该页。")
    return {"status": "ok", "png": png, "warning": warning}
