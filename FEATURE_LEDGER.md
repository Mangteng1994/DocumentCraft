# Feature Ledger

需求基线来自[共享设计对话](https://chatgpt.com/share/6af1985c-7af8-83ea-83f3-4cb3d453c294)。DocumentCraft 面向 Windows 与 WPS 的本地科研文档工作流。两条主线共用 Python 文档处理核心。CLI 面向用户和 Codex Skill，后续桌面入口通过本地 API 调用同一核心。AI 负责配图判断与规划，确定性引擎负责文件转换、资源校验和回插。

本轮切片为 Markdown 阅读编辑器：以 [VMark](https://github.com/xiaolai/vmark)（ISC）的编辑核心为基础重组精简的 Tauri 2 应用，只保留文件树和文档大纲两个侧栏视图。MD 转 Word、科研配图、Copilot（工作区整理）和批注都作为编辑器功能接入，Python 核心以 `docflow` sidecar 形式提供 JSON 接口。MoSCoW 优先级相对于本轮。已实现表示已落代码，验收状态单独记录。

## Must

| ID | 功能 | 验收条件 | 状态与实现 |
| --- | --- | --- | --- |
| DC-001 | Markdown 解析与 DOCX 输出 | 标题、段落、列表、表格、代码、公式和本地图按正文顺序写入可编辑 DOCX | 已实现 · Pandoc JSON AST → DOCX |
| DC-002 | 样式模板 | 输出采用参考文件的样式、页面设置与页眉页脚 | 已实现 · Pandoc `--reference-doc` |
| DC-003 | 完整模板 | 在唯一正文锚点处插入内容，保留前后固定正文、封面和分节 | 已实现 · OOXML 模板为主文档，合并生成内容 |
| DC-004 | CLI 和文件保护 | 支持明确输入、模板、输出和模式，失败时返回非零状态，默认保护已有输出 | 已实现 · `docflow md-to-word` |
| DC-010 | 科研报告配图 | 自动配图区分缺图、新增、实图和待确认；按实际标题层级盘点总览、场景和细图；插入位置独立于取证范围；逐节记录未单独出图的理由，区分规划遗漏、候选校验和绘制失败。蓝图重建支持分层架构、三栏路线和时间轴 | 已实现 · `illustration.py`、`ai.py`。前一版去图稿实跑识别 32 处引用，13 个候选均回插，已对照旧版 19 图；本轮补强未测试 |
| DC-011 | 界面 100% tokenized | 界面自定义设计值全部通过语义 design tokens 引用，规则见 AGENTS.md | 已实现 · 阅读编辑器的令牌定义在 `app/src/styles/tokens.css`、`tokens.ts`，组件样式只引用 token；断点因 CSS 媒体查询限制在注释中对应 `--dc-breakpoint-narrow` |
| DC-012 | Windows x64 单文件 EXE | 仅复制 EXE 即可在 PATH 无 Python 和 Pandoc 的环境中运行转换 | 样例已验收（旧版） · 桌面单文件 EXE 已由阅读编辑器取代；`scripts/build-exe.ps1` 只打包 `dist-cli/DocumentCraft-cli.exe`，作为编辑器 sidecar |
| DC-014 | 「我的文档模板」样式转换 | 中文语言标签可转换，模板的题目、图名、表名、图片及表格文字样式生效，保留标题编号定义并生成目录域；各节的普通正文统一使用模板的「正文」样式 | 正文样式修复已实现并打包 · `src/documentcraft/templates.py`；本次修复未测试 |
| DC-015 | 转换桌面界面 | 双击同一 EXE 可选择源文件、模板和输出，并在界面完成转换 | 已被 DC-029 取代 · tkinter 桌面界面已移除，转换入口见 DC-032 |
| DC-016 | 整表居中 | Markdown 表格按版心居中，优先保留模板明确指定的表格对齐 | 已验收 · WPS 对齐属性检查和页面渲染通过 |
| DC-017 | AI 连接 | 配置兼容 API 或通过官方 Sign in with ChatGPT 授权。ChatGPT 模型和推理强度可分别选择、保存和恢复，分析请求分别发送 `model` 和所选的 `reasoning.effort` | 已实现 · `gui.py`、`ai.py`、`siwc.py`；本轮未测试 |
| DC-018 | 桌面功能导航 | 转换、配图和 AI 设置分区。AI 设置按连接方式显示对应表单，登录状态、账号操作和分析参数分区，设计值引用语义令牌 | 已被 DC-029、DC-036 取代 · `gui.py` 已移除 |
| DC-020 | 双击无控制台 | 桌面单文件 EXE 使用 Windows GUI 子系统，命令行构建保留标准输入输出 | 已被 DC-029 取代 · 编辑器发布版使用 Windows GUI 子系统，sidecar 以 CREATE_NO_WINDOW 启动 |
| DC-021 | 图表题注识别 | 图片替代文字不充当图名，图名在图下，表名在表上并采用模板题注样式；识别紧邻表格的无编号独立短标题，包括列表末项因缩进产生的独立续段 | 已实现并打包 · `captions.py`、`templates.py`；本次修复未测试 |
| DC-022 | 登录等待可取消 | 明确显示等待授权，可取消，后台登录不阻塞 Word 转换 | 已迁移至 DC-036 · 登录在独立 docflow 进程中等待，取消时结束该进程；未测试 |
| DC-023 | Markdown 批注导出 WPS Spike | 两种模板模式只批注第二处重复句；完整模板保留已有批注；WPS 编辑保存重开后批注和锚点仍在；源 Markdown 哈希一致 | 已验收 · `spikes/wps_comments.py`，Pandoc 3.10 + 本机 WPS。两种模板模式均通过编辑、保存、重开和选区核对 |
| DC-024 | Markdown 阅读批注 Spike | WebView2 中可选择正文并保存批注；重开恢复；前插内容后重新定位；重复匹配时标记为待定位；批注操作保持 Markdown 哈希一致 | 已验收（历史 Spike） · pywebview 阅读器与验收脚本已移除，批注能力由 DC-033 承接 |
| DC-025 | 阅读器批注导出 DOCX | 阅读器保存的批注经样式和完整模板导出；WPS 可编辑保存重开；待定位批注默认阻止导出，可明确跳过；源文件哈希一致 | 已验收（历史 Spike） · 导出入口迁移至 DC-032，批注改为导出时由 `editor_api.locate_notes` 在 Pandoc AST 中定位 |
| DC-026 | 单篇 Markdown 批注分享包 | 从阅读器生成 ZIP，解压后打开其中的 Markdown 可读到该文档批注；包内仅含源文档与该文档的批注数据库；已有 ZIP 受保护 | 已迁移 · 批注面板「分享包」→ `docflow share`（`editor_api.share_package`）；未测试 |
| DC-027 | Markdown 阅读器工作区 | 从桌面版启动，在目录和文件之间切换，查看章节大纲，保留已有批注数据，资源随 EXE 打包 | 已被 DC-029、DC-030、DC-031 取代 · `reader.py`、`reader_ui/` 已移除 |
| DC-028 | 工作区 AI 整理 | 本地检索工作区 Markdown，查看摘录后提交给已配置 AI，整理稿可跳回来源文件 | 已被 DC-034 取代 · 检索与整理逻辑保留在 `reader_assistant.py` |
| DC-029 | VMark 精简编辑器外壳 | Tauri 2 + React + TipTap 窗口，打开工作区和 Markdown，所见即所得编辑并保存；Markdown 往返沿用 VMark 管线；VMark 的终端、MCP、浏览器、多格式、多窗口等功能不进入应用 | 部分验收 · `app/`。`tauri dev` 编译并启动窗口；Markdown 往返、保存与未保存提示经浏览器模拟验收；原生窗口内未逐项点击 |
| DC-030 | 文件树 | 侧栏显示工作区目录树，跳过隐藏目录与链接，点击 Markdown 打开，可刷新 | 已验收（模拟 IPC + Rust 测试） · `FileTree.tsx`、`workspace.rs` |
| DC-031 | 文档大纲 | 侧栏按标题层级显示可折叠大纲，支持过滤，点击跳到对应标题 | 已验收（模拟 IPC） · `OutlineView.tsx`：层级、过滤与点击跳转 |
| DC-032 | 编辑器内导出 Word | 从编辑器把当前文档按样式或完整模板导出 DOCX，可选包含批注；已有输出受保护 | 已验收（CLI 实跑 + 模拟 IPC） · `ExportDialog.tsx` → `docflow md-to-word --with-notes`；WPS 打开导出文件未复测 |
| DC-033 | 编辑器批注 | 选中正文添加批注，侧栏列出并定位；批注按原文与前后文锚定，编辑后重新定位，无法定位的标记为待定位；数据沿用 `.documentcraft/reader-spike.sqlite3` | 已验收（CLI 实跑 + 模拟 IPC） · `annotations.ts`、`CommentsPanel.tsx`、`docflow notes` |
| DC-034 | Copilot 工作区整理 | 侧栏对话：本地检索工作区摘录，确认后提交 AI 生成整理稿，来源可跳回文件 | 部分验收 · 本地检索实跑，界面与仅发送勾选摘录经模拟验收；真实 AI 整理未执行 |
| DC-035 | 编辑器内科研配图 | 对当前文档发起配图分析，确认外发后生成配图版和审核清单，完成后可在编辑器打开 | 部分验收 · 对话框经模拟验收；真实 AI 配图未执行 |
| DC-036 | 编辑器 AI 设置 | 兼容 API 与 ChatGPT 套餐两种连接；登录、取消、退出、模型和推理强度选择并保存；API Key 仅保留在当前会话 | 部分验收 · 对话框两种连接方式经模拟验收；`ai status` 实跑；登录、取消与模型读取未执行 |
| DC-037 | Python sidecar JSON 接口 | `docflow` 为编辑器提供 notes、share、illustrate、assistant、ai 子命令，统一 JSON 输出与非零失败码 | 已验收 · `editor_api.py`、`cli.py`；notes、share、md-to-word、assistant search、ai status 实跑 |

## Should

| ID | 功能 | 验收条件 | 状态与实现 |
| --- | --- | --- | --- |
| DC-005 | 预检查和机器可读结果 | 报告模板锚点异常、缺失图片和转换错误，提供 JSON 输出 | 已实现 · `--check`、`--json`；图像支持本地文件 |
| DC-006 | 完整模板目录更新 | 请求编辑器在打开时更新域 | 已实现 · 写入 `w:updateFields`，实际更新取决于 Word/WPS |
| DC-013 | 脚注资源保真 | 两种模板模式保留脚注、外部链接和本地图像，脚注引用指向输出包内正确的资源 | 样例已验收 · `src/documentcraft/templates.py` |

## Could

| ID | 功能 | 验收条件 | 状态与实现 |
| --- | --- | --- | --- |
| DC-007 | 模板样式诊断与布局质检 | 报告缺失的语义样式和特殊对象，提供版式保真记录 | 待排期 |
| DC-039 | 编辑器源码模式 | 在所见即所得与 Markdown 源码之间切换 | 待排期 |

## Won’t

| ID | 功能 | 验收条件 | 状态与实现 |
| --- | --- | --- | --- |
| DC-038 | 编辑器安装包 | Tauri 打包含 `docflow` sidecar 的 Windows 安装包 | 待排期 · 本轮以源码运行 |
| DC-008 | 旧版 DOC 与 WPS COM | 可通过 WPS 对 DOC 模板和输出进行兼容转换 | 后续文档引擎切片 |
| DC-009 | 本地工作台与模板管理 | Vue 3 / Tauri 2 经 FastAPI 调用核心，SQLite 保存任务和模板元数据 | 后续产品切片 |
| DC-019 | HTML 转 PPT | 可在导航中独立接入 HTML 转 PPT 工作流 | 后续切片 |

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

以下 Spike 命令依赖已移除的 `reader.py` 与 `spikes/reader_annotations.py`，仅作历史记录，需检出提交 `7688159` 复现。

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

阅读编辑器批注面板的「分享包」将当前 Markdown 和仅含这篇文档批注的独立 SQLite 打成 ZIP。收件人解压到单独的文件夹后，用阅读编辑器打开其中的 Markdown。批注文件和 Markdown 保持在解压后的相对位置即可。

分享包包含 Markdown 文件本身及批注，链接指向的图片和附件需另行提供。

## DC-010 图位复核

- 前一版试跑用同一去图稿生成 13 张图，32 处图题和引用均有对应结果。与旧稿 19 张对照：11 张主题对应，1 张部分覆盖，7 张未单独出图。初始只生成 7 张的审核记录显示，多个有明确引用的图位在规划阶段被误判为疑似已有图。
- 本轮按真实标题树盘点，要求对无显式引用的关键关系同样逐节检查。审核清单保留插入锚点、取证范围、引用去向及未单独出图的理由；并入其他图的结论只在目标图成功生成后成立。新规则已实现，未再次对原稿执行自动配图。

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

## 2026-11-09 阅读编辑器验收

- 环境：Windows 11、Node 24、Rust 1.96（`x86_64-pc-windows-gnullvm`）、Pandoc 3.10、仓库 `.venv`。
- 构建：`tsc --noEmit`、`vite build`、`cargo test --lib`（4 项）通过。`npx tauri dev` 编译后窗口正常启动。gnullvm 目标链接 `cdylib` 时导出符号超过 65535 个，已将 crate-type 改为仅 `rlib`。
- sidecar（DC-037）：样例工作区实跑 `notes add/update/delete/list`，空选区、不存在的编号和越级编号返回 JSON 错误与非零退出码，源 Markdown 哈希不变。`md-to-word --with-notes` 对含公式段落的批注返回 `unresolved`，加 `--skip-unresolved` 后写入 2 条批注，`comments.xml` 正文与批注选区逐条核对。已有输出受保护，`--overwrite` 可替换。`share` 包内仅含源文档和批注库，重名时拒绝。`assistant search` 跳过隐藏目录，工作区外的摘录来源被拒绝。现有 8 项 Python 测试通过。
- Markdown 往返（DC-029）：用编辑器同一 schema 在 Node 中验证。CRLF 文件保存后保持 CRLF，二次保存无变化。frontmatter、脚注、公式、引用式链接、任务项、图片和代码块原样保留；表格列宽对齐和提示块标记后的空引用行按 VMark 规范写法改写，与 VMark 自身的往返基准一致。验收中补上了 VMark 的换行符与硬换行写法保留逻辑（`linebreakDetection.ts`）。
- 界面（DC-030 至 DC-036）：在浏览器中加载真实 `App`，用 Tauri 官方 `mockIPC` 模拟 IPC。验证了打开工作区与文件树、大纲层级/过滤/跳转、选区批注的锚点（与 Python 端一致）、高亮与选中、编辑后原文消失时显示「待定位」、撤销后恢复、导出对话框的待定位提示与跳过、Copilot 仅发送勾选摘录且来源可跳回、编辑后 `Ctrl+S` 写回的 Markdown、切换文档时的保存提示，以及 AI 设置和科研配图对话框。修复了 frontmatter 换行被 TipTap 样式覆盖、任务项勾选与提示块类型不显示、脚注编号单独占行、绝对图片路径判断缺少反斜杠四处问题。
- 未执行：原生窗口内的逐项点击、真实 AI 请求（Copilot 整理、科研配图、ChatGPT 登录）、WPS 打开导出文件。
