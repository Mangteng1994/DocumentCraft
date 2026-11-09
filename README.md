# DocumentCraft

面向科研文档的本地 Markdown 阅读编辑器。在工作区中浏览和编辑 Markdown，并在编辑器里完成批注、Copilot 整理、科研配图和按 Word 模板导出。整体范围和本轮优先级见 [Feature Ledger](FEATURE_LEDGER.md)。

项目由两部分组成：

| 目录 | 内容 |
| --- | --- |
| `app/` | 阅读编辑器。Tauri 2 + React + TipTap，编辑核心移植自 [VMark](https://github.com/xiaolai/vmark)（ISC，见 `app/src/vendor/vmark/README.md`），只保留文件树和文档大纲两个侧栏视图 |
| `src/documentcraft/` | Python 核心与 `docflow` CLI：Markdown → DOCX 转换、批注存储与导出、科研配图、工作区整理和 AI 连接。编辑器以 sidecar 方式调用 |

## 阅读编辑器

「打开文件夹」选择工作区，左侧「文件」列出其中的 Markdown 目录树（隐藏目录与链接不显示），「大纲」按标题层级列出当前文档，可过滤和折叠，点击跳到标题。正文为所见即所得编辑，`Ctrl+S` 保存。Markdown 往返沿用 VMark 管线，保留原文空行、引用式链接、脚注、公式、提示块、前置元数据等结构。工作区内的本地图片按文档所在目录解析。

工具栏功能：

- **批注**：选中同一段内的文字，在右侧批注面板点「为选区添加批注」。批注按原文和前后文锚定，编辑正文后自动重新定位，无法唯一定位的标为「待定位」。批注保存在文档所在目录的 `.documentcraft/reader-spike.sqlite3`，可继续读取旧阅读器的数据。「分享包」将当前 Markdown 和这篇文档的批注打成 ZIP，外部附件另行传递。
- **导出 Word**：选择 DOCX 模板、模板模式和保存位置，可勾选「包含批注」写入 WPS / Word 可编辑的批注。导出前自动保存。批注无法定位或位于暂不支持的段落（含公式、图片、换行等）时会先提示，可明确跳过。
- **科研配图**：对当前文档发起 AI 配图分析，见下文「科研配图」。完成后可在编辑器中打开配图版和审核清单。
- **Copilot**：向工作区提问。先在本地检索 Markdown 摘录，勾选确认后，只有选中的摘录和问题发给所选 AI 服务。整理稿可复制或插入光标处，来源可跳回对应文件。
- **AI 设置**：选择「兼容 API」或「ChatGPT 套餐」。API Key 只保存在本次会话内存，也可由 `OPENAI_API_KEY` 提供。

### 运行编辑器

需要 Node.js 22+、Rust stable、[Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/)（Windows 需 WebView2 Runtime），以及下文「从源码构建和测试」中的 `.venv`。

```powershell
cd app
npm install
npx tauri dev
```

编辑器按以下顺序寻找 `docflow`：环境变量 `DOCUMENTCRAFT_DOCFLOW` 指定的可执行文件；编辑器同目录的 `DocumentCraft-cli.exe`；仓库根目录 `.venv` 中的 Python（以 `-m documentcraft` 运行 `src/`）。安装包打包（DC-038）尚未排期。

### sidecar 接口

编辑器调用的子命令都向标准输出写一行 JSON，失败时为 `{"status": "error", "message": ...}` 并返回非零退出码。批注正文、检索摘录和设置经标准输入传 JSON。

| 命令 | 用途 |
| --- | --- |
| `docflow notes list\|add\|update\|delete --source 文档.md [--id 编号]` | 读写批注 |
| `docflow md-to-word ... --with-notes [--skip-unresolved] --json` | 导出 Word 并写入批注 |
| `docflow share --source 文档.md --output 分享包.zip` | 打包 Markdown 与批注 |
| `docflow illustrate --source 报告 --style mono\|colored` | 科研配图 |
| `docflow assistant search\|organize --workspace 目录 --question 问题` | Copilot 检索与整理 |
| `docflow ai status\|save\|login\|logout\|models` | AI 设置与 ChatGPT 登录 |

## 命令行转换

`docflow md-to-word` 按 DOCX 模板将 Markdown 转换为可编辑的 Word 文档。`scripts/build-exe.ps1` 可打包 `dist-cli/DocumentCraft-cli.exe`，Python 运行时和 Pandoc 随 EXE 内置。

```powershell
.\dist-cli\DocumentCraft-cli.exe md-to-word --input "报告.md" --template "科研报告模板.docx" --output "报告.docx"
```

## 科研配图

在「AI 设置」选连接方式。「兼容 API」使用兼容 `/chat/completions` 且支持 JSON 输出的服务，可配置地址和模型。

选择「ChatGPT 套餐」，点击「Continue with ChatGPT」，在系统浏览器登录并授权 DocumentCraft 使用套餐额度。应用用 Windows DPAPI 加密保存会话。登录后分别选择模型和推理强度。可选强度随模型变化，选择「模型默认」时由服务端决定。点击「保存设置」可在下次启动时恢复选择。此连接通过公开 Responses API 分析正文，由本地程序绘制 PNG。[官方桌面登录流程](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

打开报告后点「科研配图」，选择黑白或分区配色风格，然后开始分析。程序在确认后向所选服务提交报告文本、标题层级、实图位置和引用线索。结果包括配图版报告、PNG 资源和 `审核清单.md`。命令行的 `docflow illustrate` 也接受 DOCX，旧版 DOC 需要本机 WPS，配图版输出 DOCX。

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
.\.venv\Scripts\python.exe .\scripts\rebuild_figures.py 去图稿.docx 蓝图.json 配图副本.docx
```

输出路径须为新文件。脚本校验锚点、原文片段和版式容量，按插图所在节的版心回插。对照原文审核归纳关系与专业边界，并在 Word 或 WPS 中检查最终页面。

图表使用 [`scripts/figure_style.py`](scripts/figure_style.py) 的设计令牌。蓝色用于输入与数据支撑，灰绿用于分析处理，暖杏用于业务输出或全图核心区，灰紫用于评估、纠偏等辅助层。每组色板按大容器、分区、节点逐级加深，时间条用同色的信号色。底色使用在白底上合成的固定 RGB，文字保持深色。实体框使用同色细实线，逻辑分区和反馈回路使用虚线，跨栏主箭头比节点连线更粗。字号、文本边距、行距和圆角以印刷点定义。图标只在有助于识别业务对象时选用，使用统一大小和单色线条，并在栏内对齐。

### 预检查

```powershell
.\dist-cli\DocumentCraft-cli.exe md-to-word --input "报告.md" --template "科研报告模板.docx" --template-mode full --output "报告.docx" --check --json
```

`--check` 检查输入、输出路径、模板锚点和本地图像，跳过文档生成。`--json` 返回状态、模板模式与输出路径，处理失败时返回错误消息和非零退出码。Markdown 解析采用 Pandoc Markdown 方言，原始 HTML、原始 TeX 与原始格式属性已关闭。

## 从源码构建和测试

构建需要 Windows x64、Python 3.10+ 与 Pandoc Windows 安装版，建议使用 Pandoc 3.x 以应用完整图名规则。旧版 Pandoc 保留其原有的独立图片处理方式。构建脚本从 Pandoc 安装目录读取 `pandoc.exe` 和随附的许可证文件。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[build-exe]'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-exe.ps1
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

设置 `DOCUMENTCRAFT_TEST_EXE` 为复制到隔离目录的命令行版 EXE 路径，再运行同一个测试命令。测试会为每次 EXE 调用清空 PATH。源码版可通过 `docflow md-to-word` 调用，参数与命令行 EXE 版相同。
