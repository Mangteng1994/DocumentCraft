# DocumentCraft

面向科研文档的本地转换工具。Windows x64 单文件程序可将 Markdown 按 DOCX 模板转换为可编辑的 Word 文档，也提供命令行和 Python API。整体范围和本轮优先级见 [Feature Ledger](FEATURE_LEDGER.md)。

## Windows 单文件版

双击 `dist/DocumentCraft.exe`，选择 Markdown 文件、Word 模板和保存位置，再点「开始转换」。完成后可从窗口直接打开 Word 文档。Python 运行时和 Pandoc 随 EXE 内置。

命令行可使用 `docflow`，也可用 `build-exe.ps1 -Console` 打包 `dist-cli/DocumentCraft-cli.exe` 后在 PowerShell 中传参运行。

```powershell
.\dist-cli\DocumentCraft-cli.exe md-to-word --input "报告.md" --template "科研报告模板.docx" --output "报告.docx"
```

## 科研配图

在「AI 设置」选连接方式。「兼容 API」使用兼容 `/chat/completions` 且支持 JSON 输出的服务，可配置地址和模型。Key 可在窗口中输入，或从 `OPENAI_API_KEY` 读取，窗口中输入的 Key 仅用于当前会话。

选择「ChatGPT 套餐」，点击「Continue with ChatGPT」，在系统浏览器登录并授权 DocumentCraft 使用套餐额度。应用用 Windows DPAPI 加密保存会话。登录后，在「分析参数」分别选择模型和推理强度。可选强度随模型变化，选择「模型默认」时由服务端决定。点击「保存设置」可在下次启动时恢复选择。此连接通过公开 Responses API 分析正文，由本地程序绘制 PNG。[官方桌面登录流程](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

在「科研配图」选择报告和黑白或分区配色风格，然后开始分析。程序在确认后向所选服务提交报告文本和图片位置标记。结果包括源目录中的配图版报告、PNG 资源目录和其中的 `审核清单.md`。旧版 DOC 需要本机 WPS，配图版输出 DOCX。已有图片以位置、图题和报告上下文判断覆盖范围。无法确定的关系、覆盖范围和当前布局无法呈现的回路列入审核清单。

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
