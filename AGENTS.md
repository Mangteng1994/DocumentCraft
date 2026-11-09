# DocumentCraft 工作约定

DocumentCraft 是面向 Windows 与 WPS 的本地科研文档阅读编辑器。编辑器（Tauri 2 + React + TipTap，编辑核心移植自 VMark）以 sidecar 方式调用 Python 核心的 `docflow` CLI。依赖安装与运行命令见 [README.md](README.md)。

## 目录约定

| 目录 | 内容 | 入库 |
| --- | --- | --- |
| `editor/` | 阅读编辑器。`src/` 前端，`src-tauri/` Rust 后端，`src/vendor/vmark/` 为 VMark 移植代码（改动记录在其 README） | 是 |
| `editor/src/editor/` | 编辑区：schema、批注、快捷命令、右键菜单 | 是 |
| `editor/src/features/` | 编辑器功能：`copilot/`、`comments/`、`settings/`（含 MD 转 Word、科研流程图、AI 连接） | 是 |
| `editor/src/settings/` | 设置结构、持久化、主题、快捷键分发 | 是 |
| `editor/src/styles/` | 设计令牌（唯一的设计值定义层）与样式 | 是 |
| `core/` | Python 核心：`pyproject.toml`、`src/documentcraft/`、`tests/`、`tools/`（独立脚本，如按蓝图重建技术图）、`spikes/`（历史验证脚本） | 是 |
| `scripts/` | 仓库级构建脚本（`build-sidecar.ps1` 等），保持纯 ASCII | 是 |
| `out/` | 一切可再生成的构建产物：`sidecar/`、`pyinstaller/`、旧版产物 `legacy/`。可随时删除 | 否 |
| `local/` | 本机私有资料：验收文档、模板、样例。脚本不得写入或删除 | 否 |
| `.venv/` | 仓库根目录的 Python 虚拟环境，以 `pip install -e core` 安装核心 | 否 |

1. 新代码按上表放入对应目录，不在仓库根目录新增源码或产物。
2. 构建脚本只向 `out/` 输出；Tauri 的 `editor/src-tauri/target/` 与前端 `editor/dist/` 例外，由各自工具管理。
3. 根目录只保留 `README.md`、`AGENTS.md`、`FEATURE_LEDGER.md` 与 `.gitignore`。

## Feature Ledger 与 MoSCoW

1. 开工前读取 [FEATURE_LEDGER.md](FEATURE_LEDGER.md)。新增或调整功能时，先用稳定的功能 ID 记录范围、MoSCoW 优先级、可观察的验收条件和当前状态。已有功能沿用原 ID。
2. 按当前交付范围排序。**Must** 是交付必需项，优先实现。**Should** 在 Must 范围落实后推进。**Could** 由本轮余量决定。**Won’t** 留在台账，等待后续范围调整。
3. 交付前按功能 ID 回写状态、实现位置与验收结果。区分「已实现」和「已验收」。仅在用户主动要求时执行测试。未执行时记录「未测试」。

## 界面 100% tokenized

1. 所有界面设计值统一定义为设计令牌（design tokens），定义层为 `editor/src/styles/tokens.css` 和 `editor/src/styles/tokens.ts`。覆盖颜色、字体、字号、字重、行高、间距、尺寸、边框、圆角、阴影、层级、动效和响应式断点。
2. 页面、组件、内联样式、图标主题属性与响应式配置引用语义 token。第三方组件库的主题变量映射到同一套 token。新增设计值先添加或复用 token，再在界面中引用。
3. 每次修改界面时检查本次变更中的设计值引用。设计值字面量集中在 token 定义层。转换引擎、CLI、业务数据和协议常量按各自的领域约定维护。

## 语言

项目文档和面向维护者的说明优先用中文。文件名、代码标识符、CLI、配置字段、协议标识及第三方正式名称保留原有写法。

## 代码规范

1. 每行表达一个操作。条件判断、异常处理和循环使用分行代码块。调用参数或表达式包含多个步骤时，拆成具名中间变量或分行参数。
2. 为公开入口和核心处理函数写中文文档字符串。对外部工具调用、文件保护、格式兼容与其他容易误改的逻辑加中文注释，说明约束和原因。
3. 命名体现数据含义，类型标注覆盖公开接口。提交前阅读变更，确认每个步骤都能独立定位和理解。
