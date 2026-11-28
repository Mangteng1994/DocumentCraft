"""在单位 PPTX 模板中生成单页，原生复制历史素材并保护已有文件。"""

import math
import os
import shutil
import zipfile
from collections import Counter
from contextlib import suppress
from dataclasses import dataclass, replace
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Callable, Iterator
from xml.etree import ElementTree as ET

from lxml import etree

from .converter import MARKDOWN_FORMAT, find_pandoc, run_pandoc
from .deck_preview import (
    PRESENTATION,
    _read_slide,
    _read_xml,
    _relationship_ids,
    _relationships,
    _relationships_part,
    _revision,
    _shape_elements,
    _shape_kind,
)
from .deck_parts import assemble_native_assets
from .templates import ConversionError

TITLE_TYPES = {1, 3, 5}
BODY_TYPES = {2, 4, 6, 7, 17}
ASSET_TYPES = {2, 6, 7, 8, 9, 12, 17, 18}
PPTX_FILE_FORMAT = 24
TRUE = -1
FALSE = 0
HORIZONTAL_TEXT = 1
ALIGN_CENTER = 2
TITLE_GUIDES = {"章节标题内容", "章节标题", "请输入标题", "在此处输入标题", "添加标题"}
TITLE_NAME = "DocumentCraft title"
BODY_NAME = "DocumentCraft body"


@dataclass(frozen=True)
class Asset:
    index: int
    path: Path
    slide_id: int
    shape_id: int
    kind: str
    label: str
    revision: str
    source_box: "Box | None" = None

    @property
    def output_name(self) -> str:
        return f"DocumentCraft asset {self.index + 1}"


@dataclass(frozen=True)
class Box:
    left: float
    top: float
    width: float
    height: float

    @property
    def area(self) -> float:
        return self.width * self.height


def _resolve_pptx(path: Path) -> Path:
    path = path.resolve(strict=True)
    if path.suffix.lower() != ".pptx" or not path.is_file():
        raise ConversionError(f"需要 PPTX 文件：{path}")
    return path


def _resolve_assets(references: list[dict]) -> list[Asset]:
    """按当前源页及指纹核对引用。页序或其他页变动时，仍可使用未改变的对象。"""
    snapshots = {}
    assets = []
    for index, ref in enumerate(references):
        if not isinstance(ref, dict):
            raise ConversionError("草稿包含无效的素材引用。")
        name = str(ref.get("name") or f"素材 {index + 1}")
        file = ref.get("path")
        slide_id = ref.get("slideId")
        shape_id = ref.get("shapeId")
        if not isinstance(file, str) or not file or type(slide_id) is not int or type(shape_id) is not int:
            raise ConversionError(f"「{name}」缺少有效的来源文件、幻灯片或对象 ID。")
        label = f"{Path(file).name} · 第 {ref.get('pageNumber', '？')} 页 · {name}"
        try:
            path = _resolve_pptx(Path(file))
            key = (path, slide_id)
            if key not in snapshots:
                revision = _revision(path)
                slide = _read_slide(path, slide_id)
                if _revision(path) != revision:
                    raise ConversionError("核对期间源文件发生变化。")
                shapes = {item["shape_id"]: item for item in slide["assets"]}
                snapshots[key] = (revision, shapes, slide["width"], slide["height"])
            revision, shapes, width, height = snapshots[key]
        except (ConversionError, OSError, ValueError, KeyError, RuntimeError, zipfile.BadZipFile, ET.ParseError) as error:
            raise ConversionError(f"无法核对「{label}」。请在草稿中查看来源并重新选取。\n{error}") from error
        match = shapes.get(shape_id)
        if match is None or match["fingerprint"] != ref.get("fingerprint") or match["kind"] != ref.get("kind"):
            raise ConversionError(f"「{label}」已改变或找不到。请在草稿中查看来源并重新选取后导出。")
        bounds = match["bounds"]
        source_box = None
        if bounds:
            angle = math.radians(bounds["rotation"])
            w = bounds["width"] * width
            h = bounds["height"] * height
            visible_w = abs(w * math.cos(angle)) + abs(h * math.sin(angle))
            visible_h = abs(w * math.sin(angle)) + abs(h * math.cos(angle))
            source_box = Box(bounds["left"] * width + (w - visible_w) / 2,
                             bounds["top"] * height + (h - visible_h) / 2, visible_w, visible_h)
        assets.append(Asset(index, path, slide_id, shape_id, match["kind"], label, revision, source_box))
    return assets


