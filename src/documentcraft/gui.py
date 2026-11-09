"""Windows 桌面转换窗口，复用 CLI 的文档转换核心。"""

import os
import json
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Event
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from documentcraft.ai import AISettings, DEFAULT_ENDPOINT, DEFAULT_MODEL
from documentcraft.converter import TemplateMode, convert
from documentcraft.illustration import illustrate
from documentcraft.siwc import RESOURCE, account_models, sign_in, sign_out


# 界面颜色、字体、间距、尺寸和反馈节奏集中定义。
SURFACE = "#F4F7F5"
INK = "#192C26"
MUTED = "#4A6257"
ACCENT = "#245B49"
ACCENT_HOVER = "#194536"
ON_ACCENT = "#F6FFF9"
HEADING = ("Microsoft YaHei UI", 23, "bold")
BODY = ("Microsoft YaHei UI", 10)
PAD = 24
GAP = 12
SMALL_GAP = 5
BUTTON_PAD = (14, 8)
WINDOW_MIN = (750, 510)
WRAP_WIDTH = 600
POLL_MS = 80
MODES: dict[str, TemplateMode] = {"自动识别": "auto", "仅使用样式": "style", "完整模板": "full"}
MARKDOWN_FILES = (("Markdown 文件", "*.md *.markdown"),)
WORD_FILES = (("Word 文档", "*.docx"),)
REPORT_FILES = (("科研报告", "*.md *.markdown *.docx *.doc"),)
CHATGPT_PROVIDER = "Sign in with ChatGPT"
PROVIDERS = {"API Key": "api", CHATGPT_PROVIDER: "chatgpt"}
ILLUSTRATION_STYLES = {"黑白工程图": False, "按功能分区配色": True}


