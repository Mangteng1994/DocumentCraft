"""在两个 WebView2 进程中验证批注保存、恢复和重定位。"""

import argparse
from hashlib import sha256
from pathlib import Path
from time import monotonic, sleep

from docx import Document

from documentcraft.templates import PLACEHOLDER

from spikes.reader_annotations import open_reader
from spikes.wps_comments import (
    COMMENT,
    MARKDOWN,
    TEMPLATE_COMMENT,
    TEMPLATE_TEXT,
    round_trip_wps,
    verify_package,
)

SELECTION_SCRIPT = """
const block = Array.from(document.querySelectorAll("#document p"))[1];
const text = block.firstChild;
const selection = window.getSelection();
selection.setBaseAndExtent(text, "试验组。".length, block.lastChild, block.lastChild.length);
"""
HIGHLIGHT = """
Array.from(CSS.highlights.get("reader-notes") ?? []).some(
    range => range.toString() === "结果为 20 L/s，符合要求。" &&
        range.startContainer.parentElement.closest("p").textContent.startsWith("试验组。")
)
"""


def wait_for(window, script: str) -> None:
    """等待 WebView2 完成异步载入或保存。"""
    deadline = monotonic() + 12
    while monotonic() < deadline:
        if window.evaluate_js(script):
            return
        sleep(0.1)
    status = window.evaluate_js('document.querySelector("#status")?.textContent')
    raise AssertionError(f"WebView2 检查超时：{script}。页面提示：{status}")


def save_note(window) -> None:
    """通过 DOM 选区和表单交互写入一条跨粗体节点的批注。"""
    wait_for(window, 'document.querySelectorAll("#document p").length === 2')
    window.evaluate_js(SELECTION_SCRIPT)
    wait_for(window, 'document.querySelector("#quote").textContent === "结果为 20 L/s，符合要求。"')
    window.evaluate_js("""
        document.querySelector("#body").value = "请补充试验组的测量依据。";
        document.querySelector("#save").click();
    """)
    wait_for(window, HIGHLIGHT)


def verify_reopen(window, source: Path) -> None:
    """验证新进程恢复批注，移动和歧义情况下正确处理。"""
    wait_for(window, HIGHLIGHT)
    assert window.evaluate_js('document.querySelector("#notes").textContent.includes("请补充试验组的测量依据。")')
    window.evaluate_js('document.querySelector("#notes button").click()')
    assert window.evaluate_js('CSS.highlights.get("reader-active").size === 1')
    original = source.read_text(encoding="utf-8")
    try:
        source.write_text("新增一段。\n\n" + original, encoding="utf-8")
        window.evaluate_js('document.querySelector("#reload").click()')
        wait_for(window, f'document.querySelectorAll("#document p").length === 3 && ({HIGHLIGHT})')
        assert window.evaluate_js('CSS.highlights.get("reader-notes").size === 1')

        target = original.strip().split("\n\n")[-1]
        source.write_text(original + "\n" + target + "\n", encoding="utf-8")
        window.evaluate_js('document.querySelector("#reload").click()')
        wait_for(window, 'document.querySelector("#notes").textContent.includes("待重新定位")')
        assert window.evaluate_js('CSS.highlights.get("reader-notes").size === 0')
    finally:
        source.write_text(original, encoding="utf-8")


def verify_export(window, step: str, output: Path) -> None:
    """通过阅读页触发导出，核对待定位和包含批注的设置。"""
    if step == "skip":
        wait_for(window, 'document.querySelector("#notes").textContent.includes("待重新定位")')
        window.evaluate_js('document.querySelector("#export").click()')
        wait_for(window, '!document.querySelector("#skip-export").hidden')
        assert not output.exists()
        window.evaluate_js('document.querySelector("#skip-export").click()')
    else:
        wait_for(window, HIGHLIGHT)
        if step == "plain":
            window.evaluate_js('document.querySelector("#include-notes").click()')
        window.evaluate_js('document.querySelector("#export").click()')
    wait_for(window, 'document.querySelector("#status").textContent.startsWith("已导出")')
    if step in {"skip", "plain"}:
        assert len(Document(output).comments) == 0
    else:
        verify_package(output, COMMENT, step)


def main() -> None:
    """在专用样例目录运行一次保存或重开验证。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("step", choices=("save", "reopen", "style", "full", "skip", "plain"))
    args = parser.parse_args()
    root = args.root.resolve()
    source = root / "流量试验.md"
    if args.step == "save":
        root.mkdir(parents=True)
        source.write_text(MARKDOWN, encoding="utf-8")
    paths = None
    if args.step in {"style", "full", "skip", "plain"}:
        template = Document()
        if args.step == "full":
            paragraph = template.add_paragraph(TEMPLATE_TEXT)
            template.add_comment(paragraph.runs, text=TEMPLATE_COMMENT, author="模板审阅人")
            template.add_paragraph(PLACEHOLDER)
        template_path = root / f"{args.step}-template.docx"
        output = root / f"{args.step}-review.docx"
        template.save(template_path)
        paths = (template_path, output)

    original = source.read_bytes()
    if args.step == "skip":
        repeated = MARKDOWN.strip().split("\n\n")[-1]
        source.write_text(MARKDOWN + "\n" + repeated + "\n", encoding="utf-8")
    initial_hash = sha256(source.read_bytes()).digest()
    results = []

    def verify(window) -> None:
        try:
            if not window.events.loaded.wait(15):
                raise RuntimeError("WebView2 页面未载入。")
            if args.step == "save":
                save_note(window)
            elif args.step == "reopen":
                verify_reopen(window, source)
            else:
                verify_export(window, args.step, output)
        except Exception as error:
            results.append(error)
        finally:
            window.destroy()

    try:
        open_reader(root, source, verify, export_paths=paths)
        if results:
            raise results[0]
        assert sha256(source.read_bytes()).digest() == initial_hash
    finally:
        if args.step == "skip":
            source.write_bytes(original)
    if args.step in {"style", "full"}:
        from shutil import copyfile

        resaved = root / f"{args.step}-wps-resaved.docx"
        copyfile(output, resaved)
        round_trip_wps(resaved, args.step)
        print(f"{args.step}：WPS 编辑保存重开通过。")
    print(f"{args.step}：WebView2 检查通过；源 Markdown 哈希一致。")



if __name__ == "__main__":
    main()
