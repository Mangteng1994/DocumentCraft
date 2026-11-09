"""Markdown 到 DOCX 的可复用转换入口。"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal
from urllib.parse import unquote, urlsplit
from zipfile import BadZipFile

from docx import Document
from docx.opc.exceptions import PackageNotFoundError
from lxml.etree import XMLSyntaxError

from .templates import (
    ConversionError,
    apply_template_styles,
    has_toc_placeholder,
    insert_content,
    repair_generated_footnotes,
    request_field_updates,
    select_anchor,
)

TemplateMode = Literal["auto", "style", "full"]
MARKDOWN_FORMAT = "markdown-raw_html-raw_tex-raw_attribute"
CHINESE_LANGUAGES = {
    "zh": "zh-Hans",
    "zh-cn": "zh-Hans-CN",
    "zh-sg": "zh-Hans-SG",
    "zh-tw": "zh-Hant-TW",
    "zh-hk": "zh-Hant-HK",
    "zh-mo": "zh-Hant-MO",
}


def run_pandoc(
    executable: str | Path,
    directory: Path,
    *args: str,
    data: bytes | None = None,
) -> bytes:
    """运行 Pandoc，并将警告作为失败反馈给调用者。"""
    result = subprocess.run(
        [executable, "--fail-if-warnings", *args],
        cwd=directory,
        input=data,
        stdin=subprocess.DEVNULL if data is None else None,
        capture_output=True,
        # 从桌面界面调用 Pandoc 时也保持转换过程安静。
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        check=False,
    )
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise ConversionError(f"Pandoc 转换失败（退出码 {result.returncode}）\n{detail}")
    return result.stdout


def find_pandoc() -> str | Path:
    """定位打包内置引擎或开发环境中的 Pandoc。"""
    if getattr(sys, "frozen", False):
        executable = Path(__file__).resolve().parents[1] / "engine" / "pandoc.exe"
        if not executable.is_file():
            raise ConversionError("程序包缺少内置 Pandoc，请重新获取完整 EXE。")
        return executable
    executable = shutil.which("pandoc")
    if executable is None:
        raise ConversionError("找不到 Pandoc，请安装并将 pandoc 加入 PATH。")
    return executable


def check_images(ast: bytes, directory: Path) -> None:
    """从 AST 收集图片路径问题，以 Markdown 所在目录解析相对路径。"""
    pending = [json.loads(ast)]
    problems = set()
    while pending:
        node = pending.pop()
        if isinstance(node, list):
            pending.extend(node)
        elif isinstance(node, dict):
            if node.get("t") == "Image":
                target = node["c"][2][0]
                try:
                    decoded = unquote(target)
                    path = Path(decoded)
                    url = urlsplit(target)
                    windows_drive = len(path.drive) == 2 and path.drive.endswith(":")
                    network_path = decoded.startswith(("//", "\\\\"))
                    remote_url = bool(url.scheme) and not windows_drive
                    if network_path or remote_url:
                        problems.add(f"仅支持本地图像文件：{target}")
                    elif not (directory / path).is_file():
                        problems.add(f"找不到图像文件：{target}")
                except (OSError, ValueError):
                    problems.add(f"无法读取图像路径：{target}")
            pending.extend(node.values())
    if problems:
        raise ConversionError("\n".join(sorted(problems)))


def open_docx(path: Path):
    """打开 DOCX，将包结构异常转换为可读的诊断。"""
    try:
        return Document(path)
    except (PackageNotFoundError, BadZipFile, KeyError, ValueError, XMLSyntaxError) as error:
        raise ConversionError(f"无法读取 DOCX 文件 {path}\n{error}") from error


def document_options(ast: bytes, generate_toc: bool) -> list[str]:
    """配置 Pandoc 的语言和参考模板要求的目录。"""
    metadata = json.loads(ast)["meta"]
    language = metadata.get("lang", {})
    if language.get("t") == "MetaInlines":
        inlines = language.get("c")
        if len(inlines) == 1 and inlines[0].get("t") == "Str":
            language = inlines[0]
    value = language.get("c")
    language_tag = value.casefold() if isinstance(value, str) else ""
    options = []
    # Pandoc 中文翻译文件按书写系统区分，区域语言标签需要补齐脚本。
    normalized = CHINESE_LANGUAGES.get(language_tag)
    if normalized is not None:
        options.extend(["--metadata", f"lang={normalized}"])
    if generate_toc:
        options.append("--toc")
        chinese = language_tag == "zh" or language_tag.startswith("zh-")
        if chinese and "toc-title" not in metadata:
            options.extend(["--metadata", "toc-title=目录"])
    return options


def convert(
    source: Path,
    template: Path,
    output: Path,
    *,
    mode: TemplateMode = "auto",
    overwrite: bool = False,
    check_only: bool = False,
) -> dict[str, str]:
    """预检查输入，转换成功后再发布输出文件。"""
    if mode not in ("auto", "style", "full"):
        raise ConversionError(f"未知模板模式：{mode}")
    source = Path(source).resolve()
    template = Path(template).resolve()
    output = Path(output)
    output = output.parent.resolve() / output.name
    if source.suffix.lower() not in {".md", ".markdown"} or not source.is_file():
        raise ConversionError(f"请输入可读取的 Markdown 文件：{source}")
    if template.suffix.lower() != ".docx" or not template.is_file():
        raise ConversionError(f"请输入可读取的 DOCX 模板：{template}")
    if output.suffix.lower() != ".docx" or not output.parent.is_dir():
        raise ConversionError(f"输出必须是已存在目录中的 DOCX 路径：{output}")
    if output.is_symlink():
        raise ConversionError(f"输出路径指向符号链接：{output}")
    if output.exists():
        if output.samefile(source) or output.samefile(template):
            raise ConversionError("输出不能覆盖原始 Markdown 或模板。")
        if not output.is_file() or not overwrite:
            raise ConversionError(f"输出路径已存在：{output}。请更换路径或使用 --overwrite。")

    executable = find_pandoc()
    master = open_docx(template)
    anchor = select_anchor(master, mode)
    report = {
        "status": "checked" if check_only else "converted",
        "template_mode": "full" if anchor is not None else "style",
        "output": str(output),
    }
    ast = run_pandoc(
        executable,
        source.parent,
        "--from", MARKDOWN_FORMAT,
        "--to", "json",
        str(source),
    )
    check_images(ast, source.parent)
    if check_only:
        return report

    generate_toc = anchor is None and has_toc_placeholder(master)
    options = document_options(ast, generate_toc)

    # 临时结果与目标位于同一文件系统，便于成功后一次性发布。
    with TemporaryDirectory(prefix=".documentcraft-", dir=output.parent) as directory:
        staged = Path(directory) / "result.docx"
        run_pandoc(
            executable, source.parent,
            "--from", "json", "--to", "docx",
            "--reference-doc", str(template), "--output", str(staged),
            *options,
            data=ast,
        )
        generated = open_docx(staged)
        styles_changed = apply_template_styles(master, generated)
        footnotes_repaired = repair_generated_footnotes(generated)
        if anchor is not None:
            try:
                insert_content(master, generated, anchor)
                request_field_updates(master)
                master.save(staged)
            except (KeyError, ValueError, XMLSyntaxError) as error:
                raise ConversionError(f"无法将正文合并到完整模板\n{error}") from error
            open_docx(staged)
        elif footnotes_repaired or styles_changed or generate_toc:
            if generate_toc:
                request_field_updates(generated)
            generated.save(staged)
            open_docx(staged)

        if overwrite:
            os.replace(staged, output)
        else:
            try:
                if os.name == "nt":
                    # Windows 上 rename 遇到已存在的目标会失败。
                    staged.rename(output)
                else:
                    os.link(staged, output)
            except FileExistsError as error:
                raise ConversionError(f"输出路径已存在：{output}。") from error
    return report