class ConversionWindow:
    """管理文件选择、后台转换和结果反馈。"""

    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.source = tk.StringVar(root)
        self.template = tk.StringVar(root)
        self.output = tk.StringVar(root)
        self.mode = tk.StringVar(root, value=next(iter(MODES)))
        self.status = tk.StringVar(root, value="请选择 Markdown 文件和 DOCX 模板。")
        self.worker = ThreadPoolExecutor(max_workers=1)
        self.conversion_worker = ThreadPoolExecutor(max_workers=1)
        self.pending: Future[dict[str, str]] | None = None
        self.result: Path | None = None
        self.task: Future | None = None
        self.task_label = ""
        self.login_cancel: Event | None = None
        self.report_source = tk.StringVar(root)
        self.report_style = tk.StringVar(root)
        self.report_status = tk.StringVar(root, value="选定报告和绘图风格后开始。")
        self.ai_status = tk.StringVar(root, value="API Key 仅用于当前会话。")
        self.provider = tk.StringVar(root, value=next(iter(PROVIDERS)))
        self.endpoint = tk.StringVar(root, value=DEFAULT_ENDPOINT)
        self.model = tk.StringVar(root, value=DEFAULT_MODEL)
        self.api_key = tk.StringVar(root)
        self.chatgpt_model = tk.StringVar(root)
        self.chatgpt_models: dict[str, str] = {}
        self.review_path: Path | None = None
        self.illustrated_path: Path | None = None
        self._load_ai_settings()
        self._build()

    def _build(self) -> None:
        self.root.title("DocumentCraft · 文档工作台")
        self.root.minsize(*WINDOW_MIN)
        self.root.configure(background=SURFACE)
        self.root.protocol("WM_DELETE_WINDOW", self._close)
        style = ttk.Style(self.root)
        # clam 支持主按钮配色，文件选择对话框由 Windows 提供。
        style.theme_use("clam")
        style.configure("Desk.TFrame", background=SURFACE)
        style.configure("Desk.TLabel", background=SURFACE, foreground=INK, font=BODY)
        style.configure("Title.Desk.TLabel", font=HEADING)
        style.configure("Status.Desk.TLabel", foreground=MUTED)
        style.configure("Desk.TButton", font=BODY, padding=BUTTON_PAD)
        style.configure(
            "Convert.TButton",
            font=BODY,
            padding=BUTTON_PAD,
            background=ACCENT,
            foreground=ON_ACCENT,
        )
        style.map("Convert.TButton", background=[("active", ACCENT_HOVER)])
        style.configure("TNotebook.Tab", padding=BUTTON_PAD, font=BODY)
        tabs = ttk.Notebook(self.root)
        tabs.pack(fill="both", expand=True, padx=GAP, pady=GAP)
        self._build_form(self._new_tab(tabs, "Markdown 转 Word"))
        self._build_illustration(self._new_tab(tabs, "科研配图"))
        self._build_ai(self._new_tab(tabs, "AI 设置"))

    def _new_tab(self, tabs: ttk.Notebook, title: str) -> ttk.Frame:
        panel = ttk.Frame(tabs, padding=PAD, style="Desk.TFrame")
        tabs.add(panel, text=title)
        panel.columnconfigure(0, weight=1)
        ttk.Label(panel, text=title, style="Title.Desk.TLabel").grid(
            row=0, column=0, columnspan=2, sticky="w", pady=(0, GAP),
        )
        return panel

    def _build_form(self, panel: ttk.Frame) -> None:
        self._file_row(panel, 1, "Markdown 文件", self.source, self._choose_source)
        self._file_row(panel, 3, "Word 模板", self.template, self._choose_template)
        self._file_row(panel, 5, "保存为", self.output, self._choose_output)

        options = ttk.Frame(panel, style="Desk.TFrame")
        options.grid(row=7, column=0, columnspan=2, sticky="ew", pady=(GAP, GAP))
        ttk.Label(options, text="模板方式", style="Desk.TLabel").pack(side="left", padx=(0, GAP))
        mode = ttk.Combobox(
            options, values=tuple(MODES), textvariable=self.mode, state="readonly", font=BODY,
        )
        mode.pack(side="left")

        self.convert_button = ttk.Button(
            panel, text="开始转换", command=self._start, style="Convert.TButton",
        )
        self.convert_button.grid(row=8, column=0, sticky="w", pady=(0, GAP))
        self.open_button = ttk.Button(
            panel, text="打开生成的 Word", command=self._open, style="Desk.TButton",
        )
        self.open_button.grid(row=8, column=1, sticky="e", pady=(0, GAP))
        self.open_button.state(["disabled"])
        ttk.Label(
            panel, textvariable=self.status, wraplength=WRAP_WIDTH, style="Status.Desk.TLabel",
        ).grid(row=9, column=0, columnspan=2, sticky="w")

    def _build_illustration(self, panel: ttk.Frame) -> None:
        ttk.Label(
            panel, text="为科研报告补充技术路线图和流程图。结果另存到源文件所在目录。",
            style="Status.Desk.TLabel", wraplength=WRAP_WIDTH,
        ).grid(row=1, column=0, columnspan=2, sticky="w", pady=(0, GAP))
        self._file_row(panel, 2, "科研报告", self.report_source, self._choose_report)
        self._choice(panel, 4, "绘图风格", self.report_style, tuple(ILLUSTRATION_STYLES))
        self.illustrate_button = ttk.Button(
            panel, text="分析并生成配图", command=self._start_illustration, style="Convert.TButton",
        )
        self.illustrate_button.grid(row=6, column=0, sticky="w", pady=GAP)
        outputs = ttk.Frame(panel, style="Desk.TFrame")
        outputs.grid(row=7, column=0, columnspan=2, sticky="w", pady=(0, GAP))
        self.illustrated_button = ttk.Button(
            outputs, text="打开配图报告", command=lambda: self._open_path(self.illustrated_path),
            style="Desk.TButton", state="disabled",
        )
        self.illustrated_button.pack(side="left", padx=(0, GAP))
        self.review_button = ttk.Button(
            outputs, text="打开审核清单", command=lambda: self._open_path(self.review_path),
            style="Desk.TButton", state="disabled",
        )
        self.review_button.pack(side="left")
        ttk.Label(
            panel, textvariable=self.report_status, style="Status.Desk.TLabel", wraplength=WRAP_WIDTH,
        ).grid(row=8, column=0, columnspan=2, sticky="w")

    def _build_ai(self, panel: ttk.Frame) -> None:
        self._choice(panel, 1, "分析连接", self.provider, tuple(PROVIDERS))
        self._setting(panel, 3, "API 地址（包含 /v1 或兼容前缀）", self.endpoint)
        self._setting(panel, 5, "分析模型", self.model)
        self._setting(panel, 7, "API Key（可读取 OPENAI_API_KEY）", self.api_key, masked=True)
        self.chatgpt_picker = self._choice(panel, 9, "ChatGPT 套餐模型", self.chatgpt_model, ())
        actions = ttk.Frame(panel, style="Desk.TFrame")
        actions.grid(row=11, column=0, columnspan=2, sticky="w", pady=(0, GAP))
        for label, command in (
            ("保存设置", self._save_ai_settings),
            (CHATGPT_PROVIDER, self._login),
            ("刷新模型", self._refresh_models),
            ("退出 ChatGPT", self._logout),
        ):
            ttk.Button(actions, text=label, command=command, style="Desk.TButton").pack(
                side="left", padx=(0, GAP),
            )
        self.cancel_login_button = ttk.Button(
            actions, text="取消登录", command=self._cancel_login, style="Desk.TButton", state="disabled",
        )
        self.cancel_login_button.pack(side="left")
        ttk.Label(
            panel, textvariable=self.ai_status, style="Status.Desk.TLabel", wraplength=WRAP_WIDTH,
        ).grid(row=12, column=0, columnspan=2, sticky="w")

    def _choice(self, panel, row, title, variable, values) -> ttk.Combobox:
        ttk.Label(panel, text=title, style="Desk.TLabel").grid(
            row=row, column=0, sticky="w", pady=(0, SMALL_GAP),
        )
        choice = ttk.Combobox(panel, textvariable=variable, values=values, state="readonly", font=BODY)
        choice.grid(
            row=row + 1, column=0, columnspan=2, sticky="ew", pady=(0, GAP),
        )
        return choice

    def _setting(self, panel, row, title, variable, *, masked=False) -> None:
        ttk.Label(panel, text=title, style="Desk.TLabel").grid(
            row=row, column=0, sticky="w", pady=(0, SMALL_GAP),
        )
        ttk.Entry(panel, textvariable=variable, font=BODY, show="•" if masked else "").grid(
            row=row + 1, column=0, columnspan=2, sticky="ew", pady=(0, GAP),
        )

    def _settings_path(self) -> Path:
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home())
        return base / "DocumentCraft" / "ai-settings.json"

    def _load_ai_settings(self) -> None:
        try:
            saved = json.loads(self._settings_path().read_text(encoding="utf-8"))
            provider = saved.get("provider")
            if provider == "ChatGPT（Codex CLI）":
                provider = CHATGPT_PROVIDER
            if isinstance(provider, str) and provider in PROVIDERS:
                self.provider.set(provider)
            for name in ("endpoint", "model"):
                if isinstance(saved.get(name), str):
                    getattr(self, name).set(saved[name])
        except (OSError, ValueError, AttributeError):
            return

    def _save_ai_settings(self) -> None:
        path = self._settings_path()
        values = {
            "provider": self.provider.get(), "endpoint": self.endpoint.get(),
            "model": self.model.get(),
        }
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            # API Key 不进入持久化配置。
            with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
                temporary = Path(file.name)
                json.dump(values, file, ensure_ascii=False)
            try:
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
        except OSError as error:
            self.ai_status.set(f"无法保存设置。{error}")
        else:
            self.ai_status.set("连接设置已保存。API Key 仅用于当前会话。")

    def _choose_report(self) -> None:
        filename = filedialog.askopenfilename(parent=self.root, filetypes=REPORT_FILES)
        if filename:
            self.report_source.set(filename)

    def _login(self) -> None:
        if self._busy(self.ai_status):
            return
        self.task_label = "等待浏览器授权"
        self.ai_status.set("等待浏览器授权。已有授权可取消登录，再点击「刷新模型」。")
        self.login_cancel = Event()
        self.cancel_login_button.state(["!disabled"])
        self.task = self.worker.submit(sign_in, self.login_cancel)
        self._poll_task(self.ai_status, self._signed_in)

    def _cancel_login(self) -> None:
        if self.login_cancel is not None:
            self.login_cancel.set()
            self.cancel_login_button.state(["disabled"])
            self.ai_status.set("正在结束登录等待…")

    def _signed_in(self, account: str) -> None:
        self.provider.set(CHATGPT_PROVIDER)
        self.ai_status.set(f"已连接 {account}。")
        self.root.after_idle(self._refresh_models)

    def _refresh_models(self) -> None:
        if self._busy(self.ai_status):
            return
        self.task_label = "读取 ChatGPT 模型"
        self.ai_status.set("正在读取 ChatGPT 套餐可用模型…")
        self.task = self.worker.submit(account_models)
        self._poll_task(self.ai_status, self._show_models)

    def _show_models(self, models: list[tuple[str, str]]) -> None:
        self.chatgpt_models = {f"{name} · {slug}": slug for name, slug in models}
        choices = tuple(self.chatgpt_models)
        self.chatgpt_picker.configure(values=choices)
        if self.chatgpt_model.get() not in self.chatgpt_models:
            self.chatgpt_model.set(choices[0] if choices else "")
        self.ai_status.set("ChatGPT 套餐模型已更新。" if choices else "当前 ChatGPT 账号暂无可用模型。")

    def _logout(self) -> None:
        if self._busy(self.ai_status):
            return
        self.task_label = "退出 ChatGPT"
        self.task = self.worker.submit(sign_out)
        self._poll_task(self.ai_status, self._signed_out)

    def _signed_out(self, _result: None) -> None:
        self._show_models([])
        self.ai_status.set("已退出 DocumentCraft 的 ChatGPT 会话。")

    def _start_illustration(self) -> None:
        if self._busy(self.report_status):
            return
        filename = self.report_source.get().strip()
        style = self.report_style.get()
        if not filename or style not in ILLUSTRATION_STYLES:
            self.report_status.set("请选择报告和绘图风格。")
            return
        provider = PROVIDERS[self.provider.get()]
        model = self.model.get().strip()
        if provider == "chatgpt":
            model = self.chatgpt_models.get(self.chatgpt_model.get(), "")
            if not model:
                self.report_status.set("请在 AI 设置登录 ChatGPT 并刷新、选择套餐模型。")
                return
        settings = AISettings(provider, self.endpoint.get().strip(), model, self.api_key.get().strip())
        destination = self.endpoint.get().strip() if provider == "api" else RESOURCE
        if not messagebox.askyesno(
            "提交报告分析", f"将报告正文及图片位置发送到 {destination} 进行分析。继续吗？",
            parent=self.root,
        ):
            return
        self.illustrated_button.state(["disabled"])
        self.review_button.state(["disabled"])
        self.task_label = "分析报告并绘制配图"
        self.report_status.set("正在分析报告并绘制配图…")
        self.task = self.worker.submit(
            illustrate, Path(filename), settings, colored=ILLUSTRATION_STYLES[style],
        )
        self._poll_task(self.report_status, self._illustration_done)

    def _illustration_done(self, result: dict) -> None:
        self.illustrated_path = Path(result["output"])
        self.review_path = Path(result["review"])
        self.illustrated_button.state(["!disabled"])
        self.review_button.state(["!disabled"])
        self.report_status.set(f"完成。新增 {result['images']} 张图，待确认 {result['issues']} 项。")

    def _busy(self, status: tk.StringVar) -> bool:
        if self.task is not None:
            message = f"当前正在{self.task_label}。"
            if self.login_cancel is not None:
                message += "可在「AI 设置」取消登录。"
            status.set(message)
            return True
        return False

    def _poll_task(self, status: tk.StringVar, complete: Callable) -> None:
        if self.task is None:
            return
        if not self.task.done():
            self.root.after(POLL_MS, self._poll_task, status, complete)
            return
        try:
            complete(self.task.result())
        except Exception as error:
            status.set(str(error))
        finally:
            self.task = None
            self.task_label = ""
            self.login_cancel = None
            self.cancel_login_button.state(["disabled"])

    def _file_row(
        self,
        panel: ttk.Frame,
        row: int,
        title: str,
        variable: tk.StringVar,
        browse: Callable[[], None],
    ) -> None:
        ttk.Label(panel, text=title, style="Desk.TLabel").grid(
            row=row, column=0, sticky="w", pady=(0, SMALL_GAP),
        )
        entry = ttk.Entry(panel, textvariable=variable, font=BODY)
        entry.grid(row=row + 1, column=0, sticky="ew", padx=(0, GAP), pady=(0, GAP))
        button = ttk.Button(panel, text="浏览…", command=browse, style="Desk.TButton")
        button.grid(row=row + 1, column=1, sticky="ew", pady=(0, GAP))

    def _choose_source(self) -> None:
        filename = filedialog.askopenfilename(parent=self.root, filetypes=MARKDOWN_FILES)
        if filename:
            self.source.set(filename)
            if not self.output.get():
                source = Path(filename)
                self.output.set(str(source.with_name(f"{source.stem}-转换.docx")))

    def _choose_template(self) -> None:
        filename = filedialog.askopenfilename(parent=self.root, filetypes=WORD_FILES)
        if filename:
            self.template.set(filename)

    def _choose_output(self) -> None:
        proposed = Path(self.output.get())
        filename = filedialog.asksaveasfilename(
            parent=self.root, filetypes=WORD_FILES, defaultextension=".docx",
            initialdir=str(proposed.parent), initialfile=proposed.name, confirmoverwrite=False,
        )
        if filename:
            self.output.set(filename)

    def _start(self) -> None:
        if self.pending is not None:
            return
        paths = [value.get().strip() for value in (self.source, self.template, self.output)]
        if not all(paths):
            self.status.set("请选择 Markdown 文件、模板和保存位置。")
            return

        source, template, output = map(Path, paths)
        overwrite = output.is_file()
        if overwrite and not messagebox.askyesno(
            "替换已有文件", f"是否替换这个文件？\n{output}", parent=self.root,
        ):
            return
        self.result = None
        self.convert_button.state(["disabled"])
        self.open_button.state(["disabled"])
        self.status.set("正在转换，请稍候…")
        # 后台线程只调用核心 API，所有界面状态由主线程更新。
        self.pending = self.conversion_worker.submit(
            convert, source, template, output, mode=MODES[self.mode.get()], overwrite=overwrite,
        )
        self.root.after(POLL_MS, self._poll)

    def _poll(self) -> None:
        if self.pending is None:
            return
        if not self.pending.done():
            self.root.after(POLL_MS, self._poll)
            return

        try:
            report = self.pending.result()
        except Exception as error:
            self.status.set("转换失败，请检查输入后重试。")
            messagebox.showerror("转换失败", str(error), parent=self.root)
        else:
            self.result = Path(report["output"])
            self.status.set(f"已生成 {self.result}")
            self.open_button.state(["!disabled"])
        finally:
            self.pending = None
            self.convert_button.state(["!disabled"])

    def _open(self) -> None:
        self._open_path(self.result)

    def _open_path(self, path: Path | None) -> None:
        if path is None:
            return
        try:
            os.startfile(path)
        except OSError as error:
            messagebox.showerror("无法打开文档", str(error), parent=self.root)

    def _close(self) -> None:
        if self.pending is not None or self.task is not None:
            messagebox.showinfo("任务正在进行", "任务完成后即可关闭窗口。", parent=self.root)
            return
        self.worker.shutdown(wait=False)
        self.conversion_worker.shutdown(wait=False)
        self.root.destroy()


def launch() -> None:
    """启动单窗口桌面界面。"""
    root = tk.Tk()
    ConversionWindow(root)
    root.mainloop()


if __name__ == "__main__":
    launch()
