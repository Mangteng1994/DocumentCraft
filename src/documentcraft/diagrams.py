"""将已验证的技术关系绘制为 PNG。"""

from collections import defaultdict
import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .templates import ConversionError

BOX_WIDTH = 424
BOX_HEIGHT = 80
COLUMN_GAP = 112
ROW_GAP = 40
MARGIN = 40
FONT_SIZE = 27
LINE_WIDTH = 3
ARROW_LENGTH = 16
RETURN_GAP = 22
PALETTE = (
    ("#E4F1FB", "#2D6596"), ("#E7F3E8", "#3B7552"), ("#FAEEDC", "#9C651F"),
    ("#EEE8F8", "#705290"), ("#F6E8EB", "#984F62"), ("#E1F1EF", "#357A74"),
)


def _return_edges(adjacency: list[list[int]]) -> set[tuple[int, int]]:
    """找出指回当前遍历路径的边，单独走回流通道。"""
    visited = set()
    active = set()
    returns = set()
    for root in range(len(adjacency)):
        if root in visited:
            continue
        visited.add(root)
        active.add(root)
        stack = [(root, iter(adjacency[root]))]
        while stack:
            source, targets = stack[-1]
            target = next(targets, None)
            if target is None:
                stack.pop()
                active.remove(source)
            elif target in active:
                returns.add((source, target))
            elif target not in visited:
                visited.add(target)
                active.add(target)
                stack.append((target, iter(adjacency[target])))
    return returns


def render_diagram(diagram: dict, output: Path, colored: bool) -> None:
    """按拓扑层绘图，图中只使用计划里的节点标签。"""
    nodes = diagram["nodes"]
    edges = diagram["edges"]
    adjacency = [[] for _ in nodes]
    for edge in edges:
        adjacency[edge["from"]].append(edge["to"])
    returns = _return_edges(adjacency)
    incoming = [0] * len(nodes)
    outgoing = defaultdict(list)
    for edge in edges:
        source, target = edge["from"], edge["to"]
        if (source, target) not in returns:
            incoming[target] += 1
            outgoing[source].append(target)
    frontier = [index for index, degree in enumerate(incoming) if degree == 0]
    layers = []
    while frontier:
        layers.append(frontier)
        next_layer = []
        for source in frontier:
            for target in outgoing[source]:
                incoming[target] -= 1
                if incoming[target] == 0:
                    next_layer.append(target)
        frontier = next_layer
    rows = max(map(len, layers))
    width = 2 * MARGIN + len(layers) * BOX_WIDTH + (len(layers) - 1) * COLUMN_GAP
    content_bottom = MARGIN + rows * BOX_HEIGHT + (rows - 1) * ROW_GAP
    height = content_bottom + MARGIN + len(returns) * RETURN_GAP
    if width * height > 30_000_000:
        raise ConversionError("图幅过大，需人工确认布局。")
    font_dir = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    font = ImageFont.truetype(str(font_dir / "msyh.ttc"), FONT_SIZE)
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    positions = {}
    for column, layer in enumerate(layers):
        for row, node in enumerate(layer):
            left = MARGIN + column * (BOX_WIDTH + COLUMN_GAP)
            offset = (rows - len(layer)) * (BOX_HEIGHT + ROW_GAP) // 2
            top = MARGIN + offset + row * (BOX_HEIGHT + ROW_GAP)
            positions[node] = (left, top)
    return_count = 0
    for edge in edges:
        x1, y1 = positions[edge["from"]]
        x2, y2 = positions[edge["to"]]
        start = (x1 + BOX_WIDTH, y1 + BOX_HEIGHT // 2)
        end = (x2 - LINE_WIDTH, y2 + BOX_HEIGHT // 2)
        # 连线通过列间走廊走线，避免长跨列线穿过其他节点。
        if (edge["from"], edge["to"]) in returns:
            return_count += 1
            lane = content_bottom + return_count * RETURN_GAP
            start = (x1, y1 + BOX_HEIGHT // 2)
            end = (x2 + BOX_WIDTH + LINE_WIDTH, y2 + BOX_HEIGHT // 2)
            exit_x = start[0] - MARGIN // 2
            entry_x = end[0] + MARGIN // 2
            route = [start, (exit_x, start[1]), (exit_x, lane),
                     (entry_x, lane), (entry_x, end[1]), end]
        elif x2 - start[0] > COLUMN_GAP:
            lane = MARGIN // 2
            route = [start, (start[0] + MARGIN, start[1]),
                     (start[0] + MARGIN, lane), (end[0] - MARGIN, lane),
                     (end[0] - MARGIN, end[1]), end]
        else:
            route = [start, end]
        draw.line(route, fill="black", width=LINE_WIDTH)
        previous = route[-2]
        direction = math.atan2(end[1] - previous[1], end[0] - previous[0])
        wings = [
            (end[0] - ARROW_LENGTH * math.cos(direction + offset),
             end[1] - ARROW_LENGTH * math.sin(direction + offset))
            for offset in (-0.48, 0.48)
        ]
        draw.polygon([end, *wings], fill="black")
    groups = {}
    for index, node in enumerate(nodes):
        group = node["group"]
        fill, outline = "white", "black"
        if colored and group:
            if group not in groups:
                groups[group] = PALETTE[len(groups) % len(PALETTE)]
            fill, outline = groups[group]
        x, y = positions[index]
        draw.rectangle((x, y, x + BOX_WIDTH, y + BOX_HEIGHT), fill=fill, outline=outline, width=LINE_WIDTH)
        draw.text((x + BOX_WIDTH // 2, y + BOX_HEIGHT // 2), node["label"],
                  font=font, fill="black", anchor="mm")
    image.save(output, format="PNG")
