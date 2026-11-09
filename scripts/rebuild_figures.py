"""按结构化蓝图绘制技术图，保留源 DOCX 并另存配图副本。"""

import argparse
from functools import lru_cache
from io import BytesIO
import json
from math import hypot
import os
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt
from PIL import Image, ImageDraw, ImageFont

import figure_style as style

SCALE = style.PIXELS_PER_POINT


@lru_cache
def font(size: float, bold: bool) -> ImageFont.FreeTypeFont:
    font_dir = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    path = font_dir / (style.FONT_BOLD if bold else style.FONT_REGULAR)
    return ImageFont.truetype(str(path), round(size * SCALE))


class Canvas:
    """以印刷点为单位排版，并按固定倍率输出高分辨率 PNG。"""

    def __init__(self, height: int) -> None:
        self.image = Image.new("RGB", (style.BASE_WIDTH * SCALE, height * SCALE), style.PAPER)
        self.draw = ImageDraw.Draw(self.image)

    def rect(
        self, box: tuple, fill: str, border: str | None = None,
        *, radius: float = style.PANEL_RADIUS, stroke: float = style.FRAME_STROKE,
    ) -> None:
        self.draw.rounded_rectangle(
            tuple(round(value * SCALE) for value in box), radius * SCALE,
            fill=fill, outline=border, width=round(stroke * SCALE),
        )

    def line(
        self, points: list[tuple], fill: str = style.LINK, *,
        stroke: float = style.LINK_STROKE, dashed: bool = False,
    ) -> None:
        if not dashed:
            self.draw.line([(round(x * SCALE), round(y * SCALE)) for x, y in points],
                           fill, width=round(stroke * SCALE))
            return
        for (x, y), (end_x, end_y) in zip(points, points[1:]):
            length = hypot(end_x - x, end_y - y)
            if not length:
                continue
            dx, dy = (end_x - x) / length, (end_y - y) / length
            start = 0.0
            while start < length:
                end = min(start + style.DASH_LENGTH, length)
                self.line([(x + start * dx, y + start * dy), (x + end * dx, y + end * dy)],
                          fill, stroke=stroke)
                start += style.DASH_LENGTH + style.DASH_GAP

    def arrow(self, *points: tuple, primary: bool = False, feedback: bool = False) -> None:
        color = style.FEEDBACK if feedback else style.LINK
        stroke = style.PRIMARY_STROKE if primary else style.LINK_STROKE
        self.line(list(points), color, stroke=stroke, dashed=feedback)
        x, y = points[-1]
        prev_x, prev_y = points[-2]
        length = ((x - prev_x) ** 2 + (y - prev_y) ** 2) ** 0.5
        dx, dy = (x - prev_x) / length, (y - prev_y) / length
        head = min(style.PRIMARY_ARROW_HEAD if primary else style.ARROW_HEAD, length)
        half_width = head * style.ARROW_HEAD_WIDTH_RATIO
        tip = [(x, y), (x - head * dx - half_width * dy, y - head * dy + half_width * dx),
               (x - head * dx + half_width * dy, y - head * dy - half_width * dx)]
        self.draw.polygon([(round(a * SCALE), round(b * SCALE)) for a, b in tip], fill=color)

    def text(
        self, box: tuple, text: str, size: float = style.NODE_SIZE,
        *, bold: bool = False, color: str = style.INK,
    ) -> None:
        x1, y1, x2, y2 = box
        face = font(size, bold)
        max_width = (x2 - x1 - 2 * style.TEXT_SIDE_PADDING) * SCALE
        rows = []
        for paragraph in text.split("\n"):
            line = ""
            for char in paragraph:
                candidate = line + char
                if line and face.getlength(candidate) > max_width:
                    rows.append(line.rstrip())
                    line = char.lstrip()
                else:
                    line = candidate
            rows.append(line)
        step = size * style.LINE_HEIGHT
        if len(rows) * step > y2 - y1:
            raise ValueError(f"文本超过版式容量：{text!r}")
        y = (y1 + y2 - (len(rows) - 1) * step) / 2
        for row in rows:
            self.draw.text(((x1 + x2) * SCALE / 2, y * SCALE), row, font=face, fill=color, anchor="mm")
            y += step

    def panel(self, box: tuple, label: str, theme: str, *, logical: bool = False) -> None:
        palette = style.PALETTES[theme]
        x1, y1, x2, y2 = box
        self.rect(box, palette.surface, None if logical else palette.border)
        if logical:
            corners = [(x1, y1), (x2, y1), (x2, y2), (x1, y2), (x1, y1)]
            self.line(corners, palette.border, stroke=style.FRAME_STROKE, dashed=True)
        inset = style.HEADER_INSET
        header = (x1 + inset, y1 + inset, x2 - inset, y1 + style.HEADER_HEIGHT)
        self.rect(header, palette.group)
        self.text(header, label, style.SECTION_SIZE, bold=True, color=palette.heading)

    def card(self, box: tuple, label: str, theme: str = "blue", bold: bool = False) -> None:
        palette = style.PALETTES[theme]
        self.rect(box, palette.node, palette.border, radius=style.NODE_RADIUS, stroke=style.NODE_STROKE)
        self.text(box, label, bold=bold)

    def row(self, box: tuple, labels: list[str], theme: str, *, arrows: bool = False) -> None:
        x1, y1, x2, y2 = box
        gap = style.LINKED_CARD_GAP if arrows else style.CARD_GAP
        width = (x2 - x1 - gap * (len(labels) - 1)) / len(labels)
        for index, label in enumerate(labels):
            left = x1 + index * (width + gap)
            right = left + width
            self.card((left, y1, right, y2), label, theme)
            if arrows and index + 1 < len(labels):
                middle = (y1 + y2) / 2
                self.arrow((right + 1, middle), (right + gap - 1, middle))

    def title(self, title: str, subtitle: str) -> None:
        self.text((6, 3, 444, 23), title, style.TITLE_SIZE, bold=True)
        self.text((6, 24, 444, 40), subtitle, style.NOTE_SIZE, color=style.MUTED)


