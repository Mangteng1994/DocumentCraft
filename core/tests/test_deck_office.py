"""覆盖 WPS 单页组汇报验收中发现的兼容边界。"""

import io
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from zipfile import ZipFile

from lxml import etree

from documentcraft.deck_chart import bind_embedded_chart_ranges
from documentcraft.deck_export import Asset, Box, _remove_title_guides, _slots_with_tables
from documentcraft.deck_parts import _position_shape
from documentcraft.deck_preview import find_office_slide
from documentcraft.templates import ConversionError


class DeckOfficeCompatibilityTest(unittest.TestCase):
    def test_missing_slide_from_office_id_lookup_uses_verified_page(self) -> None:
        slides = Mock()
        slides.FindBySlideID.return_value = None
        expected = SimpleNamespace(SlideID=462)
        slides.Item.return_value = expected

        self.assertIs(find_office_slide(slides, 462, 56, RuntimeError), expected)
        slides.Item.assert_called_once_with(56)

    def test_office_slide_number_fallback_refuses_different_id(self) -> None:
        slides = Mock()
        slides.FindBySlideID.return_value = None
        slides.Item.return_value = SimpleNamespace(SlideID=463)

        with self.assertRaises(ConversionError):
            find_office_slide(slides, 462, 56, RuntimeError)



class DeckNativeAssetTest(unittest.TestCase):
    def setUp(self) -> None:
        self.chart = etree.fromstring(b"""<chartSpace xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <chart><ser><val><numRef><f>{11,12}</f><numCache>
            <pt idx="0"><v>11</v></pt><pt idx="1"><v>12</v></pt>
          </numCache></numRef></val></ser></chart><externalData r:id="rId1"/>
        </chartSpace>""")

    def chart_package(self, *, duplicate: bool = False) -> io.BytesIO:
        workbook_data = io.BytesIO()
        with ZipFile(workbook_data, "w") as workbook:
            workbook.writestr(
                "xl/workbook.xml",
                """<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
                    <sheets><sheet name="单位数据" r:id="rId1"/></sheets></workbook>""",
            )
            workbook.writestr(
                "xl/_rels/workbook.xml.rels",
                '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
            )
            extra_first = '<c r="D2"><v>11</v></c>' if duplicate else ""
            extra_second = '<c r="D3"><v>12</v></c>' if duplicate else ""
            worksheet = f"""<worksheet><sheetData>
                <row r="2"><c r="B2"><v>11</v></c>{extra_first}</row>
                <row r="3"><c r="B3"><v>12</v></c>{extra_second}</row>
            </sheetData></worksheet>"""
            workbook.writestr("xl/worksheets/sheet1.xml", worksheet)
        package_data = io.BytesIO()
        with ZipFile(package_data, "w") as package:
            package.writestr("ppt/embeddings/book.xlsx", workbook_data.getvalue())
            package.writestr(
                "ppt/charts/_rels/chart.xml.rels",
                '<Relationships><Relationship Id="rId1" Target="../embeddings/book.xlsx"/></Relationships>',
            )
        return package_data

    def test_literal_chart_data_binds_to_matching_internal_worksheet(self) -> None:
        with self.chart_package() as data, ZipFile(data) as package:
            self.assertTrue(bind_embedded_chart_ranges(package, "ppt/charts/chart.xml", self.chart))

        self.assertEqual(self.chart.findtext(".//f"), "'单位数据'!$B$2:$B$3")
        self.assertEqual([item.text for item in self.chart.findall(".//pt/v")], ["11", "12"])

    def test_literal_chart_does_not_guess_between_two_matching_ranges(self) -> None:
        with self.chart_package(duplicate=True) as data, ZipFile(data) as package:
            with self.assertRaisesRegex(ConversionError, "无法唯一匹配"):
                bind_embedded_chart_ranges(package, "ppt/charts/chart.xml", self.chart)

        self.assertEqual(self.chart.findtext(".//f"), "{11,12}")

    def test_scaling_native_table_preserves_cells_and_keeps_grid_in_frame(self) -> None:
        shape = etree.fromstring(b"""<graphicFrame>
            <xfrm><off x="0" y="0"/><ext cx="2540000" cy="1270000"/></xfrm>
            <graphic><graphicData><tbl>
              <tblGrid><gridCol w="1270000"/><gridCol w="1270000"/></tblGrid>
              <tr h="1270000"><tc><text>v1</text></tc><tc><text>v2</text></tc></tr>
            </tbl></graphicData></graphic>
        </graphicFrame>""")

        _position_shape(shape, Box(0, 0, 100, 50))

        self.assertEqual(shape.find("xfrm/ext").attrib["cx"], "1270000")
        self.assertEqual([s.attrib["w"] for s in shape.findall(".//gridCol")], ["635000", "635000"])
        self.assertEqual(shape.find(".//tr").attrib["h"], "635000")
        self.assertEqual([s.text for s in shape.findall(".//tc/text")], ["v1", "v2"])



class DeckLayoutTest(unittest.TestCase):
    def test_only_clears_sample_title_in_header_and_keeps_logo(self) -> None:
        def make_shape(text: str, top: float) -> Mock:
            shape = Mock(HasTextFrame=True, Left=10, Top=top, Width=100, Height=22)
            shape.TextFrame.TextRange.Text = text
            return shape

        guide = make_shape("章节标题内容", 20)
        logo = make_shape("单位名称", 22)
        lower_guide = make_shape("章节标题内容", 150)
        master = Mock(Count=3)
        master.Item.side_effect = [lower_guide, logo, guide]
        layout = Mock(Count=0)
        slide = SimpleNamespace(Master=SimpleNamespace(Shapes=master), CustomLayout=SimpleNamespace(Shapes=layout))

        self.assertEqual(_remove_title_guides(slide, 405), Box(10, 20, 100, 22))
        guide.Delete.assert_called_once()
        logo.Delete.assert_not_called()
        lower_guide.Delete.assert_not_called()

    def test_mixed_row_keeps_wide_native_table_inside_page(self) -> None:
        assets = [
            Asset(index, Path("旧稿.pptx"), 462, 2, kind, kind, "revision")
            for index, kind in enumerate(("image", "chart", "table"))
        ]
        area = Box(45, 145, 630, 230)
        picture, chart, table = _slots_with_tables(area, assets)

        self.assertEqual(table.left, area.left)
        self.assertEqual(table.width, area.width)
        self.assertLessEqual(picture.left + picture.width, chart.left)
        self.assertLess(picture.top + picture.height, table.top)
        self.assertLessEqual(table.top + table.height, area.top + area.height)