def _items(collection: Any) -> Iterator[Any]:
    for index in range(1, int(collection.Count) + 1):
        yield collection.Item(index)


def _box(shape: Any) -> Box:
    return Box(float(shape.Left), float(shape.Top), float(shape.Width), float(shape.Height))


def _placeholders(shapes: Any, types: set[int], *, require_bounds: bool = True) -> list[Any]:
    placeholders = []
    for shape in _items(shapes.Placeholders):
        if int(shape.PlaceholderFormat.Type) not in types:
            continue
        if not require_bounds or _box(shape).area > 0:
            placeholders.append(shape)
    return placeholders


def _overlaps(first: Box, second: Box) -> bool:
    return (
        first.left < second.left + second.width
        and second.left < first.left + first.width
        and first.top < second.top + second.height
        and second.top < first.top + first.height
    )


def _choose_layout(document: Any, has_title: bool, has_body: bool, asset_count: int) -> Any:
    """优先选含所需占位符的实际版式。纯自定义模板也应当沿用单位版式。"""
    best_score = None
    chosen = None
    for design in _items(document.Designs):
        for layout in _items(design.SlideMaster.CustomLayouts):
            titles = _placeholders(layout.Shapes, TITLE_TYPES, require_bounds=False)
            body = _placeholders(layout.Shapes, BODY_TYPES, require_bounds=False)
            slots = _placeholders(layout.Shapes, ASSET_TYPES, require_bounds=False)
            name = str(layout.Name).strip().casefold()
            content_layout = name in {"标题和内容", "title and content", "内容", "content"}
            missing_text = int(has_title and not titles) + int(has_body and not body)
            missing_slots = bool(asset_count and not slots)
            largest = max((slot.area for slot in map(_box, slots)), default=0)
            separate = min(len(slots), asset_count + int(has_body))
            score = (-missing_text, not missing_slots, separate, content_layout, largest)
            if missing_text and content_layout:
                score = (-missing_text, True, separate, content_layout, largest)
            if best_score is None or score > best_score:
                best_score = score
                chosen = layout
    if chosen is None:
        raise ConversionError("单位模板中找不到可用的幻灯片版式。")
    return chosen


def _grid(region: Box, count: int) -> list[Box]:
    """在内容占位区域内均匀安放多份素材，留出对象之间的间隔。"""
    columns = min(count, math.ceil(math.sqrt(count)), 3)
    rows = math.ceil(count / columns)
    gap = min(region.width, region.height) / 40
    width = (region.width - (columns - 1) * gap) / columns
    height = (region.height - (rows - 1) * gap) / rows
    return [
        Box(region.left + column * (width + gap), region.top + row * (height + gap), width, height)
        for row, column in (divmod(index, columns) for index in range(count))
    ]


def _material_slots(regions: list[Box], count: int) -> list[Box]:
    """优先一处放一个素材，额外素材分配给剩余空间最大的区域。"""
    if len(regions) >= count:
        return regions[:count]
    counts = [1] * len(regions)
    for _ in range(count - len(regions)):
        largest = max(range(len(regions)), key=lambda index: regions[index].area / (counts[index] + 1))
        counts[largest] += 1
    return [slot for region, number in zip(regions, counts) for slot in _grid(region, number)]


