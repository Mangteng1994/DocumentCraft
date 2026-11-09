"""通过安装后的 CLI 验证 DOCX 转换契约。"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml import parse_xml
from docx.shared import Cm, Pt


MARKDOWN = """# 试验结果 {#results}

中文 **正文** 和 [外部链接](https://example.org)。

1. 一级列表
   - 二级列表

| 项目 | 结果 |
| --- | --- |
| 承载力 | 通过 |

![样例图](assets/sample%20image.png){width=4cm}

图 1 试验示意

## 计算方法

$E = mc^2$

```python
result = 42
```

[返回结果](#results)
"""
# 使用可见的蓝色几何图形，方便同时检查嵌入资源和实际渲染。
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAKAAAAAwCAIAAAAZy+Y5AAAAx0lEQVR4nO3RSw3CUBQA0QpCFLLqDAlY"
    "YIkFPm3yeucks5zd2W73XYPbPvwez5cu1xfApK/YL8CkL9RfwKTX7xhg0st2MDDp1ToLmPQinQ5MugJM"
    "ugJMugJMugJMugJMugJMugJMugJMugJMugJMugJMugJMugJMugJMugKclc4B16S7wBFpwMOlAQ+XBjxc"
    "GvBwacDDpQEPlwY8XBrwcGnAw6UBD5cGPFwa8HBpwMOlAQ+XBrxKgCsBrgS4EuBKgCsBrgRY+xtaX2G"
    "vDeAJEwAAAABJRU5ErkJggg=="
)


def make_fixture(directory: Path, anchor: str) -> tuple[Path, Path, Path]:
    """创建带中文路径的 Markdown、图像与可选正文锚点模板。"""
    assets = directory / "资料目录" / "assets"
    assets.mkdir(parents=True)
    (assets / "sample image.png").write_bytes(PNG)
    source = assets.parent / "试验 报告.md"
    source.write_text(MARKDOWN, encoding="utf-8")

    template = Document()
    template.styles["Heading 1"].font.size = Pt(23)
    template.sections[0].left_margin = Cm(3.2)
    template.sections[0].header.paragraphs[0].text = "研究报告页眉"
    template.sections[0].footer.paragraphs[0].text = "研究报告页脚"
    template.add_paragraph("固定封面")
    if anchor:
        template.add_section(WD_SECTION.NEW_PAGE)
        template.sections[-1].left_margin = Cm(2.8)
        paragraph = template.add_paragraph()
        if anchor == "bookmark":
            start = OxmlElement("w:bookmarkStart")
            start.set(qn("w:name"), "DOCFLOW_CONTENT")
            start.set(qn("w:id"), "1")
            end = OxmlElement("w:bookmarkEnd")
            end.set(qn("w:id"), "1")
            paragraph._p.extend([start, end])
        else:
            paragraph.add_run("{{DOCFLOW_")
            paragraph.add_run("CONTENT}}")
        template.add_paragraph("固定附录")
    template_path = directory / "研究 模板.docx"
    template.save(template_path)
    return source, template_path, directory / "输出 报告.docx"


class ConversionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def cli(self, source, template, output, *options, status=0):
        executable = os.environ.get("DOCUMENTCRAFT_TEST_EXE")
        command = Path(executable).resolve() if executable else Path(sys.executable).with_name(
            "docflow.exe" if sys.platform == "win32" else "docflow"
        )
        environment = os.environ.copy()
        if executable:
            environment["PATH"] = ""
            environment.pop("PYTHONPATH", None)
            environment.pop("PYTHONHOME", None)
        result = subprocess.run(
            [command, "md-to-word", "--input", source, "--template", template,
             "--output", output, "--json", *options],
            cwd=self.directory, env=environment, capture_output=True, text=True, encoding="utf-8", check=False,
        )
        self.assertEqual(result.returncode, status, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout)

    def assert_content(self, document):
        body = document.element.body
        text = body.xpath(".//w:t/text()")
        self.assertLess(text.index("试验结果"), text.index("承载力"))
        self.assertLess(text.index("承载力"), text.index("计算方法"))
        self.assertEqual(document.styles["Heading 1"].font.size, Pt(23))
        self.assertEqual(document.tables[0].cell(1, 0).text, "承载力")
        self.assertEqual(len(document.inline_shapes), 1)
        self.assertTrue(body.xpath(".//m:oMath"))
        self.assertGreaterEqual(len(body.xpath(".//w:numPr")), 2)
        self.assertIn("result = 42", "".join(text))
        self.assertIn("二级列表", text)
        self.assertEqual(body.xpath(".//w:hyperlink/@w:anchor"), ["results"])
        self.assertTrue(any(rel.target_ref == "https://example.org" for rel in document.part.rels.values()))
        for reference in body.xpath(".//a:blip/@r:embed"):
            self.assertEqual(document.part.related_parts[reference].blob, PNG)

    def test_style_template(self):
        source, template, output = make_fixture(self.directory, "")
        report = self.cli(source, template, output)
        self.assertEqual(report["template_mode"], "style")
        document = Document(output)
        self.assert_content(document)
        self.assertEqual(document.sections[0].header.paragraphs[0].text, "研究报告页眉")
        self.assertEqual(document.sections[0].footer.paragraphs[0].text, "研究报告页脚")
        self.assertEqual(document.sections[0].left_margin.twips, Cm(3.2).twips)
        self.assertNotIn("固定封面", document.element.body.xpath(".//w:t/text()"))

    def test_full_template_preserves_cover_sections_and_appendix(self):
        source, template, output = make_fixture(self.directory, "placeholder")
        self.assertEqual(self.cli(source, template, output)["template_mode"], "full")
        document = Document(output)
        self.assert_content(document)
        self.assertEqual(len(document.sections), 2)
        self.assertEqual(document.sections[0].left_margin.twips, Cm(3.2).twips)
        self.assertEqual(document.sections[1].left_margin.twips, Cm(2.8).twips)
        self.assertEqual(document.sections[1].header.paragraphs[0].text, "研究报告页眉")
        self.assertEqual(document.sections[1].footer.paragraphs[0].text, "研究报告页脚")
        self.assertEqual(document.paragraphs[0].text, "固定封面")
        self.assertEqual(document.paragraphs[-1].text, "固定附录")
        self.assertNotIn("DOCFLOW_", "".join(document.element.body.xpath(".//w:t/text()")))
        self.assertEqual(document.settings.element.xpath("./w:updateFields/@w:val"), ["true"])

    def test_bookmark_anchor(self):
        source, template, output = make_fixture(self.directory, "bookmark")
        self.cli(source, template, output, "--template-mode", "full")
        body = Document(output).element.body
        self.assertEqual(body.xpath(".//w:bookmarkStart/@w:name"), ["results", "计算方法"])
        starts = body.xpath(".//w:bookmarkStart/@w:id")
        self.assertEqual(len(set(starts)), 2)
        self.assertEqual(starts, list(reversed(body.xpath(".//w:bookmarkEnd/@w:id"))))

    def test_footnote_resources(self):
        """脚注内的媒体与链接需要在脚注部件自己的关系表中解析。"""
        for mode, anchor in (("style", ""), ("full", "placeholder")):
            with self.subTest(mode=mode):
                source, template, output = make_fixture(self.directory / mode, anchor)
                source.write_text(
                    "正文引用[^ref]。\n\n"
                    "[^ref]: [脚注链接](https://example.org/note) "
                    "![脚注图片](assets/sample%20image.png){width=4cm}",
                    encoding="utf-8",
                )
                self.cli(source, template, output, "--template-mode", mode)
                document = Document(output)
                reference = document.element.body.xpath(".//w:footnoteReference")[0]
                part = document.part.rels.part_with_reltype(RT.FOOTNOTES)
                footnotes = parse_xml(part.blob)
                footnote_id = reference.get(qn("w:id"))
                note = footnotes.find(f"w:footnote[@w:id='{footnote_id}']", footnotes.nsmap)
                self.assertIsNotNone(note)
                link = note.find(".//w:hyperlink", note.nsmap)
                drawing = next(note.iter(qn("a:blip")))
                link_relationship = part.rels[link.get(qn("r:id"))]
                image_relationship = part.rels[drawing.get(qn("r:embed"))]
                self.assertEqual(link_relationship.target_ref, "https://example.org/note")
                self.assertEqual(image_relationship.target_part.blob, PNG)

    def test_chinese_template_roles_and_toc(self):
        """中文角色、编号引用和目录域使用模板所提供的定义。"""
        source, template_path, output = make_fixture(self.directory, "")
        template = Document(template_path)
        template.styles["Title"].delete()
        for name in ("题目", "图名", "表名", "图片", "表格文字"):
            template.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
        heading = template.styles["Heading 1"]
        numbering = heading.element.get_or_add_pPr().get_or_add_numPr()
        numbering.get_or_add_numId().val = 1
        # 复现 WPS 样式模板里的空目录内容控件。
        sdt = OxmlElement("w:sdt")
        properties = OxmlElement("w:sdtPr")
        gallery = OxmlElement("w:docPartGallery")
        gallery.set(qn("w:val"), "Table of Contents")
        properties.append(gallery)
        sdt.extend([properties, OxmlElement("w:sdtContent")])
        template.element.body.insert(0, sdt)
        template.save(template_path)

        markdown = "---\ntitle: 工程试验\nlang: zh-CN\n---\n\n" + MARKDOWN
        markdown = markdown.replace(
            "| 项目 | 结果 |", "表 1 试验结果\n\n| 项目 | 结果 |",
        )
        source.write_text(markdown, encoding="utf-8")
        self.cli(source, template_path, output)

        document = Document(output)
        styles_by_text = {p.text: p.style.name for p in document.paragraphs}
        self.assertEqual(styles_by_text["工程试验"], "题目")
        self.assertNotIn("样例图", styles_by_text)
        self.assertEqual(styles_by_text["图 1 试验示意"], "图名")
        self.assertEqual(styles_by_text["表 1 试验结果"], "表名")
        figure = next(p for p in document.paragraphs if p._p.xpath(".//w:drawing"))
        self.assertEqual(figure.style.name, "图片")
        self.assertTrue(figure.paragraph_format.keep_with_next)
        figure_caption = figure._p.getnext()
        self.assertEqual("".join(figure_caption.xpath(".//w:t/text()")), "图 1 试验示意")
        table_caption = document.tables[0]._tbl.getprevious()
        self.assertEqual("".join(table_caption.xpath(".//w:t/text()")), "表 1 试验结果")
        self.assertEqual(document.tables[0].cell(1, 0).paragraphs[0].style.name, "表格文字")
        self.assertEqual(document.styles["Heading 1"].element.xpath(".//w:numId/@w:val"), ["1"])
        fields = document.element.body.xpath(".//w:sdt//w:instrText/text()")
        self.assertTrue(any(field.strip().startswith("TOC ") for field in fields))
        self.assertIn("目录", document.element.body.xpath(".//w:sdt//w:t/text()"))
        self.assertEqual(document.settings.element.xpath("./w:updateFields/@w:val"), ["true"])

    def test_preflight_and_invalid_image(self):
        source, template, output = make_fixture(self.directory, "")
        self.assertEqual(self.cli(source, template, output, "--check")["status"], "checked")
        self.assertFalse(output.exists())
        source.write_text("![图](missing.png)\n\n![图](https://example.org/image.png)", encoding="utf-8")
        report = self.cli(source, template, output, status=1)
        self.assertIn("missing.png", report["message"])
        self.assertIn("仅支持本地图像文件", report["message"])
        self.assertFalse(output.exists())

    def test_missing_and_duplicate_full_template_anchors(self):
        source, template, output = make_fixture(self.directory, "")
        self.assertIn("唯一", self.cli(source, template, output, "--template-mode", "full", status=1)["message"])
        document = Document(template)
        document.add_paragraph("{{DOCFLOW_CONTENT}}")
        document.add_paragraph("{{DOCFLOW_CONTENT}}")
        document.save(template)
        self.assertIn("唯一", self.cli(source, template, output, status=1)["message"])
        self.assertFalse(output.exists())

    def test_output_protection_and_explicit_overwrite(self):
        source, template, output = make_fixture(self.directory, "")
        original_source, original_template = source.read_bytes(), template.read_bytes()
        output.write_bytes(b"previous")
        self.cli(source, template, output, status=1)
        self.assertEqual(output.read_bytes(), b"previous")
        self.cli(source, template, template, "--overwrite", status=1)
        self.assertEqual(template.read_bytes(), original_template)
        self.cli(source, template, output, "--overwrite", "--template-mode", "full", status=1)
        self.assertEqual(output.read_bytes(), b"previous")
        self.cli(source, template, output, "--overwrite")
        self.assert_content(Document(output))
        self.assertEqual(source.read_bytes(), original_source)
        self.assertEqual(template.read_bytes(), original_template)