def architecture(data: dict) -> Canvas:
    """绘制基础支撑、核心模块、场景输出和反馈四层架构。"""
    c = Canvas(334)
    c.title(data["heading"], data["subtitle"])
    for y, name, values, theme in (
        (46, data["sources_title"], data["sources"], "slate"),
        (244, data["outputs_title"], data["outputs"], "teal"),
        (289, data["loop_title"], data["loop"], "blue"),
    ):
        palette = style.PALETTES[theme]
        c.rect((8, y, 442, y + 34), palette.surface, palette.border)
        c.rect((9, y + 1, 74, y + 33), palette.group)
        c.text((10, y + 1, 73, y + 33), name, style.NODE_SIZE, bold=True, color=palette.heading)
        c.row((79, y + 5, 437, y + 29), values, theme, arrows=y == 289)
    c.line([(225, 80), (225, 85)])
    c.line([(56, 85), (394, 85)])
    for x in (56, 225, 394):
        c.arrow((x, 85), (x, 94))
    c.arrow((225, 229), (225, 244))
    c.arrow((225, 278), (225, 289))
    c.panel((8, 94, 104, 229), data["foundation_title"], "blue")
    c.panel((116, 94, 334, 229), data["scenes_title"], "sand")
    c.panel((346, 94, 442, 229), data["assessment_title"], "slate")
    c.arrow((104, 160), (116, 160), primary=True)
    c.arrow((334, 160), (346, 160), primary=True)
    c.arrow((346, 208), (334, 208), feedback=True)
    for left, values, theme in ((8, data["foundation"], "blue"), (346, data["assessment"], "slate")):
        step = 100 / len(values)
        for index, label in enumerate(values):
            top = 122 + index * step
            c.card((left + 4, top, left + 92, top + step - 3), label, theme)
    scene_palette = style.PALETTES["sand"]
    for index, scene in enumerate(data["scenes"]):
        x = 122 + (index % 2) * 105
        y = 123 + (index // 2) * 50
        c.rect((x, y, x + 101, y + 46), scene_palette.node, scene_palette.border,
               radius=style.NODE_RADIUS, stroke=style.NODE_STROKE)
        c.text((x, y + 1, x + 101, y + 27), scene["name"], bold=True)
        c.line([(x + 6, y + 27), (x + 95, y + 27)], scene_palette.border, stroke=style.DIVIDER_STROKE)
        c.text((x, y + 27, x + 101, y + 46), scene["detail"], style.NOTE_SIZE, color=style.MUTED)
    count = len(data["loop"])
    cell = (358 - style.LINKED_CARD_GAP * (count - 1)) / count
    first, last = 79 + cell / 2, 437 - cell / 2
    c.arrow((last, 318), (last, 328), (first, 328), (first, 318), feedback=True)
    return c


def route(data: dict) -> Canvas:
    """绘制三栏路线，处理栏包含筛选、双分支量化和纠偏复核。"""
    c = Canvas(326)
    c.title(data["heading"], data["subtitle"])
    c.panel((8, 48, 91, 309), data["inputs_title"], "blue")
    c.panel((104, 48, 346, 309), data["process_title"], "teal")
    c.panel((359, 48, 442, 309), data["outputs_title"], "sand")
    c.arrow((91, 132), (104, 132), primary=True)
    c.arrow((346, 256), (359, 256), primary=True)
    for left, values, theme in ((8, data["inputs"], "blue"), (359, data["outputs"], "sand")):
        step = 222 / len(values)
        for index, value in enumerate(values):
            y = 79 + index * step
            c.card((left + 6, y, left + 77, y + step - 5), value, theme)

    c.panel((110, 78, 207, 216), data["screening_title"], "teal", logical=True)
    c.panel((217, 78, 340, 216), data["measurement_title"], "teal", logical=True)
    step = 106 / len(data["screening"])
    for index, label in enumerate(data["screening"]):
        y = 106 + index * step
        c.card((115, y, 202, y + step - 7), label, "teal")
        if index + 1 < len(data["screening"]):
            c.arrow((158, y + step - 7), (158, y + step))
    c.arrow((202, 196), (212, 196), (212, 119), (221, 119))
    c.card((221, 106, 336, 132), data["modeling"], "teal")
    for left, label in zip((220, 280), data["branches"], strict=True):
        branch_center = left + 28.5
        c.arrow((278, 132), (278, 136), (branch_center, 136), (branch_center, 140))
        c.card((left, 140, left + 57, 178), label, "teal")
        c.arrow((branch_center, 178), (branch_center, 183), (278, 183), (278, 188))
    c.card((221, 188, 336, 211), data["quantification"], "teal")

    c.arrow((158, 216), (158, 229))
    c.arrow((278, 216), (278, 229))
    c.panel((110, 229, 340, 302), data["correction_title"], "slate", logical=True)
    c.row((115, 257, 335, 282), data["correction"], "slate", arrows=True)
    c.text((113, 283, 337, 301), data["feedback"], style.NOTE_SIZE, color=style.MUTED)
    c.arrow((110, 291), (98, 291), (98, 196), (110, 196), feedback=True)
    return c


def timeline(data: dict) -> Canvas:
    """绘制相对时间泳道、事件关联步骤、融合研判和分类输出。"""
    c = Canvas(357)
    c.title(data["heading"], data["subtitle"])
    time_palette = style.PALETTES["blue"]
    c.rect((8, 47, 442, 184), time_palette.surface, time_palette.border)
    x_start, x_stop = 104, 421
    window_start, window_end = data["window"]

    def x_at(value: float) -> float:
        return x_start + (x_stop - x_start) * value

    step = 107 / len(data["lanes"])
    first_signal = next(i for i, lane in enumerate(data["lanes"]) if lane["window_member"])
    window_top = 66 + step * first_signal
    c.rect((x_at(window_start), window_top, x_at(window_end), 177), time_palette.group, time_palette.border)
    c.text((x_at(window_start), 48, x_at(window_end), 64), data["window_label"], style.NOTE_SIZE, bold=True)
    c.text((x_stop - 12, 49, 442, 65), data["axis_label"], style.NOTE_SIZE, color=style.MUTED)
    for index, lane in enumerate(data["lanes"]):
        y = 67 + step * index
        theme = lane["theme"]
        c.card((13, y, 98, y + step - 2), lane["label"], theme)
        middle = y + (step - 2) / 2
        c.arrow((x_start, middle), (x_stop + 11, middle))
        for start, end in lane["intervals"]:
            half_height = style.SIGNAL_HEIGHT / 2
            c.rect((x_at(start), middle - half_height, x_at(end), middle + half_height),
                   style.PALETTES[theme].signal,
                   radius=style.SIGNAL_RADIUS)

    c.arrow((225, 184), (225, 198))
    c.panel((8, 198, 442, 252), data["association_title"], "teal")
    c.row((13, 226, 437, 247), data["association"], "teal", arrows=True)
    c.arrow((225, 252), (225, 265))
    c.card((8, 265, 442, 288), data["fusion"], "slate", True)
    c.line([(225, 288), (225, 294)])
    c.line([(79, 294), (371, 294)])
    for x in (79, 225, 371):
        c.arrow((x, 294), (x, 301))
    c.row((8, 301, 442, 331), data["results"], "sand")
    c.rect((8, 334, 442, 352), style.PALETTES["slate"].surface)
    c.text((8, 334, 442, 352), data["boundary"], style.NOTE_SIZE, bold=True, color=style.MUTED)
    return c


RENDERERS = {"architecture": architecture, "route": route, "timeline": timeline}
CARD_LIMITS = {
    "architecture": {"sources": (2, 4), "foundation": (2, 6), "scenes": (2, 4),
                     "assessment": (2, 5), "outputs": (2, 4), "loop": (2, 4)},
    "route": {"inputs": (2, 7), "outputs": (2, 7), "screening": (2, 4),
              "branches": (2, 2), "correction": (2, 3)},
    "timeline": {"lanes": (2, 6), "association": (2, 3), "results": (3, 3)},
}


def body_width(document, anchor) -> int:
    """按插图所在节的页宽、页边距和装订线计算版心。"""
    body = document.element.body
    for element in anchor._p.itersiblings():
        sections = element.xpath("./w:pPr/w:sectPr | self::w:sectPr")
        if sections:
            section = sections[0]
            break
    else:
        section = body.sectPr
    return section.page_width - section.left_margin - section.right_margin - (section.gutter or 0)


def rebuild(source: Path, blueprint: Path, output: Path, previews: Path | None) -> None:
    """核对证据和唯一锚点，绘制各图后写入一个新的 DOCX。"""
    if output.suffix.lower() != ".docx" or output.exists() or output.resolve() == source.resolve():
        raise ValueError("输出须为尚不存在的 DOCX 路径")
    document = Document(source)
    plan = json.loads(blueprint.read_text(encoding="utf-8-sig"))
    figures = plan["figures"]
    if plan.get("version") != 1 or not isinstance(figures, list) or not figures:
        raise ValueError("需要版本为 1 且包含至少一张图的蓝图")
    paragraphs = document.paragraphs
    body_text = "\n".join(document.element.body.xpath(".//w:t/text()"))
    flattened_body = "".join(body_text.split())
    style_names = {style.name for style in document.styles}
    used_anchors = set()

    for index, figure in enumerate(figures, 1):
        matches = [p for p in paragraphs if p.text.strip().startswith(figure["anchor"])]
        if len(matches) != 1 or matches[0]._p in used_anchors:
            raise ValueError(f"插图锚点缺失或不唯一：{figure['title']}")
        anchor = matches[0]
        used_anchors.add(anchor._p)
        for evidence in figure["evidence"]:
            if "".join(evidence.split()) not in flattened_body:
                raise ValueError(f"原文中找不到取证片段：{evidence}")

        kind, content = figure["kind"], figure["content"]
        for name, (minimum, maximum) in CARD_LIMITS[kind].items():
            if not minimum <= len(content[name]) <= maximum:
                raise ValueError(f"{figure['title']}的 {name} 需要 {minimum} 至 {maximum} 项")
        if kind == "timeline":
            intervals = [content["window"]]
            membership = [lane["window_member"] for lane in content["lanes"]]
            if not any(membership) or membership != sorted(membership):
                raise ValueError("参与时间窗匹配的泳道须连续排列在背景泳道之后")
            for lane in content["lanes"]:
                intervals.extend(lane["intervals"])
            if any(not 0 <= start < end <= 1 for start, end in intervals):
                raise ValueError("示意时间区间须为从 0 至 1 的递增相对坐标")
        canvas = RENDERERS[kind](content)
        bitmap = BytesIO()
        canvas.image.save(bitmap, format="PNG", dpi=(288, 288))
        if previews is not None:
            previews.mkdir(parents=True, exist_ok=True)
            (previews / f"new-{index:02}.png").write_bytes(bitmap.getvalue())
        bitmap.seek(0)

        picture = document.add_paragraph(style="图片" if "图片" in style_names else None)
        picture.alignment = WD_ALIGN_PARAGRAPH.CENTER
        picture.paragraph_format.first_line_indent = Pt(0)
        picture.paragraph_format.left_indent = Pt(0)
        picture.paragraph_format.right_indent = Pt(0)
        picture.paragraph_format.keep_with_next = True
        picture.paragraph_format.line_spacing = 1.0
        picture.paragraph_format.space_before = Pt(6)
        picture.paragraph_format.space_after = Pt(2)
        picture.add_run().add_picture(bitmap, width=body_width(document, anchor))
        caption_style = next((name for name in ("图名", "Caption") if name in style_names), None)
        caption = document.add_paragraph(figure["title"], style=caption_style)
        caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
        caption.paragraph_format.first_line_indent = Pt(0)
        caption.paragraph_format.keep_with_next = False
        anchor._p.addnext(picture._p)
        picture._p.addnext(caption._p)

    # 独占创建输出文件，避免并发执行时覆盖其他成果。
    serialized = BytesIO()
    document.save(serialized)
    with output.open("xb") as target:
        target.write(serialized.getbuffer())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("blueprint", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--previews", type=Path)
    args = parser.parse_args()
    rebuild(args.source, args.blueprint, args.output, args.previews)