def _write_text(shape: Any, text: str, com_error: type[Exception], *, body: bool = False) -> None:
    """写入原生文本，占位符继续从版式继承文字样式。"""
    frame = shape.TextFrame
    frame.WordWrap = TRUE
    frame.AutoSize = FALSE
    text_range = frame.TextRange
    text_range.Text = text.replace("\r\n", "\n").replace("\n", "\r")
    shape.Name = BODY_NAME if body else TITLE_NAME
    if body:
        # Pandoc 的纯文本输出已包含列表标记，避免模板再叠加一层项目符号。
        with suppress(com_error, AttributeError):
            text_range.ParagraphFormat.Bullet.Visible = FALSE
    with suppress(com_error, AttributeError):
        shape.TextFrame2.AutoSize = 2


def _new_textbox(slide: Any, bounds: Box, font_size: float) -> Any:
    """当单位版式用固定形状排版时，在版心补一个继承主题的可编辑文本框。"""
    shape = slide.Shapes.AddTextbox(HORIZONTAL_TEXT, bounds.left, bounds.top, bounds.width, bounds.height)
    shape.TextFrame.AutoSize = FALSE
    shape.TextFrame.TextRange.Font.Size = round(font_size)
    shape.Width = bounds.width
    shape.Height = bounds.height
    return shape


def _remove_title_guides(slide: Any, height: float) -> Box | None:
    """去掉本次模板副本内占据页眉位置的示例标题，保留其余母版形状。"""
    guide = None
    for collection in (slide.CustomLayout.Shapes, slide.Master.Shapes):
        for index in range(int(collection.Count), 0, -1):
            item = collection.Item(index)
            if not item.HasTextFrame:
                continue
            text = str(item.TextFrame.TextRange.Text).strip()
            if text not in TITLE_GUIDES or not 0 <= float(item.Top) <= height * 0.20:
                continue
            if guide is None:
                guide = _box(item)
            item.Delete()
    return guide


def _slots_with_tables(area: Box, assets: list[Asset]) -> list[Box]:
    """为含多列的原生表格预留整行，其余对象放在上一行。"""
    tables = [asset.index for asset in assets if asset.kind == "table"]
    others = [asset.index for asset in assets if asset.kind != "table"]
    if not tables:
        return _grid(area, len(assets))
    height = area.height
    gap = height / 30
    top_height = (height - gap) * 0.49 if others else 0
    table_top = area.top + top_height + (gap if others else 0)
    table_area = area.top + height - table_top
    table_height = (table_area - (len(tables) - 1) * gap) / len(tables)
    by_index = {}
    if others:
        top_area = Box(area.left, area.top, area.width, top_height)
        by_index.update(zip(others, _grid(top_area, len(others))))
    for row, index in enumerate(tables):
        top = table_top + row * (table_height + gap)
        by_index[index] = Box(area.left, top, area.width, table_height)
    return [by_index[index] for index in range(len(assets))]


