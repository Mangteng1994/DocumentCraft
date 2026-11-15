# Feature Ledger

需求基线来自[共享设计对话](https://chatgpt.com/share/6af1985c-7af8-83ea-83f3-4cb3d453c294)。DocumentCraft 面向 Windows 与 WPS 的本地科研文档工作流。两条主线共用 Python 文档处理核心。CLI 面向用户和 Codex Skill，后续桌面入口通过本地 API 调用同一核心。AI 负责配图判断与规划，确定性引擎负责文件转换、资源校验和回插。

本轮切片为 Markdown 阅读编辑器：以 [VMark](https://github.com/xiaolai/vmark)（ISC）的编辑核心为基础重组精简的 Tauri 2 应用，侧栏保留文件树、文档大纲和工作区搜索三个视图，编辑区为多文档页签。MD 转 Word、科研配图、Copilot（工作区整理）和批注都作为编辑器功能接入，Python 核心以 `docflow` sidecar 形式提供 JSON 接口。MoSCoW 优先级相对于本轮。已实现表示已落代码，验收状态单独记录。

## Must

| ID | 功能 | 验收条件 | 状态与实现 |
| --- | --- | --- | --- |
| DC-001 | Markdown 解析与 DOCX 输出 | 标题、段落、列表、表格、代码、公式和本地图按正文顺序写入可编辑 DOCX | 已实现 · Pandoc JSON AST → DOCX |
| DC-002 | 样式模板 | 输出采用参考文件的样式、页面设置与页眉页脚 | 已实现 · Pandoc `--reference-doc` |
| DC-003 | 完整模板 | 在唯一正文锚点处插入内容，保留前后固定正文、封面和分节 | 已实现 · OOXML 模板为主文档，合并生成内容 |
| DC-004 | CLI 和文件保护 | 支持明确输入、模板、输出和模式，失败时返回非零状态，默认保护已有输出 | 已实现 · `docflow md-to-word` |
| DC-010 | 科研报告配图 | 自动配图区分缺图、新增、实图和待确认；按实际标题层级盘点总览、场景和细图；插入位置独立于取证范围；逐节记录未单独出图的理由，区分规划遗漏、候选校验和绘制失败。蓝图重建支持分层架构、三栏路线和时间轴 | 已实现 · `illustration.py`、`ai.py`。前一版去图稿实跑识别 32 处引用，13 个候选均回插，已对照旧版 19 图；本轮补强未测试 |
| DC-011 | 界面 100% tokenized | 界面自定义设计值全部通过语义 design tokens 引用，规则见 AGENTS.md | 已实现 · 阅读编辑器的令牌定义在 `editor/src/styles/tokens.css`、`tokens.ts`，组件样式只引用 token；断点因 CSS 媒体查询限制在注释中对应 `--dc-breakpoint-narrow` |
| DC-012 | Windows x64 单文件 EXE | 仅复制 EXE 即可在 PATH 无 Python 和 Pandoc 的环境中运行转换 | 样例已验收（旧版） · 桌面单文件 EXE 已由阅读编辑器取代；`scripts/build-sidecar.ps1` 只打包 `out/sidecar/DocumentCraft-cli.exe`，作为编辑器 sidecar |
| DC-014 | 「我的文档模板」样式转换 | 中文语言标签可转换，模板的题目、图名、表名、图片及表格文字样式生效，保留标题编号定义并生成目录域；各节的普通正文统一使用模板的「正文」样式 | 正文样式修复已实现并打包 · `core/src/documentcraft/templates.py`；本次修复未测试 |
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
| DC-029 | VMark 精简编辑器外壳 | Tauri 2 + React + TipTap 窗口，打开工作区和 Markdown，所见即所得编辑并保存；Markdown 往返沿用 VMark 管线；VMark 的终端、MCP、浏览器、多格式、多窗口等功能不进入应用 | 部分验收 · `editor/`。`tauri dev` 编译并启动窗口；Markdown 往返、保存与未保存提示经浏览器模拟验收；原生窗口内未逐项点击 |
| DC-030 | 文件树 | 侧栏显示工作区目录树，跳过隐藏目录与链接，点击 Markdown 打开，可刷新 | 已验收（模拟 IPC + Rust 测试） · `FileTree.tsx`、`workspace.rs` |
| DC-031 | 文档大纲 | 侧栏按标题层级显示可折叠大纲，支持过滤，点击跳到对应标题 | 已验收（模拟 IPC） · `OutlineView.tsx`：层级、过滤与点击跳转 |
| DC-032 | 编辑器内导出 Word | 从「设置 → MD 转 Word」把当前文档按样式或完整模板导出 DOCX，默认模板与模式可保存，可选包含批注；已有输出受保护 | 已实现 · 入口移至设置 · `editor/src/features/settings/WordExportSettings.tsx` → `docflow md-to-word --with-notes`；设置页经模拟 IPC 验收，导出逻辑沿用此前实跑结果 |
| DC-033 | 编辑器批注 | 选中正文添加批注，侧栏列出并定位；批注按原文与前后文锚定，编辑后重新定位，无法定位的标记为待定位；数据沿用 `.documentcraft/reader-spike.sqlite3` | 已验收（CLI 实跑 + 模拟 IPC） · `annotations.ts`、`CommentsPanel.tsx`、`docflow notes` |
| DC-034 | Copilot 工作区整理 | 交互对应 Obsidian Copilot 的 Quick Chat：流式回答与停止；当前笔记、选区、[[笔记]] 与 + / @ 添加的上下文；/ 命令；对话与工作区检索两种模式；消息复制、编辑、插入或替换、重新生成、删除；对话自动保存与历史；AI 连接沿用已有配置 | 已验收（模拟 IPC） · `editor/src/features/copilot/`、`docflow chat`；流式对话经本地假 API 实跑，真实 AI 服务未请求 |
| DC-035 | 编辑器内科研配图 | 从「设置 → 科研流程图」对当前文档或选定报告发起配图分析，可保存绘图风格，确认外发后预览并选择回插 | 已实现 · `editor/src/features/settings/FigureSettings.tsx` → `docflow illustrate --stage`；已核对原生设置、选报告和发送确认窗口，见 DC-061 |
| DC-036 | 编辑器 AI 设置 | 兼容 API 与 ChatGPT 套餐两种连接；登录、取消、退出、模型和推理强度选择并保存；API Key 仅保留在当前会话 | 部分验收 · 移入「设置 → AI 连接」`editor/src/features/settings/AIConnectionSettings.tsx`；登录、取消与模型读取未执行 |
| DC-037 | Python sidecar JSON 接口 | `docflow` 为编辑器提供 notes、share、illustrate、assistant、ai 子命令，统一 JSON 输出与非零失败码 | 已验收 · `editor_api.py`、`cli.py`；notes、share、md-to-word、assistant search、ai status 实跑 |
| DC-040 | 目录约定 | 按 AGENTS.md「目录约定」划分 editor/、core/、scripts/、out/、local/；构建产物只写入 out/，私有资料在 local/ | 已实现 · AGENTS.md；Python 与 Rust 测试在新路径下通过 |
| DC-041 | Obsidian 配色与布局 | 浅色、深色两套 Obsidian 默认主题配色，可跟随系统；Ribbon、左右侧栏、视图标题和状态栏布局参照 Obsidian | 已验收（模拟 IPC） · `editor/src/styles/tokens.css`、`settings/theme.ts` |
| DC-042 | 设置入口 | 左侧导航分组的设置窗口：外观、快捷键、Copilot、AI 连接、MD 转 Word、科研流程图；设置持久化 | 已验收（模拟 IPC） · `editor/src/features/settings/`、`src-tauri/src/settings.rs` |
| DC-043 | 编辑快捷键 | 默认 Ctrl+1～6 为 1～6 级标题、Ctrl+0 为正文段落、Ctrl+T 插入表格；全部快捷键可录制、清除、恢复默认，冲突时提示并移除原绑定 | 已验收（模拟 IPC，真实按键） · `editor/src/settings/` |
| DC-044 | 编辑区右键菜单与插入表格 | 右键菜单含剪切、复制、粘贴、全选、插入表格、表格增删行列、添加批注和 Copilot 子菜单；插入表格可在网格中选择行列数，首行为表头 | 已验收（模拟 IPC） · `editor/src/editor/EditorContextMenu.tsx`、`InsertTablePicker.tsx` |
| DC-045 | Copilot 命令与 Quick Ask | 命令以 Markdown 保存在 copilot-custom-prompts/，格式与 Obsidian Copilot 相同，可生成默认命令；右键或快捷键打开 Quick Ask，结果可复制、插入、替换选区或追问 | 已验收（模拟 IPC） · `editor/src/features/copilot/` |
| DC-046 | 显示所有文件 | 「设置 → 文件」可开启显示所有文件：目录树列出工作区内全部文件和空文件夹（隐藏目录仍不显示），非 Markdown 文件置灰、点击用系统默认应用打开（DC-052）；默认关闭，保持只显示 Markdown | 已验收（模拟 IPC）· `editor/src/features/settings/FilesSettings.tsx`、`src-tauri/src/workspace.rs` 的 `list_tree(show_all)`；Rust 测试覆盖 |
| DC-047 | 目录树新建 Markdown 与文件夹 | 文件栏头部有「新建 Markdown」「新建文件夹」按钮，在最近点击的文件夹（默认工作区根目录）下输入名称创建；Markdown 缺扩展名时补 .md 并打开；同名、含非法字符的名称被拒绝且不覆盖；默认视图中完全空的文件夹也保留 | 已验收（模拟 IPC）· `editor/src/sidebar/FileTree.tsx`、`documentActions.ts`、`workspace.rs` 的 `create_markdown`/`create_folder`；Rust 测试覆盖 |
| DC-048 | 内置 Word 模板 | 「我的文档模板」随安装包内置，MD 转 Word 默认使用；「设置 → MD 转 Word」可更换为自定义 .docx，也可恢复内置模板 | 已实现 · `editor/resources/builtin-template.docx`、`src-tauri/src/lib.rs` 的 `builtin_template`、`WordExportSettings.tsx`；用内置模板经 docflow 导出成功（样式模式），界面与安装包未测试 |
| DC-049 | 最近打开的文件夹 | 欢迎页列出最近打开的工作区（最多 10 个，最新在前），点击直接打开，× 只从列表移除；记录保存在编辑器设置中 | 已验收（模拟 IPC）· `editor/src/components/RecentWorkspaces.tsx`、`documentActions.ts`、`settings/schema.ts` 的 `history` |
| DC-050 | 标题级别显示 | 编辑区每个标题左侧显示 H1～H6，大纲每行显示级别；h4～h6 字号区分，h6 用次要文字色 | 已验收（模拟 IPC）· `editor/src/styles/app.css`、`tokens.css`、`sidebar/OutlineView.tsx` |
| DC-051 | 工作区文档搜索 | `Ctrl+F` 在侧栏顶部（标签栏下方）出现搜索框，在当前工作区所有 Markdown 中按文件名和正文搜索（不区分大小写）；有关键词时结果替换目录树，按文件分组，显示行号与带高亮的上下文；点击结果打开文档并选中对应文字；Esc 或 × 关闭搜索并恢复目录树；侧栏只有「文件」「大纲」两个标签；隐藏目录不搜索，结果数量有上限并提示 | 已验收（模拟 IPC + Rust 测试）· `editor/src/sidebar/SearchView.tsx`（`SearchBar`、`SearchResults`）、`Sidebar.tsx`、`store.ts` 的 `searchOpen`；默认快捷键由 `Ctrl+Shift+F` 改为 `Ctrl+F`，设置读取时迁移旧默认值 |
| DC-053 | 图片插入与显示 | `file:///` 与本地绝对路径的图片正常显示；找不到的图片显示「找不到图片」占位和原路径；粘贴截图或图片、右键「插入图片」时把图片保存到文档旁的 `assets/` 并以相对路径插入；粘贴内容中引用本地临时文件的图片在粘贴时复制到 `assets/`；不覆盖已有文件 | 已验收（模拟 IPC + Rust 测试）· `editor/src/editor/imageSupport.ts`、`assets.ts`、`src-tauri/src/images.rs`；不能找回已被清理的临时图片 |
| DC-054 | 多文档页签 | 编辑区顶部为页签栏，打开文档时新增或切换页签；每个页签保留各自内容、撤销历史与未保存状态；页签可关闭（未保存时询问），Ctrl+W 关闭、Ctrl+Tab / Ctrl+Shift+Tab 切换；关闭窗口时检查所有页签 | 已验收（模拟 IPC）· `editor/src/components/DocumentTabs.tsx`、`documentActions.ts` 的页签现场、`editorHandle.ts` 的 `snapshotDocument`/`restoreDocument` |
| DC-055 | 侧栏宽度拖动 | 左侧栏与右侧栏边缘可拖动调整宽度，有最小和最大宽度，双击恢复默认；宽度保存在设置中，重启后保留 | 已验收（模拟 IPC）· `editor/src/components/PaneResizer.tsx`、`settings/schema.ts` 的 `layout`、`tokens.ts` 的 `paneWidth` |
| DC-056 | 状态栏工作区切换 | 状态栏左侧只显示当前工作区文件夹名，悬停显示完整路径；点击弹出最近打开的工作区列表，选择后切换，也可打开其他文件夹 | 已验收（模拟 IPC）· `editor/src/components/WorkspaceSwitcher.tsx` |
| DC-057 | 全部折叠与全部展开 | 文件树头部和大纲头部各有「全部折叠」「全部展开」按钮，一键折叠或展开所有文件夹、所有带子标题的标题 | 已验收（模拟 IPC）· `editor/src/sidebar/FileTree.tsx`、`OutlineView.tsx` |
| DC-058 | 搜索范围模式 | 搜索框左侧的范围按钮提供三种模式：「所有」（所有文件的文件名 + 正文，正文含纯文本和 DC-059 的 Word、Excel、PowerPoint、PDF）、「所有文件名」（只匹配文件名，含非 Markdown 文件）、「所有正文」（只匹配正文，含纯文本与 DC-059 的文档）；模式保存在设置中；点击 Markdown 结果在编辑器打开，其他文件用系统默认应用打开（程序和脚本拒绝运行）；隐藏文件夹不搜，文本文件自动识别 UTF-8、GBK、GB18030、Big5 等编码（DC-066 采用的 chardetng + encoding_rs），无法识别编码或含二进制内容的只按文件名匹配 | 已验收（模拟 IPC + Rust 测试）· `editor/src/sidebar/SearchView.tsx`、`settings/schema.ts` 的 `files.searchMode`、`src-tauri/src/workspace.rs` 的 `SearchMode` |
| DC-059 | Word、Excel、PowerPoint、PDF 正文搜索 | 侧栏搜索的「所有」「所有纯文本正文」两种模式同时检索 docx、xlsx、pptx、pdf 的正文：首次搜索后台解析并建立文本缓存（保存在应用数据目录，按文件修改时间与大小判断是否过期，增量更新，不写入工作区），索引期间显示进度、完成后自动刷新结果；结果显示所在页、段或行，点击用系统默认应用打开；加密、损坏和扫描件（无文字层）跳过并计数提示；旧版 doc、xls、ppt 暂不解析 | 已验收（Rust 测试 + 真实工作区 + 模拟 IPC）· `src-tauri/src/extract.rs`、`textindex.rs`、`workspace.rs` 的 `index_workspace`/`search_workspace`，`editor/src/sidebar/searchIndex.ts`、`SearchView.tsx` |
| DC-060 | 大工作区（网络共享、数万文件）可打开与搜索 | 打开文件夹时目录树有读取预算（条目数与时间），预算内读完保持原有行为（只显示含 Markdown 的文件夹）；超出预算自动改为按需加载：只读顶层，展开哪个文件夹才读哪个，并说明；逐项读取不再为每个文件额外访问网络；搜索遇到大工作区时在后台扫描文件列表并显示进度，之后搜索使用缓存列表而不是每次重新遍历；大工作区不自动对 Word、Excel、PowerPoint、PDF 和 Markdown 建立正文索引，提供手动建立的按钮；大工作区里 txt、csv、代码等其他纯文本只能按文件名搜索 | 已验收（Rust 测试 + 真实网络共享 + 模拟 IPC）· `src-tauri/src/workspace.rs` 的 `list_tree`/`list_dir`/`walk_files`/`ensure_scan`、`textindex.rs` 的 `FileRec`/`ScanResult`，`editor/src/sidebar/FileTree.tsx`、`SearchView.tsx`、`searchIndex.ts` |
| DC-061 | 科研配图重做 | 设置入口读取报告并生成带锚点和取证范围的图位计划，按图并行生成和校验组件树；浏览器按版心和印刷字号排版、检查版面并输出高分辨率 PNG；用户逐张预览、改字、调整版式、重生成和选择回插，审核清单记录失败或跳过项；七张参考图的分区、流向和版式在样张、生成提示词和版式选项中一一对应，六阶段保留单排及局部判断回线 | 已实现 · `core/src/documentcraft/figure_workflow.py`、`figure_skill.md`、`illustration.py`、`editor/src/features/figures/`、`FigureSettings.tsx`；上一版真实报告回插 23 张，WPS 图题同页；本轮七种版式修订未测试 |
| DC-064 | 文件树右键菜单 | 在文件树的文件和文件夹上右键，菜单含复制、剪切、粘贴（文件夹或空白处）、删除、复制完整文件地址、属性。复制与剪切只在应用内记录，粘贴到目标文件夹，重名时自动加「- 副本」，不覆盖；剪切的条目置灰；删除前确认并移入回收站，已在页签中打开的文件先关闭（有未保存修改时询问）；已打开的文件不可剪切移动；复制完整文件地址写入系统剪贴板；属性窗口显示名称、类型、完整路径、大小（文件夹统计内容，条目太多时标注为部分统计）、创建、修改、访问时间和只读状态 | 已验收（模拟 IPC + Rust 单元测试）· `editor/src/sidebar/FileTree.tsx`、`TreeContextMenu.tsx`、`FileProperties.tsx`、`components/PopupMenu.tsx`、`documentActions.ts`、`src-tauri/src/fileops.rs`；浏览器中经模拟 IPC 验证：右键菜单六项（无内容时粘贴置灰）、剪切后条目置灰、粘贴到文件夹时 `move_entry` 的源与目标正确、删除确认框与 `trash_entry` 调用、复制完整文件地址写入剪贴板、属性窗口各项；`fileops.rs` 的 4 个单元测试在 Linux 下独立编译运行通过；未测试：Tauri 完整编译（新增依赖 `trash`）、Windows 回收站与真实文件的复制和移动 |
| DC-065 | 移除最近文件夹 | 状态栏工作区切换菜单的「最近打开」每一项右侧有移除按钮，只把该文件夹从最近列表移除，不动磁盘上的文件夹，不关闭当前已打开的工作区；欢迎页的移除按钮行为一致 | 已验收（模拟 IPC）· `editor/src/components/WorkspaceSwitcher.tsx`、`documentActions.ts` 的 `forgetWorkspace`；浏览器中点移除按钮后，保存的最近列表只剩其余项，且没有触发任何删除、移动、复制命令；未测试：Windows 原生窗口中的实际操作 |
| DC-066 | 搜索结果预览页 | 在搜索结果中左键点击文件，中间文档区弹出预览页，显示识别到了什么：文件名命中显示文件名并高亮，Markdown 标题命中标注标题级别，正文命中显示所在页、段或行及上下文并高亮命中文字；点击某处匹配时定位到对应命中；预览页提供在编辑器或默认应用中打开、关闭（Esc）；双击结果文件仍直接打开。正文由现有提取模块读取（Markdown、txt 等纯文本，Word、Excel、PowerPoint、PDF），扫描件和加密文件说明原因 | 已验收（模拟 IPC + Rust 单元测试）· `editor/src/features/preview/SearchPreview.tsx`、`sidebar/SearchView.tsx`、`src-tauri/src/preview.rs`；浏览器中验证：Markdown 标题命中标注 H2 并加粗、正文多处命中同行高亮、PDF 显示页码、文件名命中显示「文件名」块、点击某处匹配时强调对应块、Esc 只关闭预览保留搜索；`preview.rs` 的 3 个单元测试在 Linux 下独立编译运行通过；调研结论：AnyTXT Searcher 本身是闭源免费软件，没有可采用的源码；GitHub 上的开源替代品 alrece/pivotsearch（Apache-2.0，同为 Tauri 2 + Rust）已分析并采用其做法：①用 chardetng + encoding_rs 识别 GBK、GB18030、Big5、UTF-16 等文本编码（`extract.rs` 的 `decode_text_bytes`，搜索、索引、预览共用，旧版缓存的「不是 UTF-8」错误项自动作废重读），②预览里自动滚动到首个命中并可在命中之间逐个切换；未采用的：Tantivy 倒排索引、jieba 分词、PDFium（现有索引与 `pdf-extract` 能满足当前需求，换引擎改动面过大）；未测试：真实 Word、Excel、PowerPoint、PDF 文件的预览，Tauri 完整编译 |

## Should

| ID | 功能 | 验收条件 | 状态 |
| --- | --- | --- | --- |
| DC-062 | 科研配图分阶段模型与视觉复核 | 规划、单图和视觉复核可使用同一连接下的不同模型；视觉复核默认关闭，开启后最多两轮，修订失败可保留原预览 | 已实现 · `figure_workflow.py`、`ai.py`、`siwc.py`、`editor/src/features/figures/workflow.tsx`、`FigureSettings.tsx`；模拟接口核对了视觉复核的图片和取证载荷，真实模型未测试 |
| DC-063 | 自动检查与更新 | 启动时与之后每 6 小时检查本仓库 GitHub 最新正式 Release（预发布不拉取），间隔以上次检查时间计算，重启不重复请求；发现新版本后默认自动下载，状态栏右侧提示，由用户点击「重启并安装」，不自动关闭程序；「设置 → 关于与更新」显示当前版本、上次检查时间，可手动检查，可分别关闭自动检查与自动下载，显示新版本说明与下载进度；安装包经 minisign 签名校验；有未保存页签时先询问，有 docflow 任务时拒绝安装；网络失败只在设置页显示，下个周期重试；开发模式不自动检查 | 已实现（待签名密钥与公开仓库）· `editor/src/features/updater/`、`settings/schema.ts` 的 `update`、`src-tauri/src/docflow.rs` 的 `docflow_active`、`tauri.conf.json` 的 `plugins.updater`、`scripts/publish-release.ps1`；前端 `tsc --noEmit` 通过；未测试：本环境无 Rust 与 Windows 工具链，未编译 Rust、未运行界面、未实际检查与安装；`Cargo.lock` 需在下次编译时更新 |

| ID | 功能 | 验收条件 | 状态与实现 |
| --- | --- | --- | --- |
| DC-005 | 预检查和机器可读结果 | 报告模板锚点异常、缺失图片和转换错误，提供 JSON 输出 | 已实现 · `--check`、`--json`；图像支持本地文件 |
| DC-006 | 完整模板目录更新 | 请求编辑器在打开时更新域 | 已实现 · 写入 `w:updateFields`，实际更新取决于 Word/WPS |
| DC-013 | 脚注资源保真 | 两种模板模式保留脚注、外部链接和本地图像，脚注引用指向输出包内正确的资源 | 样例已验收 · `core/src/documentcraft/templates.py` |
| DC-052 | 非 Markdown 文件用默认应用打开 | 开启「显示所有文件」后，点击置灰的非 Markdown 文件用系统默认应用打开；可执行文件和脚本不直接运行，只提示 | 已验收（模拟 IPC + Rust 测试）· `sidebar/FileTree.tsx` → `documentActions.ts` 的 `openWithSystem` → `lib.rs` 的 `open_path`（`BLOCKED_OPEN_EXTENSIONS`） |

## Could

| ID | 功能 | 验收条件 | 状态与实现 |
| --- | --- | --- | --- |
| DC-007 | 模板样式诊断与布局质检 | 报告缺失的语义样式和特殊对象，提供版式保真记录 | 待排期 |
| DC-039 | 编辑器源码模式 | 在所见即所得与 Markdown 源码之间切换 | 待排期 |

## Won’t

| ID | 功能 | 验收条件 | 状态与实现 |
| --- | --- | --- | --- |
| DC-038 | 编辑器安装包 | Tauri 打包含 `docflow` sidecar 的 Windows 安装包 | 已实现 · 部分验收。`scripts/build-sidecar.ps1` → `out/sidecar/`，`npm run bundle`（`scripts/bundle-editor.ps1`，MSVC 工具链）生成 `DocumentCraft_0.2.8_x64-setup.exe`；见 2026-11-12 打包验收记录 |
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

## 2026-11-12 科研配图离线试跑

- 用历史去图版 DOCX 的副本，串联 Python sidecar、本机模拟兼容 API、Chrome 排版和 DOCX 回插。读取 735 个文档块，识别 32 处图题或引用。模拟规划给出 3 个图位，分图请求只包含相应取证段落。
- 验证一张图在取证校验失败后重试成功，另一张图因过于扁长自动重排成功。3 张候选均完成栅格化和模拟视觉复核请求。对其中一张替换原文短语并重新出图，选 2 张回插。核对 DOCX 新增 2 个内嵌图片、PNG 均约 384 dpi、审核清单记录另 1 张未回插，源文件哈希一致。
- Python 8 项通过，Rust 25 项通过、4 项按原设置跳过，前端生产构建通过。修复 PyInstaller 从 spec 目录解析相对路径导致配图规范漏打的问题。重新打包后，用只含 System32 的 PATH 运行打包版 sidecar，重复通过离线试跑。
- NSIS 安装包解包后可以启动原生编辑器，打开科研流程图设置、选择 DOCX 并查看发送前确认。WPS 以只读方式打开离线配图稿，确认两张图分别在第 10 页和第 22 页且与图题同页。
- 七个样张通过浏览器版面检查并输出 PNG。三个样张经标题分行、泳道折行、缩短标签或增加箭头标签留白后重新验收。七张原始参考图逐一对照、NSIS 安装与卸载流程未执行。

## 2026-11-12 科研配图真实模型验收

- 用配置中的 ChatGPT 文本模型分析 54 页去图稿，视觉复核关闭。首次规划 23 个候选并覆盖 32 处引用和图题。首轮约 16 分钟，回插 21 张，另两张分别因引文未逐字匹配和箭头标签遮挡被拦下。
- 顺序链标签改为在布局中占位，窄列内可换行。对取证失败图单独重生成，沿用原图位计划重新排版和回插。最终 23 张均通过版面检查，覆盖 32 处引用和图题，审核清单保留 5 项待确认。PNG 均约 384 dpi，逐一核对了插入锚点，源稿与测试副本哈希一致。
- WPS 只读重排后共 74 页，23 张图全部与图题同页。修正后七个样张再次导出成功，重新构建的 Windows x64 NSIS 安装包通过完整性检查。真实视觉复核与微软 Word 未验证。

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

## 2026-11-09 安装包

- `scripts/build-sidecar.ps1` 打包 sidecar 时显式加入 `sqlite3.dll`。conda 版 Python 把它放在 `Library\bin`，此前漏打，EXE 一启动就报 DLL load failed。脚本改回纯 ASCII 注释：Windows PowerShell 5.1 按 ANSI 代码页读取无 BOM 的 UTF-8，中文注释会吞掉下一行。
- sidecar 复制到只含 `System32` 的 PATH 环境中运行，`notes list` 与带批注的 `md-to-word` 均成功。
- `npm run bundle` 使用 `tauri.bundle.conf.json`，只在安装包中带上 sidecar，开发模式仍运行 `core/src/` 源码。NSIS 脚本把 `DocumentCraft-cli.exe` 安装到编辑器同目录。release 版直接启动，窗口正常加载。安装、卸载流程未在本机执行。

## 2026-11-10 Obsidian 风格界面、设置与 Copilot

- 目录重组：`app/` → `editor/`；Python 核心（含 tests、tools、spikes）→ `core/`；构建产物 → `out/`；验收文档 → `local/`。约定写入 AGENTS.md。`core/` 以 `pip install -e core` 重新安装后，8 项 Python 测试与 4 项 Rust 测试（含开发模式下从 `core/src` 启动 docflow）通过。
- `docflow chat`：用本地假的兼容 API 验证 SSE 解析，输出逐段 `delta` 与 `done`；空对话、最后一条非用户消息返回 JSON 错误与非零退出码。ChatGPT 套餐复用原 Responses 流式读取。
- 新模块逻辑检查 21 项通过：快捷键规范写法与匹配、冲突查找、设置合并与类型校验、对话记录的保存与解析往返（含 CRLF）、路径工具。
- 浏览器中加载真实 `App` 并模拟 Tauri IPC：真实按键 Ctrl+2、Ctrl+5、Ctrl+0 切换标题与正文；Ctrl+T 打开插入表格并插入 2×4 表格；右键菜单在表格内显示行列操作并插入行；设置中录制 Ctrl+Alt+B、与 Ctrl+1 冲突时移除原绑定、恢复默认并写入设置文件；深色主题生效。Copilot 生成 11 个默认命令，发送消息时附带当前笔记与 [[笔记]] 内容，流式回答渲染表格并自动保存对话；/ 与 [[ 补全、新对话、从历史重新打开；右键运行命令与 Ctrl+Shift+K 的 Quick Ask 均能替换原选区。
- 验收中修复：对话记录文件名去掉 Obsidian 笔记名不允许的 `[ ] # ^`；单段回答替换句中选区时按行内内容插入，不再拆开原段落。
- 未执行：原生窗口内逐项点击、真实 AI 请求、ChatGPT 登录。

## 2026-11-10 新目录下重新打包

- `scripts/build-sidecar.ps1` 从 `core/` 打包到 `out/sidecar/DocumentCraft-cli.exe`。复制到 PATH 只含 System32 的临时目录运行：`chat` 对本地假 API 逐段输出并以 `done` 结束，文字为正确的 UTF-8；带批注的 `md-to-word` 写入 1 条批注并生成中文文件名的 DOCX。
- `npm run bundle`（先由 `scripts/stage-runtime.ps1` 把 WebView2Loader.dll、libunwind.dll 放入 `out/runtime/` 并随安装包安装）生成 77 MB 的安装包，NSIS 脚本从 `out/sidecar/` 取 sidecar 并安装到编辑器同目录。release 版直接启动，窗口正常响应。安装、卸载流程未在本机执行。

## 2026-11-10 修复安装包缺少运行库

- 现象：安装后启动报「找不到 WebView2Loader.dll」。原因：gnullvm 构建动态链接 WebView2Loader.dll 与 libunwind.dll，安装包未携带；开发机 PATH 里恰好有 libunwind 所以未暴露。
- 修复：`scripts/stage-runtime.ps1` 暂存两个 DLL 到 `out/runtime/`，`tauri.bundle.conf.json` 作为资源安装到 exe 同目录，`npm run bundle` 自动先执行。
- 验收：按安装布局复制到临时目录，PATH 仅含 System32 启动，进程正常运行；未实际运行安装程序。

## 2026-11-10 显示所有文件与新建按钮

- Rust 测试 6 项通过（含显示所有文件、空文件夹、新建不覆盖、非法名称）；tsc 与 vite build 通过。
- 浏览器加载真实 `App` 并模拟 IPC：新建文件夹、在新文件夹内新建笔记并打开、重名时状态栏提示且输入框保留、Esc 取消；设置中开关「显示所有文件」后目录树出现置灰的 .csv。
- 顺带修复：打开空的 Markdown 会被标为「未保存」（编辑器载入后自行规范文档触发更新），现与载入基线比较，只有内容真的变化才标记。
- 未执行：原生窗口内点击；新安装包尚未重新打包。


## 2026-11-10 版本 0.2.1

- 编辑器版本升为 0.2.1：包含运行库修复、显示所有文件与目录树新建按钮。安装包 `DocumentCraft_0.2.1_x64-setup.exe`，未实际运行安装程序。

## 2026-11-10 内置 Word 模板

- 模板来自用户提供的「我的文档模板.docx」，无 {{DOCFLOW_CONTENT}} 锚点，自动识别为样式模式。
- `docflow md-to-word` 使用该模板导出含标题、正文、表格的样例，生成成功；tsc 与 cargo check 通过。未在界面或安装包中验证。

## 2026-11-10 改用 MSVC 工具链打包（0.2.2）

- 现象：gnullvm 构建的编辑器 exe 被火绒判为恶意文件并隔离（编译产物与安装位置都会触发），打包时还出现「文件被占用」。
- 处理：`scripts/bundle-editor.ps1` 固定用 rustup 的 `stable-x86_64-pc-windows-msvc` 编译并打包。WebView2 加载器静态链接，安装包不再携带 WebView2Loader.dll、libunwind.dll，删除 `scripts/stage-runtime.ps1`。
- 验收：0.2.2 安装包与编辑器 exe 复制到未加信任的 `%LOCALAPPDATA%\Temp` 子目录，PATH 只含 System32 启动，进程正常运行，文件未被隔离；同一位置的 gnullvm 构建此前在运行时被隔离。安装程序未实际运行；未做代码签名，其他杀毒软件和 SmartScreen 仍可能提示。

## 2026-11-10 最近文件夹与标题级别

- 浏览器加载真实 `App` 并模拟 IPC：设置中预置含非法项的最近列表，欢迎页只列出有效路径；从列表打开工作区后目录树正常，并被移到列表最前写回设置。编辑区 H1～H3 标题左侧出现对应级别标记，位于标题左侧留白内；大纲行显示 H1、H2、H3。tsc 通过。
- 未执行：原生窗口内查看（截图因窗口隐藏未取得）；h4～h6 的显示未用样例确认。

## 2026-11-10 工作区搜索与默认应用打开

- 搜索（DC-051）：Rust 测试覆盖文件名匹配、多行与同行多处匹配、大小写不敏感、序号与上下文截取，隐藏目录和非 Markdown 文件不参与。浏览器模拟 IPC：Ctrl+Shift+F 切到「搜索」视图并聚焦输入框；搜「重复句」列出 1 个文档 2 处匹配，点击第 2 条后打开文档并选中第二段中的「重复句」；按文件名搜「笔记」时文件名高亮；无结果时提示；切换视图后关键词保留。tsc 通过。
- 默认应用打开（DC-052）：模拟 IPC 中点击 `数据.csv` 调用 `open_path` 并在状态栏提示已打开；点击 `安装.exe` 被拒绝并显示原因。Rust 测试覆盖拦截的扩展名（大小写不敏感）与放行的普通文件。
- 未执行：原生窗口中的实际打开效果（系统默认应用是否启动）、大型工作区的搜索耗时；截图因窗口隐藏未取得，界面样式未目视检查。

## 2026-11-10 页签、侧栏调宽、工作区切换与图片

- 图片（DC-053）：用户文档中的 123 处图片均为 `![img](file:///C:\Users\…\Temp\ksohtml31332\wpsN.png)`，即从 WPS 粘贴时留下的临时文件引用，该目录已被清理，图片无法找回；编辑器此前也不识别 `file:///` 地址。现在 `file:///` 与盘符路径按本地文件显示，缺失图片显示「找不到图片：文件名」占位；粘贴截图保存到 `assets/`；粘贴 WPS 内容时把仍存在的临时图片复制到 `assets/` 并改写为相对路径，已不存在的保留原地址并提示；右键「插入图片…」。Rust 测试覆盖写入 `assets/`、重名加序号不覆盖、拒绝非图片扩展名和空数据。模拟 IPC：连续粘贴两张截图与一段含临时图片的 HTML，图片按顺序插入、不替换相邻图片，可复制的改写为 `assets/wps1.png`。
- 修复：以图片或表格结尾的文档打开后被误标为「未保存」。原因是 TipTap TrailingNode 在打开后的第一个事务（载入批注）中补空段落；`loadMarkdown` 现在先应用插件的补全再记录未修改基线。
- 页签（DC-054）：模拟 IPC 中打开两篇文档，在第二篇输入后切回第一篇，内容与未保存标记正确；Ctrl+Tab / Ctrl+Shift+Tab 切换；切回后撤销只影响本页签；Ctrl+W 关闭未保存页签时询问并保存；关闭最后一个页签回到欢迎页。
- 侧栏调宽（DC-055）：模拟拖动左侧栏 +100px 后宽度 360 并写入设置，拖过上限夹到 560，双击恢复 260；右侧栏向左拖 80px 后 440。
- 工作区切换（DC-056）：状态栏左侧显示文件夹名，title 为完整路径；菜单列出最近工作区和「打开其他文件夹…」，选择后切换并关闭菜单。
- tsc 通过，Rust 9 项测试通过。未执行：原生窗口内目视检查（窗口隐藏，截图未取得）、真实 WPS 剪贴板粘贴；从资源管理器拖放图片文件未实现。

## 2026-11-10 侧栏搜索框与全部折叠、展开

- 搜索（DC-051 调整）：去掉「搜索」标签，`Ctrl+F` 在标签栏下方出现搜索框并聚焦；输入关键词后结果替换目录树，Esc 或 × 关闭并恢复目录树；在大纲视图按 `Ctrl+F` 会切回文件视图。模拟 IPC：「流量」命中 2 个文档 5 处，点击「重复句」的第 2 条后选中第二段中的文字，结果列表保持显示。设置里保存的旧默认 `Ctrl+Shift+F` 读取时迁移为 `Ctrl+F`；若有人刻意把搜索绑成 `Ctrl+Shift+F`，也会被迁移，需重新录制。
- 全部折叠、全部展开（DC-057）：文件树头部和大纲头部各两个按钮。模拟 IPC：展开后列出所有层级的文件夹与文件，折叠后只剩顶层；大纲折叠后只剩 H1，展开后恢复 4 行；头部在默认宽度下不溢出。tsc 通过。
- 未执行：原生窗口内目视检查（窗口隐藏，截图未取得）。

## 2026-11-10 搜索范围模式

- 搜索框左侧的放大镜改为范围按钮，菜单三项：所有、所有文件名、所有纯文本正文；选择保存在设置 `files.searchMode`，未知值读取时回退为「所有」。后端 `search_workspace(root, query, mode)` 的纯文本按扩展名白名单（md、txt、csv、json、yaml、代码与日志等 44 种）判断，Word、PDF、Excel 等不读取正文。
- Rust 测试：「所有」列出文件名匹配的 docx 与 txt 正文匹配，xlsx 正文不读；「所有文件名」不读正文；「所有纯文本正文」文件名不参与、非 UTF-8 的 txt 被跳过；隐藏目录不搜；未知模式报错。共 10 项通过。
- 模拟 IPC：三种模式切换后结果与提示语正确；点击 Markdown 结果在编辑器打开，点击 docx 或 txt 结果调用系统默认应用；菜单打开时 Esc 只关菜单，再按一次才关闭搜索。tsc 通过。
- 限制：单文件超过 4 MB 不读正文；最多收集 2 万个文件。（原先「非 UTF-8 的 txt 只能按文件名匹配」的限制已由 DC-066 的编码识别解除。）未执行：原生窗口目视检查。

## 2026-11-10 文件树头部固定

- 文件树头部（文件夹名与新建、折叠、展开、刷新按钮）和新建输入框固定在侧栏顶部，只有文件列表滚动（`.dc-tree` 改为纵向 flex，`.dc-tree-root` 自身滚动）。模拟 IPC 在 260px 高的视口中验证：列表滚动 150px 后头部位置不变，侧栏容器本身不再滚动；滚动后新建输入框仍可见。未执行：原生窗口目视检查。

## 2026-11-10 Word、Excel、PowerPoint、PDF 正文搜索

- 做法：Rust 端解析文档（docx、xlsx、pptx 读 zip 内的 XML，pdf 用 pdf-extract），提取的文本按「文件修改时间 + 大小」缓存到应用数据目录 `search-cache`（不写入工作区），内存中保留一份索引供搜索；首次后台并行建立（最多 4 线程），之后增量更新；进度经 `search-index` 事件显示，索引期间搜索仍可用，结果按节流（3 秒）与完成时刷新。Word 的脚注、尾注、批注一并索引；PDF 中文跨行被切开的词在提取时重新连起；Office 的 `~$` 锁文件、超过 200 MB 的文件、加密或损坏的文件不索引，扫描件没有文字层，两者在结果上方提示数量。
- Rust 测试：xml 实体与数字引用、docx 段落与批注、pptx 幻灯片按数字排序与换页、xlsx 共享字符串与内联文本与工作表名、损坏与不支持文件不 panic、PDF 中文换行重排、折叠大小写保持字节长度、索引增量更新（缓存命中、过期重解析、删除后清理缓存、锁文件与 txt 不入索引）、文档搜索定位到页、段、行且大小写不敏感、覆盖统计；共 20 项通过。
- 真实工作区（只读）：446 个文档（docx、xlsx、pptx、pdf），首次建立索引 31 秒，重启后从缓存恢复 0.45 秒，无变化时更新 11 毫秒；内存中文本约 44 MB；搜索「流量」248 毫秒，53 个文件 500 处匹配，其中 49 个文件的命中来自文档，位置如「第 36 段」「第 3 页」；10 个文档解析失败（pdf-extract 在个别 PDF 上 panic，已捕获），24 个无文字层。
- 模拟 IPC：索引进行中显示「正在建立…（1/2）」并只含已索引文档，完成后自动刷新出 PDF「第 2 页」、docx「第 2 段」；有未索引文档时补做一次增量索引且不重复触发；「所有文件名」不触发索引也不显示提示；点击文档结果用系统默认应用打开。tsc 通过。
- 限制与未执行：不解析旧版 doc、xls、ppt 和 WPS 专有格式；不识别扫描件和图片中的文字（无 OCR）；没有对大工作区做长时间、低内存占用的压力测试；Copilot 工作区检索仍只读 Markdown，未接入此索引；原生窗口目视检查未执行。

## 2026-11-10 大工作区（网络共享）可打开与搜索

- 现象：打开 `\\SVR1\data\JinSiLu\保留\科研部` 时界面长时间没有反应。原因是目录树一次读完整棵树（逐项再访问一次网络），搜索每次也重新遍历全部文件。该共享实测超过 30 万个文件，只有 12 个顶层文件夹。
- 处理：目录树有读取预算（4000 条目或 2 秒），预算内读完保持原有行为；超出就改为按需加载，只读顶层，展开才读取，并在树上方说明；逐项改用 `DirEntry::metadata`（Windows 上直接取目录枚举带回的属性，不再为每个文件访问一次网络）。搜索现场遍历超过 2 秒时转为后台扫描并缓存文件列表（带进度，30 分钟内复用，可手动重新扫描），大工作区不自动建立文档索引，提供「建立正文索引」按钮；大工作区的 Markdown 一并进索引，其他纯文本只能按文件名搜索。
- 真实共享上的实测（只读）：整树读取 2.0 秒后按预算放弃；顶层一层 2 毫秒、12 个文件夹；展开一个文件夹不到 1 毫秒；60 秒内扫描 200481 个文件；完整扫描 78 秒，达到 30 万文件上限（列表标记为不完整），其中可索引文档 9303 个；按文件名搜索「报告」0.67 秒、548 个文件；未建索引时按正文搜索 0.38 秒，没有读任何文件。
- Rust 测试 25 项通过：预算耗尽改按需、单目录条目过多的截断标记、文件扫描的上限与超时、网络路径判定为大工作区且扫描被缓存、大工作区纯文本走索引而不现场读取。模拟 IPC：大工作区只显示顶层并说明、展开显示「正在读取…」、嵌套展开、条目过多提示、全部展开不触发读取；搜索先提示正在扫描并显示已发现文件数、完成后自动搜索、说明文件列表几分钟前扫描并可重新扫描、点按钮手动建立索引后出现文档命中；小工作区行为不变。tsc 与 Release 构建通过。
- 限制与未执行：该共享超过 30 万文件，文件列表不完整，超出部分搜不到；首次扫描约 80 秒；没有真的对该共享手动建立正文索引（9303 个文档读取量大，未执行）；原生窗口中打开该共享的实际体验未验证。
