"""面向用户和 Codex Skill 的 CLI。"""

import argparse
import json
import sys
from pathlib import Path

from .converter import convert
from .templates import ConversionError


def main(argv: list[str] | None = None) -> int:
    """处理命令行参数并返回可供脚本判断的退出状态。"""
    parser = argparse.ArgumentParser(prog="docflow", description="DocumentCraft 文档转换工具")
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("md-to-word", help="按 DOCX 模板转换 Markdown")
    command.add_argument("--input", required=True, type=Path, help="源 Markdown 文件")
    command.add_argument("--template", required=True, type=Path, help="DOCX 模板")
    command.add_argument("--output", required=True, type=Path, help="目标 DOCX 路径")
    command.add_argument("--template-mode", choices=("auto", "style", "full"), default="auto")
    command.add_argument("--check", action="store_true", help="检查模板和图像资源，跳过输出")
    command.add_argument("--overwrite", action="store_true", help="允许替换已有输出")
    command.add_argument("--json", action="store_true", help="以 JSON 返回转换结果")
    args = parser.parse_args(argv)
    try:
        report = convert(
            args.input,
            args.template,
            args.output,
            mode=args.template_mode,
            overwrite=args.overwrite,
            check_only=args.check,
        )
    except (ConversionError, OSError) as error:
        if args.json:
            print(json.dumps({"status": "error", "message": str(error)}))
        else:
            print(f"处理失败\n{error}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report))
    elif args.check:
        print(f"预检查通过（{report['template_mode']} 模板）")
    else:
        print(f"已生成 {report['output']}（{report['template_mode']} 模板）")
    return 0