def _layout_slide(document: Any, title: str, body: str, assets: list[Asset], com_error: type[Exception]) -> tuple[Any, str, list[Box]]:
    """用模板的真实版式新建一页，同时分配正文和素材的空间。"""
    groups = {}
    for asset in assets:
        key = (asset.path, asset.slide_id, None if asset.source_box else asset.index)
        groups.setdefault(key, []).append(asset)
    blocks = list(groups.values())
    # 每个来源页只占一个区域，组内保留旧稿的相对构图。
    representatives = [
        replace(next((item for item in block if item.kind == "table"), block[0]), index=index)
        for index, block in enumerate(blocks)
    ]
    count = len(blocks)
    layout = _choose_layout(document, bool(title), bool(body), count)
    name = str(layout.Name)
    slide = document.Slides.AddSlide(1, layout)
    for index in range(int(document.Slides.Count), 1, -1):
        document.Slides.Item(index).Delete()

    width = float(document.PageSetup.SlideWidth)
    height = float(document.PageSetup.SlideHeight)
    margin = width * 0.06
    content_width = width - margin * 2
    title_box = None
    if title:
        guide = _remove_title_guides(slide, height)
        titles = _placeholders(slide.Shapes, TITLE_TYPES)
        if titles:
            title_shape = titles[0]
        else:
            top = guide.top if guide is not None else height * 0.075
            title_region = Box(margin, top, content_width, height * 0.12)
            title_shape = _new_textbox(slide, title_region, height * 0.05)
        _write_text(title_shape, title, com_error)
        if guide is not None:
            title_shape.TextFrame.TextRange.ParagraphFormat.Alignment = ALIGN_CENTER
        title_box = _box(title_shape)
    content_top = height * 0.09
    if title_box is not None:
        content_top = max(height * 0.22, title_box.top + title_box.height + height * 0.025)
    content_area = Box(margin, content_top, content_width, height * 0.93 - content_top)
    body_shape = None
    body_box = None
    if body:
        bodies = _placeholders(slide.Shapes, BODY_TYPES)
        bodies = [shape for shape in bodies if title_box is None or not _overlaps(title_box, _box(shape))]
        if bodies:
            body_shape = bodies[0]
        elif content_area.height > 0:
            body_shape = _new_textbox(slide, content_area, height * 0.034)
        else:
            raise ConversionError(f"模板版式「{name}」没有足够的正文区域。")
        body_box = _box(body_shape)
    slot_boxes = []
    for shape in _placeholders(slide.Shapes, ASSET_TYPES):
        bounds = _box(shape)
        if title_box is not None and _overlaps(title_box, bounds):
            continue
        if body_box is not None and _overlaps(body_box, bounds):
            continue
        if all(not _overlaps(bounds, other) for other in slot_boxes):
            slot_boxes.append(bounds)
    slot_boxes.sort(key=lambda slot: (slot.top, slot.left))

    slots = _material_slots(slot_boxes, count) if count and slot_boxes else []
    needs_table_row = any(asset.kind == "table" for asset in assets)
    if count and (needs_table_row or not slots or any(min(slot.width, slot.height) < 36 for slot in slots)):
        slots = _slots_with_tables(content_area, representatives) if content_area.height > 0 else []
        if content_area.height > 0 and body_shape is not None:
            # 保留真实版式；当素材区域不足时用整个版心重新分配正文和素材的位置。
            body_shape.TextFrame.AutoSize = FALSE
            lines = len(body.splitlines())
            body_height = min(content_area.height * 0.32, height * (0.047 * lines + 0.025))
            gap = content_area.height / 20
            body_shape.Left = content_area.left
            body_shape.Top = content_area.top
            body_shape.Width = content_area.width
            body_shape.Height = body_height
            area = Box(
                content_area.left, content_area.top + body_height + gap,
                content_area.width, content_area.height - body_height - gap,
            )
            slots = _slots_with_tables(area, representatives)
    if count and not slots:
        raise ConversionError(f"模板版式「{name}」没有能放下所选素材的独立区域。")
    if body_shape is not None:
        _write_text(body_shape, body, com_error, body=True)
    if any(min(slot.width, slot.height) < 36 for slot in slots):
        raise ConversionError(f"模板版式「{name}」的素材区域过小。请减少这张草稿页上的素材。")
    # WPS 编辑视图会显示空占位符的提示文字；零尺寸占位符会把提示挤到左侧。
    for index in range(int(slide.Shapes.Count), 0, -1):
        shape = slide.Shapes.Item(index)
        if int(shape.Type) == 14 and str(shape.Name) not in {TITLE_NAME, BODY_NAME}:
            if int(shape.PlaceholderFormat.Type) in TITLE_TYPES | BODY_TYPES | ASSET_TYPES:
                shape.Delete()
    arranged = [Box(0, 0, 0, 0)] * len(assets)
    for block, region in zip(blocks, slots):
        if len(block) == 1:
            arranged[block[0].index] = region
            continue
        left = min(item.source_box.left for item in block)
        top = min(item.source_box.top for item in block)
        width = max(item.source_box.left + item.source_box.width for item in block) - left
        height = max(item.source_box.top + item.source_box.height for item in block) - top
        scale = min(region.width / width, region.height / height)
        x = region.left + (region.width - width * scale) / 2
        y = region.top + (region.height - height * scale) / 2
        for item in block:
            box = item.source_box
            arranged[item.index] = Box(x + (box.left - left) * scale, y + (box.top - top) * scale,
                                       box.width * scale, box.height * scale)
    return slide, name, arranged


