# Feature Ledger

需求基线来自[共享设计对话](https://chatgpt.com/share/6af1985c-7af8-83ea-83f3-4cb3d453c294)。DocumentCraft 面向 Windows 与 WPS 的本地科研文档工作流。两条主线共用 Python 文档处理核心。CLI 面向用户和 Codex Skill，后续桌面入口通过本地 API 调用同一核心。AI 负责配图判断与规划，确定性引擎负责文件转换、资源校验和回插。

本轮切片为 Markdown 按 DOCX 模板输出 DOCX。MoSCoW 优先级相对于本轮。已实现表示已落代码，验收状态单独记录。

| ID | MoSCoW | 功能 | 验收条件 | 状态与实现 |
| --- | --- | --- | --- | --- |
| DC-001 | Must | Markdown 解析与 DOCX 输出 | 标题、段落、列表、表格、代码、公式和本地图按正文顺序写入可编辑 DOCX | 已实现 · Pandoc JSON AST → DOCX |
| DC-002 | Must | 样式模板 | 输出采用参考文件的样式、页面设置与页眉页脚 | 已实现 · Pandoc `--reference-doc` |
| DC-003 | Must | 完整模板 | 在唯一正文锚点处插入内容，保留前后固定正文、封面和分节 | 已实现 · OOXML 模板为主文档，合并生成内容 |
| DC-004 | Must | CLI 和文件保护 | 支持明确输入、模板、输出和模式，失败时返回非零状态，默认保护已有输出 | 已实现 · `docflow md-to-word` |
| DC-005 | Should | 预检查和机器可读结果 | 报告模板锚点异常、缺失图片和转换错误，提供 JSON 输出 | 已实现 · `--check`、`--json`；图像支持本地文件 |
| DC-006 | Should | 完整模板目录更新 | 请求编辑器在打开时更新域 | 已实现 · 写入 `w:updateFields`，实际更新取决于 Word/WPS |
| DC-007 | Could | 模板样式诊断与布局质检 | 报告缺失的语义样式和特殊对象，提供版式保真记录 | 待排期 |
| DC-008 | Won’t | 旧版 DOC 与 WPS COM | 可通过 WPS 对 DOC 模板和输出进行兼容转换 | 后续文档引擎切片 |
| DC-009 | Won’t | 本地工作台与模板管理 | Vue 3 / Tauri 2 经 FastAPI 调用核心，SQLite 保存任务和模板元数据 | 后续产品切片 |
| DC-010 | Must | 科研报告配图 | 全文分析、保留已有图、按技术段落生成 PNG 并回插副本、导出问题清单 | 已实现 · `illustration.py`、`diagrams.py` |
| DC-011 | Must | 界面 100% tokenized | 界面自定义设计值全部通过语义 design tokens 引用，规则见 AGENTS.md | 已实现 · `src/documentcraft/gui.py` |
| DC-012 | Must | Windows x64 单文件 EXE | 仅复制 EXE 即可在 PATH 无 Python 和 Pandoc 的环境中运行转换 | 样例已验收 · `scripts/build-exe.ps1` → `dist/DocumentCraft.exe` |
| DC-013 | Should | 脚注资源保真 | 两种模板模式保留脚注、外部链接和本地图像，脚注引用指向输出包内正确的资源 | 样例已验收 · `src/documentcraft/templates.py` |
| DC-014 | Must | 「我的文档模板」样式转换 | 中文语言标签可转换，模板的题目、图名、表名、图片及表格文字样式生效，保留标题编号定义并生成目录域 | 用户模板已验收 · `src/documentcraft/converter.py`、`src/documentcraft/templates.py` |
| DC-015 | Must | 转换桌面界面 | 双击同一 EXE 可选择源文件、模板和输出，并在界面完成转换 | 已验收 · 发布 EXE 无参启动和界面转换冒烟验证通过 |
| DC-016 | Must | 整表居中 | Markdown 表格按版心居中，优先保留模板明确指定的表格对齐 | 已验收 · WPS 对齐属性检查和页面渲染通过 |
| DC-017 | Must | AI 连接 | 配置兼容 API 或通过官方 Sign in with ChatGPT 授权，直接使用 ChatGPT 套餐分析 | 已实现 · `siwc.py`，新版 EXE 启动通过，真实账号授权和推理待验收 |
| DC-018 | Must | 桌面功能导航 | 转换、配图和 AI 设置分区，保持单文件 EXE 与设计令牌 | 已实现 · `gui.py`；隔离目录 EXE 启动已检查 |
| DC-019 | Won’t | HTML 转 PPT | 可在导航中独立接入 HTML 转 PPT 工作流 | 后续切片 |
| DC-020 | Must | 双击无控制台 | 桌面单文件 EXE 使用 Windows GUI 子系统，命令行构建保留标准输入输出 | 已验证 · 桌面版启动正常，命令行版返回预检查 JSON |
| DC-023 | Must | Markdown 批注导出 WPS Spike | 两种模板模式只批注第二处重复句；完整模板保留已有批注；WPS 编辑保存重开后批注和锚点仍在；源 Markdown 哈希一致 | 已验收 · `spikes/wps_comments.py`，Pandoc 3.10 + 本机 WPS。两种模板模式均通过编辑、保存、重开和选区核对 |
| DC-024 | Must | Markdown 阅读批注 Spike | WebView2 中可选择正文并保存批注；重开恢复；前插内容后重新定位；重复匹配时标记为待定位；批注操作保持 Markdown 哈希一致 | 已验收 · spikes/reader_annotations.py；两个 WebView2 进程验证保存、重开与重定位 |
| DC-025 | Must | 阅读器批注导出 DOCX | 阅读器保存的批注经样式和完整模板导出；WPS 可编辑保存重开；待定位批注默认阻止导出，可明确跳过；源文件哈希一致 | 已验收 · review_notes.py、converter.py、spikes/reader_annotations.py；WebView2 与本机 WPS 往返通过 |
| DC-026 | Must | 单篇 Markdown 批注分享包 | 从阅读器生成 ZIP，解压后打开其中的 Markdown 可读到该文档批注；包内仅含源文档与该文档的批注数据库；已有 ZIP 受保护 | 已实现 · spikes/reader_annotations.py、spikes/reader_ui；未测试 |

## DC-023 Spike 验收

- 从 worktree 根目录执行以下命令。使用已安装的 Pandoc、本机 WPS 和含 python-docx 1.2.0、pywin32 的 Python 环境。

  ~~~powershell
  $env:PYTHONPATH = (Join-Path (Get-Location) 'src')
  & ../DocumentCraft/.venv/Scripts/python.exe -m spikes.wps_comments --wps
  ~~~

- 样例在 dist/wps-comments-2rsb5hk7。style-review.docx 和 full-review.docx 是直接导出的文件，带 wps-resaved 后缀的是 WPS 编辑后的副本。
- 两种模板都准确批注第二处重复句，选区包含粗体文字。完整模板原有批注保留。WPS 原生批注集合可读可编辑，保存并重开后，两种文件的批注正文、作者和选区经 OOXML 核对。源 Markdown 的 SHA-256 在导出前后相同。
- 本机 WPS 保存完整模板副本时写入空的 docProps/thumbnail.，其内容类型缺失，python-docx 1.2.0 重新读取整个包会报错。WPS 可重开该副本，批注的正文和选区改用直接读取包内 XML 核对。后续若要导入 WPS 编辑后的 DOCX，需要单独处理这个兼容问题。
- 本轮用脚本模拟阅读器提交的选区，覆盖同段普通文字和粗体。交互选区、跨段批注与批注重新定位留待后续验证。

## DC-024 Spike 验收

- 在 Windows WebView2 中打开样例，用 DOM 选区跨过粗体节点，通过阅读页表单保存批注。退出后由另一个进程打开同一文件，SQLite 批注恢复，点击批注可定位到第二处重复句。
- 外部前插段落后，重新读取可定位到原句。复制出两处相同上下文后，批注标记为待重新定位，正文高亮清空。源 Markdown 的 SHA-256 核对通过。
- 本轮覆盖单个 Markdown 文件内的同段选区。目录树和单文件 EXE 打包待后续验证。阅读器到 DOCX 的接线见 DC-025。预览保留基础排版，链接和媒体资源按本轮范围过滤。

从 worktree 根目录启动已有批注的验收样例：

~~~powershell
& ../DocumentCraft/.venv/Scripts/python.exe -m pip install --target .venv/reader-deps pywebview==6.2.1
$env:PYTHONPATH = 'src;.venv/reader-deps'
& ../DocumentCraft/.venv/Scripts/python.exe -m spikes.reader_annotations 'dist/reader-spike-ac0cae55/流量试验.md'
~~~

用一个尚不存在的样例目录重跑两阶段验证：

~~~powershell
$sample = 'dist/reader-spike-' + [Guid]::NewGuid().ToString('N')
& ../DocumentCraft/.venv/Scripts/python.exe -m spikes.verify_reader_annotations $sample save
& ../DocumentCraft/.venv/Scripts/python.exe -m spikes.verify_reader_annotations $sample reopen
~~~

## DC-025 阅读器到 WPS 验收

- 样例 dist/reader-export-0f0f4f80。阅读器保存的 SQLite 批注经 WebView2 导出按钮进入 convert()，使用实际模板完成 DOCX 导出。自动验证使用预设模板和输出路径。
- 样式与完整模板都在本机 WPS 实际编辑、保存并重开。核对第二处重复句的精确选区、批注正文、作者，以及完整模板原有批注。源 Markdown 的 SHA-256 一致。
- 两处相同上下文导致批注待定位时，首次导出不生成文件。显式跳过后生成无该批注的文件。取消「包含批注」也可导出正文。
- 第一版支持顶层普通段落及可投影为同一文本的基础行内格式，其他选区会提示暂不支持导出。应用使用现有 Spike worktree 的源码运行。

复现时沿用 DC-024 的 Python 和 WebView2 环境，使用新样例目录依次运行：

~~~powershell
$env:PYTHONPATH = 'src;.venv/reader-deps'
$sample = 'dist/reader-export-' + [Guid]::NewGuid().ToString('N')
foreach ($step in 'save','reopen','style','full','skip','plain') {
    & ../DocumentCraft/.venv/Scripts/python.exe -m spikes.verify_reader_annotations $sample $step
    if ($LASTEXITCODE -ne 0) { break }
}
~~~

## DC-026 单篇批注分享包

阅读器顶部的「打包 Markdown 与批注」将当前 Markdown 和仅含这篇文档批注的独立 SQLite 打成 ZIP。收件人解压到单独的文件夹后，按 DC-024 的方式启动同版本阅读器，打开解压出的 Markdown。批注文件和 Markdown 保持在解压后的相对位置即可。

本轮分享包范围为 Markdown 文件本身及批注，链接指向的图片和附件需另行提供。未测试。

## 界面开发约束

按项目根目录 [AGENTS.md](AGENTS.md) 执行 Feature Ledger、MoSCoW 与界面 design tokens 约定。

## 2026-11-09 验收记录

- DC-001 至 DC-006、DC-013 和 DC-014 的样例集成测试通过。源码 CLI 和隔离目录中的单文件 EXE 各通过 8 项。用例覆盖中文路径和语言标签、标题、列表、表格、图片、公式、代码、两种锚点、模板结构、脚注资源、目录、预检查、JSON 错误与已有文件保护。
- DC-002 和 DC-003 的 EXE 输出经编辑器导出后逐页查看。样式模板一页，完整模板两页。核对了图文位置、标题、表格、页边距、页眉页脚、封面、分节和固定附录。
- DC-012 的发布目录仅含 `DocumentCraft.exe`。EXE 测试从独立目录调用，清空 PATH 并移除 `PYTHONPATH` 和 `PYTHONHOME`。
- DC-013 在两种模式中验证脚注指向正确的链接目标和嵌入图片。完整模板样例还逐页核对了封面、正文引用、固定附录与页底图片。
- DC-014 使用用户提供的《我的文档模板.docx》和自建 Markdown 验收样例。用隔离目录中的同一 EXE 清空 PATH 后转换，发布文件与测试副本哈希一致，模板文件哈希转换前后一致。用编辑器更新目录并导出后，逐页核对了中文目录、标题编号、正文缩进、图表题注、表格文字和图片布局。验收稿为 `验收/我的文档模板-验收.docx`。输出图表题注使用 Markdown 原文，模板示例中的图表编号域属于参考正文。
- DC-015 确认隔离目录中的单文件 EXE 可直接打开桌面窗口。通过界面按钮调用转换核心并验证可打开输出的状态。
- DC-016 使用同一用户模板生成 `验收/我的文档模板-居中验收.docx`。通过 WPS 检查表格对齐属性，并查看了居中后的页面。

科研配图需求见 [完善 Skill 需求限定](https://chatgpt.com/share/6af1a17e-0708-83ea-b492-c9c046a85502)。ChatGPT 连接采用本地应用的 OAuth 动态注册和公开 Responses API，Client ID 由 OpenAI 在首次授权时发放。API 与 ChatGPT 的真实报告分析、旧版 DOC 回插和全流程验收尚未执行。[OpenAI 桌面应用接入文档](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
