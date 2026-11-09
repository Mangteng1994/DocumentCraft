"""从 Markdown 正文识别独立图名与表名。"""

import json
import re

NUMBERED_CAPTION = re.compile(r"^([图表])\s*[0-9]+(?:[.．－—–-][0-9]+)*(?:$|[\s:：、])")
TABLE_TITLE_MAX_LENGTH = 50
TABLE_INTRO = re.compile(r"^(?:下表|见下表|详见|参见)|如下$")
SENTENCE_PUNCTUATION = re.compile(r"[。！？；!?;]|[.：:]$")


def _caption_kind(block: dict | None) -> str:
    if block is None or block["t"] not in {"Para", "Plain"}:
        return ""
    pieces = []
    for inline in block["c"]:
        kind = inline["t"]
        if kind == "Str":
            pieces.append(inline["c"])
        elif kind == "Space":
            pieces.append(" ")
        else:
            break
    match = NUMBERED_CAPTION.match("".join(pieces).strip())
    return match[1] if match else ""


def _is_short_table_title(block: dict) -> bool:
    """识别紧邻表格的无编号纯文本短标题。"""
    if block["t"] not in {"Para", "Plain"} or _caption_kind(block):
        return False

    inlines = block["c"]
    if any(inline["t"] not in {"Str", "Space"} for inline in inlines):
        return False
    title = "".join(inline.get("c", " ") for inline in inlines).strip()
    return (
        0 < len(title) <= TABLE_TITLE_MAX_LENGTH
        and not SENTENCE_PUNCTUATION.search(title)
        and not TABLE_INTRO.search(title)
    )


def _table_title_source(blocks: list[dict]) -> list[dict] | None:
    """返回表前候选段落所在的块列表。"""
    if not blocks:
        return None
    previous = blocks[-1]
    if previous["t"] in {"Para", "Plain"}:
        return blocks

    if previous["t"] == "BulletList":
        items = previous["c"]
    elif previous["t"] == "OrderedList":
        items = previous["c"][1]
    else:
        return None

    # 缩进的表名可能被解析为列表末项的第二段，保留该列表项本身。
    if items and len(items[-1]) > 1:
        return items[-1]
    return None


def _image_figure(block: dict) -> dict | None:
    if block["t"] == "Figure":
        attrs, caption, body = block["c"]
        if len(body) != 1 or body[0]["t"] not in {"Plain", "Para"}:
            return None
        inlines = body[0]["c"]
        if len(inlines) != 1 or inlines[0]["t"] != "Image":
            return None
        alternative = inlines[0]["c"][1]
        # Pandoc 的隐式图会复制 alt 到题注。只删除这一类自动题注。
        if caption[0] is None and caption[1] == [{"t": "Plain", "c": alternative}]:
            return {"t": "Figure", "c": [attrs, [None, []], body]}
        return None
    if block["t"] not in {"Para", "Plain"} or not block["c"]:
        return None
    first = block["c"][0]
    if first["t"] != "Image":
        return None
    tail = block["c"][1:]
    caption = []
    if tail:
        if tail[0]["t"] not in {"SoftBreak", "LineBreak"}:
            return None
        line = {"t": "Plain", "c": tail[1:]}
        if _caption_kind(line) != "图":
            return None
        caption.append(line)
    return {"t": "Figure", "c": [["", [], []], [None, caption], [{"t": "Plain", "c": [first]}]]}


def normalize_captions(ast: bytes) -> bytes:
    """将相邻的显式题注交给 Pandoc 的 Figure 和 Table 节点。"""
    document = json.loads(ast)
    blocks = document["blocks"]
    normalized = []
    index = 0
    while index < len(blocks):
        block = blocks[index]
        following = blocks[index + 1] if index + 1 < len(blocks) else None
        figure = _image_figure(block)
        if figure is not None:
            if not figure["c"][1][1] and _caption_kind(following) == "图":
                figure["c"][1][1] = [following]
                index += 1
            block = figure
        if block["t"] == "Table" and not any(block["c"][1]):
            # 显式编号优先于短标题推断。后置题注不能占用下一张表的前置题注。
            before = _table_title_source(normalized)
            next_block = blocks[index + 2] if index + 2 < len(blocks) else None
            if before and _caption_kind(before[-1]) == "表":
                block["c"][1][1] = [before.pop()]
            elif _caption_kind(following) == "表" and (next_block is None or next_block["t"] != "Table"):
                block["c"][1][1] = [following]
                index += 1
            elif before and _is_short_table_title(before[-1]):
                block["c"][1][1] = [before.pop()]
        normalized.append(block)
        index += 1
    document["blocks"] = normalized
    return json.dumps(document, ensure_ascii=False).encode("utf-8")