def _validate_chart(package: zipfile.ZipFile, slide_part: str, shape: ET.Element) -> None:
    """验证原生图表携带可随文件交付的数据工作簿。"""
    slide_relationships = _relationships(package, slide_part)
    chart = shape.find(".//{*}chart")
    if chart is not None:
        for connection in _relationship_ids(chart):
            target = slide_relationships.get(connection)
            if not target or not target[1]:
                continue
            chart_part = target[1]
            chart_xml = _read_xml(package, chart_part)
            chart_relationships = _relationships(package, chart_part)
            for data in chart_xml.findall(".//{*}externalData"):
                for data_id in _relationship_ids(data):
                    book = chart_relationships.get(data_id)
                    if book and book[1] and book[1].lower().endswith((".xlsx", ".xlsm", ".xlsb", ".xls")):
                        if package.getinfo(book[1]).file_size > 0:
                            return
    raise ConversionError("原生图表缺少可编辑的内嵌数据工作簿。请先将旧图表的数据嵌入旧稿，再重新选取。")


def _check_result(staged: Path, assets: list[Asset], title: str, body: str) -> None:
    """保存后检查实际 PPTX 的单页关系和对象类型，通过后才发布成品。"""
    with zipfile.ZipFile(staged) as package:
        presentation = _read_xml(package, PRESENTATION)
        slides = presentation.findall("./{*}sldIdLst/{*}sldId")
        if len(slides) != 1:
            raise ConversionError("导出文件应当只包含当前草稿页。")
        relations = _relationships(package, PRESENTATION)
        source = next((relations[key][1] for key in _relationship_ids(slides[0]) if key in relations), None)
        if not source:
            raise ConversionError("导出文件缺少草稿页关系。")
        slide = _read_xml(package, source)
        tree = slide.find("./{*}cSld/{*}spTree")
        if tree is None:
            raise ConversionError("导出文件缺少草稿页内容。")
        relation_xml = _read_xml(package, _relationships_part(source))
        layout_id = next((entry.get("Id") for entry in relation_xml if entry.get("Type", "").endswith("/slideLayout")), None)
        _, layout_part = _relationships(package, source).get(layout_id, ("", None))
        if not layout_part or _read_xml(package, layout_part).tag.rsplit("}", 1)[-1] != "sldLayout":
            raise ConversionError("已保存的草稿页缺少单位模板版式。")
        text_shapes = {}
        for shape in tree.findall("./{*}sp"):
            metadata = shape.find("./{*}nvSpPr/{*}cNvPr")
            text_runs = shape.findall("./{*}txBody/{*}p/{*}r/{*}t")
            if metadata is not None:
                text_shapes[metadata.get("name")] = "".join(run.text or "" for run in text_runs)
        if (title and not text_shapes.get(TITLE_NAME)) or (body and not text_shapes.get(BODY_NAME)):
            raise ConversionError("已保存的 PPTX 缺少可编辑的新页文本。")
        matching = {}
        for shape in _shape_elements(tree):
            detected = _shape_kind(shape)
            if detected is None:
                continue
            kind, properties = detected
            metadata = shape.find(f"./{{*}}{properties}/{{*}}cNvPr")
            if metadata is not None:
                matching[metadata.get("name")] = (shape, kind)
        for asset in assets:
            match = matching.get(asset.output_name)
            if not match or match[1] != asset.kind:
                raise ConversionError(f"已保存文件中的「{asset.label}」未保留原生对象。")
            if asset.kind == "chart":
                try:
                    _validate_chart(package, source, match[0])
                except ConversionError as error:
                    raise ConversionError(f"「{asset.label}」：{error}") from error


