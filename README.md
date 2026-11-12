# DocumentCraft

面向科研文档的本地 Markdown 阅读编辑器，界面采用 Obsidian 默认主题的配色与布局。在工作区中浏览和编辑 Markdown，用 Copilot 提问和改写，添加批注，并在设置中按 Word 模板导出或生成科研流程图。整体范围和本轮优先级见 [Feature Ledger](FEATURE_LEDGER.md)，目录约定见 [AGENTS.md](AGENTS.md)。

| 目录 | 内容 |
| --- | --- |
| `editor/` | 阅读编辑器。Tauri 2 + React + TipTap，编辑核心移植自 [VMark](https://github.com/xiaolai/vmark)（ISC，见 `editor/src/vendor/vmark/README.md`），侧栏为文件树、文档大纲和工作区搜索，编辑区为多文档页签 |
| `core/` | Python 核心与 `docflow` CLI：Markdown → DOCX 转换、批注存储与导出、科研配图、Copilot 对话与工作区检索、AI 连接。编辑器以 sidecar 方式调用 |
| `scripts/` | 构建脚本 |
| `out/`、`local/` | 构建产物与本机私有资料，不入库 |

## 阅读编辑器

左侧 Ribbon 依次为打开文件夹、打开文件、Copilot、批注，底部为设置。左侧栏「文件」列出工作区内的 Markdown 目录树（隐藏目录与链接不显示；「设置 → 文件」可改为显示所有文件）。工作区很大（网络共享、数万文件）时目录树自动改为按需加载：只读顶层，展开哪个文件夹才读取哪个；搜索则在后台扫描文件列表并缓存，Word、PDF 等文档和纯文本的正文索引改为在搜索结果上方点按钮后才建立，头部按钮可在选中的文件夹下新建 Markdown 和文件夹，也可一键全部折叠或全部展开；显示所有文件时，点击非 Markdown 文件用系统默认应用打开（程序和脚本除外）。「大纲」按标题层级列出当前文档，可过滤、折叠和全部折叠或展开，点击跳到标题。`Ctrl+F` 在侧栏标签栏下方打开搜索框，在工作区中搜索，搜索框左侧的范围按钮可切换「所有」（文件名 + 正文）、「所有文件名」、「所有正文」；正文包括 Markdown 等纯文本，以及 Word、Excel、PowerPoint、PDF（首次搜索时在后台建立索引，索引保存在应用数据目录，之后只增量更新；不识别扫描件中的文字）；结果替换目录树，点击 Markdown 结果打开文档并选中命中文字，其他文件用系统默认应用打开，`Esc` 关闭搜索。正文为所见即所得编辑，顶部页签可同时打开多篇文档（`Ctrl+W` 关闭，`Ctrl+Tab` 切换），左右侧栏边缘可拖动调宽（双击恢复）。状态栏左侧显示当前工作区文件夹名，点击可切换到最近打开的工作区。粘贴截图或右键「插入图片…」会把图片保存到文档旁的 `assets/` 并以相对路径插入；从 WPS 粘贴带图内容时，临时图片会复制到 `assets/`。Markdown 往返沿用 VMark 管线，保留原文空行、换行符、引用式链接、脚注、公式、提示块和前置元数据。工作区内的本地图片按文档所在目录解析。

### 快捷键与右键菜单

| 操作 | 默认快捷键 |
| --- | --- |
| 1～6 级标题 | `Ctrl+1` ～ `Ctrl+6` |
| 正文段落 | `Ctrl+0` |
| 插入表格 | `Ctrl+T` |
| 保存 | `Ctrl+S` |
| 在工作区中搜索 | `Ctrl+F` |
| 关闭当前页签 | `Ctrl+W` |
| 下一个 / 上一个页签 | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| 打开设置 | `Ctrl+,` |
| 打开或关闭 Copilot | `Ctrl+Shift+L` |
| Copilot：Quick Ask | `Ctrl+Shift+K` |

全部快捷键在「设置 → 快捷键」中录制修改，冲突时自动从原操作移除。Markdown 只有 1～6 级标题。编辑区右键菜单提供剪切、复制、粘贴、全选、插入表格（网格选择行列数，首行为表头）、表格内的增删行列、添加批注和 Copilot 子菜单。

### Copilot

交互对应 Obsidian 社区插件 Copilot 的 Quick Chat，AI 连接使用「设置 → AI 连接」中保存的配置。

- 当前笔记默认作为上下文徽标随每条消息发送，可移除；在编辑区选中的文字自动作为选区上下文，只随下一条消息发送。
- 输入区「+」或 `@` 添加笔记，`[[笔记标题]]` 引用笔记，开头输入 `/` 选择命令。Enter 发送（可改为 Shift+Enter）。
- 「对话」模式只依据附带的上下文回答；「工作区检索」模式先在本地检索相关摘录，回答下方列出可跳回原文的来源。
- 回答逐字显示，可停止。消息悬停后可复制、编辑（用户消息）、插入或替换到光标处、重新生成（回答）和删除。
- 对话自动保存为 `<工作区>/copilot/copilot-conversations/` 下的 Markdown，可在「对话记录」中搜索、重新打开或删除。
- 命令保存在 `<工作区>/copilot/copilot-custom-prompts/`，每个命令一个 Markdown 文件，frontmatter 与 Obsidian Copilot 相同，可共用。提示词中 `{}` 代表选区（无选区时为当前笔记），`{activeNote}` 代表当前笔记，`{[[笔记标题]]}` 代表指定笔记。「设置 → Copilot」可添加、编辑、删除命令或生成默认命令。
- 右键 → Copilot 提供 Quick Ask、添加选区到对话，以及勾选了「显示在右键菜单」的命令。结果面板可复制、插入到光标处、替换原选区，或继续追问。

### 批注

选中同一段内的文字，右键「添加批注」或在批注面板点「为选区添加批注」。批注按原文和前后文锚定，编辑正文后自动重新定位，无法唯一定位的标为「待定位」。批注保存在文档所在目录的 `.documentcraft/reader-spike.sqlite3`。「分享包」将当前 Markdown 和这篇文档的批注打成 ZIP，外部附件另行传递。

### 设置

| 分页 | 内容 |
| --- | --- |
| 外观 | 主题：跟随系统、浅色、深色（Obsidian 默认配色） |
| 快捷键 | 录制、清除、恢复默认 |
| Copilot | Copilot 文件夹、自动附带当前笔记、自动保存对话、发送快捷键、附加系统提示词、命令管理 |
| AI 连接 | 兼容 API 或 ChatGPT 套餐。API Key 只保存在本次会话内存，也可由 `OPENAI_API_KEY` 提供 |
| MD 转 Word | 内置「我的文档模板」（可更换为自定义模板，也可恢复内置）、模板模式、是否包含批注，并导出当前文档。批注无法定位或位于暂不支持的段落（含公式、图片、换行等）时会先提示，可明确跳过 |
| 科研流程图 | 默认绘图风格，并为当前文档生成配图，见下文「科研配图」 |

编辑器设置保存在 `%APPDATA%\app.documentcraft.editor\settings.json`，AI 连接设置由 docflow 保存在 `%LOCALAPPDATA%\DocumentCraft\ai-settings.json`。

### 运行编辑器

需要 Node.js 22+、Rust stable、[Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/)（Windows 需 WebView2 Runtime），以及下文「从源码构建和测试」中的 `.venv`。

```powershell
cd editor
npm install
npx tauri dev
```

编辑器按以下顺序寻找 `docflow`：环境变量 `DOCUMENTCRAFT_DOCFLOW` 指定的可执行文件；编辑器同目录的 `DocumentCraft-cli.exe`；仓库根目录 `.venv` 中的 Python（以 `-m documentcraft` 运行 `core/src/`）。

### 打安装包

先打包 sidecar，再生成 NSIS 安装包。安装包把 `DocumentCraft-cli.exe` 装在编辑器旁边，Python 运行时和 Pandoc 随 sidecar 内置。sidecar 只在 `tauri.bundle.conf.json` 中声明，开发模式不会复制它，仍直接运行 `core/src/` 源码。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-sidecar.ps1
cd editor
npm run bundle
```

sidecar 输出到 `out/sidecar/`。`npm run bundle` 调用 `scripts/bundle-editor.ps1`，固定用 rustup 的 MSVC 工具链（`stable-x86_64-pc-windows-msvc`，需 Visual Studio Build Tools 的 C++ 工具）编译：WebView2 加载器静态链接，不需要额外 DLL；gnullvm 构建会被部分杀毒软件（如火绒）误报隔离。安装包位于 `editor/src-tauri/target/release/bundle/nsis/`。目标机器需要 WebView2 Runtime，Windows 11 已自带。

### sidecar 接口

编辑器调用的子命令都向标准输出写 JSON，失败时为 `{"status": "error", "message": ...}` 并返回非零退出码。批注正文、对话内容和设置经标准输入传 JSON。

| 命令 | 用途 |
| --- | --- |
| `docflow chat` | Copilot 多轮对话，逐段输出 `{"type": "delta"}`，结束时输出 `{"type": "done"}` |
| `docflow notes list\|add\|update\|delete --source 文档.md [--id 编号]` | 读写批注 |
| `docflow md-to-word ... --with-notes [--skip-unresolved] --json` | 导出 Word 并写入批注 |
| `docflow share --source 文档.md --output 分享包.zip` | 打包 Markdown 与批注 |
| `docflow illustrate --source 报告 --style mono\|colored` | 科研配图 |
| `docflow assistant search\|organize --workspace 目录 --question 问题` | 工作区检索与整理 |
| `docflow ai status\|save\|login\|logout\|models` | AI 设置与 ChatGPT 登录 |

## 命令行转换

`docflow md-to-word` 按 DOCX 模板将 Markdown 转换为可编辑的 Word 文档。`scripts/build-sidecar.ps1` 可打包 `out/sidecar/DocumentCraft-cli.exe`，Python 运行时和 Pandoc 随 EXE 内置。

```powershell
.\out\sidecar\DocumentCraft-cli.exe md-to-word --input "报告.md" --template "科研报告模板.docx" --output "报告.docx"
```

## 科研配图

在「设置 → AI 连接」选连接方式。「兼容 API」使用兼容 `/chat/completions` 且支持 JSON 输出的服务，可配置地址和模型。

选择「ChatGPT 套餐」，点击「Continue with ChatGPT」，在系统浏览器登录并授权 DocumentCraft 使用套餐额度。应用用 Windows DPAPI 加密保存会话。登录后分别选择模型和推理强度。可选强度随模型变化，选择「模型默认」时由服务端决定。点击「保存设置」可在下次启动时恢复选择。此连接通过公开 Responses API 分析正文，由本地程序绘制 PNG。[官方桌面登录流程](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

在「设置 → 科研流程图」使用当前 Markdown，或选择 Markdown、DOCX、DOC 报告。确认发送后，规划模型读取正文、标题层级、实图位置和引用线索。单图生成并行执行，每张图只发送自己的取证段落。

先预览候选图，再选择要回插的图。可以逐张编辑图内文字、调整版式或重新生成。程序逐字核对图内文字和连线依据，按 Word 节版心排版并导出 300 dpi 以上的 PNG。Markdown 使用 A4 常用版心。回插后在源报告旁生成配图版、PNG 资源和 `审核清单.md`。旧版 DOC 需要本机 WPS 转换，配图版输出 DOCX。

「分阶段模型与视觉复核」可分别填图位规划、单图生成和视觉复核的模型 ID。留空使用当前连接的默认模型。视觉复核默认关闭，开启后会将候选图和该图的取证段落发给支持图片输入的模型，最多两轮。

在候选图的「调整版式」中可选分层总体架构、四栏接入与治理、纵向组织与双支路、纵向主干与场景侧栏、输入—分析—输出路线、横向阶段流程、三栏路线与底部闭环，也可由原文决定。开发时可在 Vite 的 `/figure-lab.html` 按参考图顺序查看七个样张。三阶段提示词和版式示例随 sidecar 内置于 `core/src/documentcraft/figure_skill.md`，图的外观令牌定义在 `editor/src/styles/tokens.ts`。不带 `--stage` 的 `docflow illustrate` 提供独立的命令行配图入口。

审核清单区分「有引用但缺图」「原文适合新增」「已有实图」「待确认」，并分开记录插入位置和取证范围。图名和「如下图所示」是引用线索，只有原稿中的实图位置才能用于覆盖判断。节选按实际标题层级盘点全文总览、场景路线和细节机制，可以在章节概述后插图，同时从后续段落或表格取证。

看「未单独出图的主题」可分辨并入其他图、原文依据不足、无需单列和待确认；某节既没有图也没有说明时会明确标出。候选校验未通过和绘制失败分别记录。与旧稿对照时，按图名、主题和正文位置逐图配对，再查看遗漏原因。旧稿的图数用于对照，不限制生成数量。

Markdown 文件使用 UTF-8 编码。图片使用本地路径，相对路径以 Markdown 文件所在目录为基准。输出目录需已存在。已有输出默认受保护，传入 `--overwrite` 可显式替换。转换过程读取原始文件，并在生成成功后才发布结果。

### 模板模式

| `--template-mode` | 使用方式 |
| --- | --- |
| `auto`（默认） | 检出正文锚点时走完整模板模式，其余情况走样式模式。 |
| `style` | 从参考 DOCX 继承样式和页面设置。模板正文属于示例内容，会由转换结果替代。 |
| `full` | 在完整模板的锚点处插入正文，保留锚点前后的模板内容。缺少锚点时报错。 |

完整模板的锚点任选一种。在正文的独立段落中输入 `{{DOCFLOW_CONTENT}}`，或在独立空段落中插入书签 `DOCFLOW_CONTENT`。请将锚点放在表格、文本框及内容控件之外，并与分节符分开。转换会替换整个锚点段落。模板有目录等域时，输出会请求编辑器打开后更新，实际刷新取决于 Word/WPS。

处理正式模板时可显式指定 `--template-mode full`，使锚点缺失直接报错。模板样式以 Pandoc 支持的 Word 样式名称为准，例如 `Heading 1`。正文与脚注支持本地图像和超链接。复杂 Word 对象的版式以实际模板验收为准。

样式模板含 Word 目录内容控件时，输出生成可更新的目录域。中文 Markdown 可在 YAML 中声明 `lang: zh-CN`。各节的普通正文段落统一使用模板的「正文」样式。当模板采用「题目」「图名」「表名」「图片」或「表格文字」等中文角色样式时，转换器会应用对应样式。

图名写在图片后，格式如 `图 1 技术路线`。表名可写成紧邻表格的独立段落，如 `表 1 试验结果` 或 `专利名字`，也支持 Pandoc 的 `: 表名` 语法。无编号表名按单行纯文本短标题识别，最多 50 个字符。输出保留原题注文字和编号。图片链接内方括号的文字用于替代文本，缺少独立图名时只插入图片。

### 按蓝图重建技术图

从去图稿中整理待重建的图名和引用，再为每张图记录唯一的插入锚点和来自正文或表格的取证片段。选用 `architecture`（分层架构）、`route`（三栏路线）或 `timeline`（时间窗研判），将各分区、标签和结果写入该图的 `content`。图的取证范围可跨小节，`anchor` 只负责确定插图位置。

输入为 `version: 1` 的 JSON，`figures` 中每项包含 `kind`、`title`、`anchor`、`evidence` 和 `content`。`anchor` 填源文档内唯一的段落开头，`evidence` 填原文短句列表。时间窗区间使用 0 到 1 的相对坐标，`window_member` 区分参与时间匹配的信号与背景证据。坐标用于绘制示意图，实际窗口、阈值和数值以原文为准。

```powershell
.\.venv\Scripts\python.exe .\core\tools\rebuild_figures.py 去图稿.docx 蓝图.json 配图副本.docx
```

输出路径须为新文件。脚本校验锚点、原文片段和版式容量，按插图所在节的版心回插。对照原文审核归纳关系与专业边界，并在 Word 或 WPS 中检查最终页面。

图表使用 [`core/tools/figure_style.py`](core/tools/figure_style.py) 的设计令牌。蓝色用于输入与数据支撑，灰绿用于分析处理，暖杏用于业务输出或全图核心区，灰紫用于评估、纠偏等辅助层。每组色板按大容器、分区、节点逐级加深，时间条用同色的信号色。底色使用在白底上合成的固定 RGB，文字保持深色。实体框使用同色细实线，逻辑分区和反馈回路使用虚线，跨栏主箭头比节点连线更粗。字号、文本边距、行距和圆角以印刷点定义。图标只在有助于识别业务对象时选用，使用统一大小和单色线条，并在栏内对齐。

### 预检查

```powershell
.\out\sidecar\DocumentCraft-cli.exe md-to-word --input "报告.md" --template "科研报告模板.docx" --template-mode full --output "报告.docx" --check --json
```

`--check` 检查输入、输出路径、模板锚点和本地图像，跳过文档生成。`--json` 返回状态、模板模式与输出路径，处理失败时返回错误消息和非零退出码。Markdown 解析采用 Pandoc Markdown 方言，原始 HTML、原始 TeX 与原始格式属性已关闭。

## 从源码构建和测试

构建需要 Windows x64、Python 3.10+ 与 Pandoc Windows 安装版，建议使用 Pandoc 3.x 以应用完整图名规则。旧版 Pandoc 保留其原有的独立图片处理方式。构建脚本从 Pandoc 安装目录读取 `pandoc.exe` 和随附的许可证文件。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.\core[build-exe]'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-sidecar.ps1
.\.venv\Scripts\python.exe -m unittest discover -s core\tests -v
```

设置 `DOCUMENTCRAFT_TEST_EXE` 为复制到隔离目录的命令行版 EXE 路径，再运行同一个测试命令。测试会为每次 EXE 调用清空 PATH。源码版可通过 `docflow md-to-word` 调用，参数与命令行 EXE 版相同。
