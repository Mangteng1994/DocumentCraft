"""面向用户、Codex Skill 和阅读编辑器 sidecar 的 CLI。"""

import argparse
import json
import sys
from pathlib import Path

from . import editor_api
from .converter import convert
from .templates import ConversionError

# sidecar 子命令始终输出 JSON。md-to-word 为兼容既有脚本，仅在 --json 时输出 JSON。
EDITOR_COMMANDS = {"notes", "share", "illustrate", "assistant", "ai", "chat"}


def _read_payload() -> dict:
    """读取编辑器经标准输入传来的 JSON 对象。"""
    raw = sys.stdin.buffer.read().decode("utf-8-sig")
    if not raw.strip():
        return {}
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ConversionError("输入必须是 JSON 对象。")
    return payload


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="docflow", description="DocumentCraft 文档转换工具")
    commands = parser.add_subparsers(dest="command", required=True)

    command = commands.add_parser("md-to-word", help="按 DOCX 模板转换 Markdown")
    command.add_argument("--input", required=True, type=Path, help="源 Markdown 文件")
    command.add_argument("--template", required=True, type=Path, help="DOCX 模板")
    command.add_argument("--output", required=True, type=Path, help="目标 DOCX 路径")
    command.add_argument("--template-mode", choices=("auto", "style", "full"), default="auto")
    command.add_argument("--check", action="store_true", help="检查模板和图像资源，跳过输出")
    command.add_argument("--overwrite", action="store_true", help="允许替换已有输出")
    command.add_argument("--with-notes", action="store_true", help="把阅读编辑器的批注写入 Word 批注")
    command.add_argument("--skip-unresolved", action="store_true", help="跳过无法定位的批注")
    command.add_argument("--json", action="store_true", help="以 JSON 返回转换结果")

    notes = commands.add_parser("notes", help="管理阅读编辑器批注")
    notes.add_argument("action", choices=("list", "add", "update", "delete"))
    notes.add_argument("--source", required=True, type=Path)
    notes.add_argument("--id", default="")

    share = commands.add_parser("share", help="将 Markdown 与批注打成 ZIP")
    share.add_argument("--source", required=True, type=Path)
    share.add_argument("--output", required=True, type=Path)

    illustrate = commands.add_parser("illustrate", help="为科研报告生成配图")
    illustrate.add_argument("--source", required=True, type=Path)
    illustrate.add_argument("--style", choices=("mono", "colored"), default="mono")

    assistant = commands.add_parser("assistant", help="Copilot：检索并整理工作区")
    assistant.add_argument("action", choices=("search", "organize"))
    assistant.add_argument("--workspace", required=True, type=Path)
    assistant.add_argument("--question", required=True)

    ai = commands.add_parser("ai", help="AI 连接设置与 ChatGPT 登录")
    ai.add_argument("action", choices=("status", "save", "login", "logout", "models"))

    # 流式输出：每段回答一行 {"type": "delta"}，最后一行 {"type": "done"} 或错误对象。
    commands.add_parser("chat", help="Copilot 多轮对话，从标准输入读取对话 JSON")
    return parser


def _run_editor_command(args: argparse.Namespace) -> dict:
    """执行阅读编辑器 sidecar 子命令。"""
    if args.command == "chat":
        return editor_api.chat_stream(_read_payload(), _print_json)
    if args.command == "notes":
        if args.action == "list":
            return editor_api.list_notes(args.source)
        if args.action == "add":
            return editor_api.add_note(args.source, _read_payload())
        if args.action == "update":
            return editor_api.update_note(args.source, args.id, _read_payload())
        return editor_api.delete_note(args.source, args.id)
    if args.command == "share":
        return editor_api.share_package(args.source, args.output)
    if args.command == "illustrate":
        colored = args.style == "colored"
        return editor_api.illustrate_document(args.source, colored=colored)
    if args.command == "assistant":
        if args.action == "search":
            return editor_api.assistant_search(args.workspace, args.question)
        return editor_api.assistant_organize(args.workspace, args.question, _read_payload())
    actions = {
        "status": editor_api.ai_status,
        "login": editor_api.ai_login,
        "logout": editor_api.ai_logout,
        "models": editor_api.ai_models,
    }
    if args.action == "save":
        return editor_api.save_ai_settings(_read_payload())
    return actions[args.action]()


def _convert(args: argparse.Namespace) -> dict:
    if args.with_notes and not args.check:
        return editor_api.export_word(
            args.input,
            args.template,
            args.output,
            mode=args.template_mode,
            overwrite=args.overwrite,
            with_notes=True,
            skip_unresolved=args.skip_unresolved,
        )
    return convert(
        args.input,
        args.template,
        args.output,
        mode=args.template_mode,
        overwrite=args.overwrite,
        check_only=args.check,
    )


def _print_json(value: dict) -> None:
    # sidecar 的标准输出固定为 UTF-8，避免 Windows 控制台代码页改写中文。
    text = json.dumps(value, ensure_ascii=False)
    sys.stdout.buffer.write(text.encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()


def main(argv: list[str] | None = None) -> int:
    """处理命令行参数并返回可供脚本判断的退出状态。"""
    parser = _build_parser()
    args = parser.parse_args(argv)
    editor_command = args.command in EDITOR_COMMANDS
    json_output = editor_command or args.json
    try:
        if editor_command:
            report = _run_editor_command(args)
        else:
            report = _convert(args)
    except (ConversionError, OSError, ValueError) as error:
        if json_output:
            _print_json({"status": "error", "message": str(error)})
        else:
            print(f"处理失败\n{error}", file=sys.stderr)
        return 1

    if json_output:
        _print_json(report)
    elif report.get("status") == "unresolved":
        print(f"有 {report['count']} 条批注无法定位，可加 --skip-unresolved 跳过。", file=sys.stderr)
        return 1
    elif args.check:
        print(f"预检查通过（{report['template_mode']} 模板）")
    else:
        print(f"已生成 {report['output']}（{report['template_mode']} 模板）")
    return 0
