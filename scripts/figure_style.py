"""科研技术图的视觉令牌，尺寸以印刷点为单位。"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Palette:
    """同一语义色的容器、分组、节点和信号层级。"""

    surface: str
    group: str
    node: str
    signal: str
    border: str
    heading: str


PAPER = "#FFFFFF"
INK = "#25313A"
MUTED = "#4F5C65"
LINK = "#48535A"
FEEDBACK = "#626A7E"

# 按功能取色，直接保存白底上的成图 RGB，便于在 Word 和 WPS 中使用。
PALETTES = {
    "blue": Palette("#EBF1F7", "#DCE8F2", "#CDE0F1", "#829FB6", "#778D9E", "#2A4A63"),
    "teal": Palette("#EBF7F4", "#DEF1EB", "#CDEEE6", "#79A99E", "#738F86", "#30534D"),
    "sand": Palette("#FBF4EC", "#FBE9D9", "#F5D7BC", "#BD9A78", "#9D826B", "#624B39"),
    "slate": Palette("#F1EDF7", "#EAE3F4", "#E3DCF2", "#A89BBF", "#887F9D", "#514762"),
}

BASE_WIDTH = 450
PIXELS_PER_POINT = 4
FONT_REGULAR = "msyh.ttc"
FONT_BOLD = "msyhbd.ttc"
TITLE_SIZE = 12
SECTION_SIZE = 10
NODE_SIZE = 9
NOTE_SIZE = 8.5
LINE_HEIGHT = 1.28
TEXT_SIDE_PADDING = 3
CARD_GAP = 5
LINKED_CARD_GAP = 12
HEADER_HEIGHT = 23
HEADER_INSET = 1
PANEL_RADIUS = 1.5
NODE_RADIUS = 1
SIGNAL_RADIUS = 0.5
SIGNAL_HEIGHT = 8
FRAME_STROKE = 0.7
NODE_STROKE = 0.45
DIVIDER_STROKE = 0.45
LINK_STROKE = 0.75
PRIMARY_STROKE = 1.1
ARROW_HEAD = 4.5
PRIMARY_ARROW_HEAD = 6
ARROW_HEAD_WIDTH_RATIO = 0.48
DASH_LENGTH = 3
DASH_GAP = 2
