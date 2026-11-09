# DocumentCraft

面向科研文档的本地转换工具。Windows x64 单文件程序可将 Markdown 按 DOCX 模板转换为可编辑的 Word 文档，也提供命令行和 Python API。整体范围和本轮优先级见 [Feature Ledger](FEATURE_LEDGER.md)。

## Windows 单文件版

双击 `dist/DocumentCraft.exe`，选择 Markdown 文件、Word 模板和保存位置，再点「开始转换」。完成后可从窗口直接打开 Word 文档。Python 运行时和 Pandoc 随 EXE 内置。

命令行可使用 `docflow`，也可用 `build-exe.ps1 -Console` 打包 `dist-cli/DocumentCraft-cli.exe` 后在 PowerShell 中传参运行。

```powershell
.\dist-cli\DocumentCraft-cli.exe md-to-word --input "报告.md" --template "科研报告模板.docx" --output "报告.docx"
```

## Markdown 阅读器

在桌面工作台的「Markdown 阅读器」中打开文件。阅读窗口可切换工作区、浏览目录和文件，通过大纲跳到标题。正文支持常见 Markdown 排版及工作区内的本地位图。Windows 需要 Microsoft Edge WebView2 Runtime。

选中文字后写批注。批注保存在工作区的 `.documentcraft/reader-spike.sqlite3`，可以继续打开原有 Spike 数据。Markdown 源文件保持只读。选择「导出 DOCX」可用样式模板或完整模板生成 WPS 可编辑的 Word 批注。遇到待定位或当前不支持导出的批注，界面会先提示，用户可明确跳过。分享按钮将当前 Markdown 和这篇文档的批注打成一个 ZIP，收件人解压后用阅读器打开其中的 Markdown。外部附件另行传递。

「AI 整理」复用工作台选定的 AI 服务。先本地检索当前工作区的 Markdown，查看摘录后再生成整理稿。只有确认的摘录及问题会发给所选服务。来源可跳回工作区内对应文件。若更换连接设置，重新打开阅读器以应用当前设置。

## 科研配图

在「AI 设置」选连接方式。「兼容 API」使用兼容 `/chat/completions` 且支持 JSON 输出的服务，可配置地址和模型。Key 可在窗口中输入，或从 `OPENAI_API_KEY` 读取，窗口中输入的 Key 仅用于当前会话。

选择「ChatGPT 套餐」，点击「Continue with ChatGPT」，在系统浏览器登录并授权 DocumentCraft 使用套餐额度。应用用 Windows DPAPI 加密保存会话。登录后，在「分析参数」分别选择模型和推理强度。可选强度随模型变化，选择「模型默认」时由服务端决定。点击「保存设置」可在下次启动时恢复选择。此连接通过公开 Responses API 分析正文，由本地程序绘制 PNG。[官方桌面登录流程](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

在「科研配图」选择报告和黑白或分区配色风格，然后开始分析。程序在确认后向所选服务提交报告文本、标题层级、实图位置和引用线索。结果包括配图版报告、PNG 资源和 `审核清单.md`。旧版 DOC 需要本机 WPS，配图版输出 DOCX。

审核清单区分「有引用但缺图」「原文适合新增」「已有实图」「待确认」，并记录每张生成图的插入位置和取证范围。图名和「如下图所示」用于定位引用，覆盖判断须与原稿实图对应。可以在章节概述后插图，同时从后续段落或表格取证。节选按实际标题层级分析总览和场景路线。反馈回路走独立通道，无法核实的引用或技术关系列入待确认。

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

构建需要 Windows x64、Python 3.10+ 与 Pandoc Windows 安装版。构建脚本从 Pandoc 安装目录读取 `pandoc.exe` 和随附的许可证文件。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[build-exe]'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-exe.ps1
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

设置 `DOCUMENTCRAFT_TEST_EXE` 为复制到隔离目录的命令行版 EXE 路径，再运行同一个测试命令。测试会为每次 EXE 调用清空 PATH。源码版可通过 `docflow md-to-word` 调用，参数与命令行 EXE 版相同。