def _make_template_page(
    template: Path, directory: Path, title: str, body: str, assets: list[Asset], emit: Callable[[dict], None]
) -> tuple[Path, str, str, list[Box]]:
    """用 WPS 或 PowerPoint 生成单位版式与正文。源稿素材由封装程序独立读取。"""
    try:
        import pythoncom
        from win32com.client import DispatchEx
    except ImportError as error:
        raise ConversionError("当前 docflow 缺少演示软件自动化组件。") from error
    errors = []
    pythoncom.CoInitialize()
    try:
        for index, (program, label) in enumerate((
            ("KWPP.Application", "WPS 演示"), ("PowerPoint.Application", "PowerPoint"),
        )):
            app = None
            document = None
            try:
                app = DispatchEx(program)
                working = directory / f"template-{index}.pptx"
                base = directory / f"base-{index}.pptx"
                shutil.copyfile(template, working)
                emit({"status": "progress", "stage": "layout", "done": 0, "total": len(assets)})
                document = app.Presentations.Open(str(working), FALSE, FALSE, FALSE)
                _, layout, slots = _layout_slide(document, title, body, assets, pythoncom.com_error)
                document.SaveAs(str(base), PPTX_FILE_FORMAT)
                return base, layout, label, slots
            except (ConversionError, pythoncom.com_error, AttributeError, OSError, ValueError) as error:
                errors.append(f"{label}：{error}")
            finally:
                if document is not None:
                    with suppress(pythoncom.com_error):
                        document.Saved = TRUE
                    with suppress(pythoncom.com_error):
                        document.Close()
                document = None
                app = None
    finally:
        pythoncom.CoUninitialize()
    raise ConversionError("无法使用单位模板生成可编辑的幻灯片。\n" + "\n".join(errors))


def export_deck(
    template: Path, output: Path, payload: dict, emit: Callable[[dict], None]
) -> dict:
    """从单位模板生成单页 PPTX，拒绝覆盖任何已有路径。"""
    template = _resolve_pptx(template)
    output = output.absolute()
    if output.suffix.lower() != ".pptx" or not output.parent.is_dir():
        raise ConversionError("请选择有效的 PPTX 保存路径。")
    if os.path.lexists(output):
        raise ConversionError(f"输出已存在，请选择新文件名：{output}")
    title = payload.get("title", "")
    markdown = payload.get("markdown", "")
    references = payload.get("assets", [])
    if not isinstance(title, str) or not isinstance(markdown, str) or not isinstance(references, list):
        raise ConversionError("草稿数据格式无效。")
    title = " ".join(title.split())
    if not title and not markdown.strip() and not references:
        raise ConversionError("请先写入新页内容或选择素材。")
    if os.name != "nt":
        raise ConversionError("原生 PPTX 导出需要 Windows 上的 WPS 演示或 PowerPoint。")
    emit({"status": "progress", "stage": "resolve", "done": 0, "total": len(references)})
    assets = _resolve_assets(references)
    body = ""
    if markdown.strip():
        text = run_pandoc(
            find_pandoc(), template.parent, "--from", MARKDOWN_FORMAT,
            "--to", "plain", "--wrap=none", data=markdown.encode("utf-8"),
        )
        body = text.decode("utf-8").strip()
    if not title and not body and not assets:
        raise ConversionError("草稿中没有可以导出的内容。")

    with TemporaryDirectory(prefix=".documentcraft-deck-", dir=output.parent) as folder:
        directory = Path(folder)
        base, layout, engine, slots = _make_template_page(template, directory, title, body, assets, emit)
        staged = directory / "deck.pptx"
        try:
            assemble_native_assets(base, staged, assets, slots, emit)
            emit({"status": "progress", "stage": "verify", "done": len(assets), "total": len(assets)})
            _check_result(staged, assets, title, body)
        except (zipfile.BadZipFile, ET.ParseError, etree.XMLSyntaxError, KeyError, ValueError) as error:
            raise ConversionError(f"无法封装或核对 PPTX：{error}") from error
        try:
            # Windows 的 rename 在目标已存在时失败。临时稿与目标同目录，保留已有定稿。
            os.rename(staged, output)
        except FileExistsError as error:
            raise ConversionError(f"输出已存在，请选择新文件名：{output}") from error
    counts = dict(Counter(asset.kind for asset in assets))
    return {"status": "ok", "output": str(output), "layout": layout, "engine": engine, "counts": counts, "warnings": []}
