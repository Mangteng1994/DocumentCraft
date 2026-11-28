"""让使用常量数组的旧图表能跟随其内嵌工作簿编辑。"""

import math
import re
from dataclasses import dataclass
from zipfile import ZipFile

from lxml import etree

from .deck_preview import MAX_XML_BYTES, _relationship_ids, _relationships
from .templates import ConversionError

NUMBER_CELL = re.compile(r"([A-Z]+)([1-9][0-9]*)")
SIMPLE_SHEET = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*")


@dataclass(frozen=True)
class NumericSheet:
    name: str
    cells: dict[tuple[int, int], float]


def _xml(archive: ZipFile, name: str) -> etree._Element:
    entry = archive.getinfo(name)
    if entry.file_size > MAX_XML_BYTES:
        raise ConversionError("图表工作簿的 XML 部件超过读取上限。")
    parser = etree.XMLParser(resolve_entities=False, no_network=True)
    return etree.fromstring(archive.read(entry), parser)


def _column_number(column: str) -> int:
    value = 0
    for character in column:
        value = value * 26 + ord(character) - ord("A") + 1
    return value


def _cell_address(column: int, row: int) -> str:
    pieces = []
    while column:
        column, digit = divmod(column - 1, 26)
        pieces.append(chr(ord("A") + digit))
    return "$" + "".join(reversed(pieces)) + f"${row}"


def _read_numeric_sheets(package: ZipFile, workbook_part: str) -> list[NumericSheet]:
    """仅提取工作簿的已存数值，不执行公式或读取外部数据。"""
    # 通过 ZipExtFile 读取 ZIP 内的 XLSX，避免在 Python 内存中复制整个工作簿。
    with package.open(workbook_part) as nested, ZipFile(nested) as workbook:
        part = "xl/workbook.xml"
        root = _xml(workbook, part)
        relationships = _relationships(workbook, part)
        sheets = []
        for sheet in root.findall("./{*}sheets/{*}sheet"):
            location = next(
                (relationships[key][1] for key in _relationship_ids(sheet) if key in relationships),
                None,
            )
            if not location:
                continue
            sheet_xml = _xml(workbook, location)
            cells = {}
            for cell in sheet_xml.findall("./{*}sheetData/{*}row/{*}c"):
                value = cell.findtext("./{*}v")
                address = NUMBER_CELL.fullmatch(cell.get("r", ""))
                if address is None or value is None or cell.get("t", "n") != "n":
                    continue
                col, row = address.groups()
                number = float(value)
                if math.isfinite(number):
                    cells[_column_number(col), int(row)] = number
            sheets.append(NumericSheet(sheet.attrib["name"], cells))
    return sheets


def _same_value(candidate: float | None, value: float) -> bool:
    return candidate is not None and math.isclose(candidate, value, rel_tol=1e-12, abs_tol=1e-12)


def _matching_ranges(sheets: list[NumericSheet], values: list[float]) -> set[str]:
    """只接受工作簿中能够顺序重现源系列数据的连续行或列。"""
    ranges = set()
    for sheet in sheets:
        name = sheet.name
        if not SIMPLE_SHEET.fullmatch(name):
            name = "'" + name.replace("'", "''") + "'"
        for (column, row), start in sheet.cells.items():
            if not _same_value(start, values[0]):
                continue
            for dx, dy in ((1, 0), (0, 1)):
                if all(
                    _same_value(sheet.cells.get((column + dx * step, row + dy * step)), value)
                    for step, value in enumerate(values[1:], 1)
                ):
                    first = _cell_address(column, row)
                    last = _cell_address(column + dx * (len(values) - 1), row + dy * (len(values) - 1))
                    ranges.add(f"{name}!{first}" if first == last else f"{name}!{first}:{last}")
    return ranges


def _literal_refs(chart: etree._Element) -> list[tuple[etree._Element, list[float]]]:
    refs = []
    for reference in chart.findall(".//{*}numRef"):
        formula = reference.find("./{*}f")
        if formula is None or not formula.text or not formula.text.strip().startswith("{"):
            continue
        # 内联数组的现有缓存才是显示在图表上的数据。按索引核对，避免默默跳过缺失值。
        points = reference.findall("./{*}numCache/{*}pt")
        ordered = sorted(points, key=lambda point: int(point.attrib["idx"]))
        indexes = [int(point.attrib["idx"]) for point in ordered]
        if not ordered or indexes != list(range(len(ordered))):
            raise ConversionError("图表的固定系列值缺少完整的数字缓存，无法安全绑定到内嵌工作簿。")
        values = [float(point.findtext("./{*}v", "")) for point in ordered]
        refs.append((formula, values))
    return refs


def bind_embedded_chart_ranges(package: ZipFile, chart_part: str, chart: etree._Element) -> bool:
    """仅当原系列值在内嵌工作簿中能唯一定位时，将固定数组改成可编辑区域。"""
    literal = _literal_refs(chart)
    if not literal:
        return False
    relationships = _relationships(package, chart_part)
    workbook = next(
        (
            relationships[key][1]
            for data in chart.findall(".//{*}externalData")
            for key in _relationship_ids(data)
            if key in relationships and relationships[key][1] is not None
        ),
        None,
    )
    if not workbook or not workbook.lower().endswith((".xlsx", ".xlsm")):
        raise ConversionError("固定系列值没有可用于编辑的内嵌 XLSX 工作簿。")
    sheets = _read_numeric_sheets(package, workbook)
    for formula, values in literal:
        ranges = _matching_ranges(sheets, values)
        if len(ranges) != 1:
            raise ConversionError("图表的固定系列值无法唯一匹配内嵌工作簿。请先在旧稿中绑定正确数据区。")
        formula.text = next(iter(ranges))
    return True
