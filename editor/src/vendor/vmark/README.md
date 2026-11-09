# VMark 移植代码

本目录的代码取自 [xiaolai/vmark](https://github.com/xiaolai/vmark) 提交 `aa742805dd5d8840fca8abae55c3b445d8a7c666`，按 ISC 许可证使用，许可证全文见 [LICENSE](LICENSE)。

只移植 Markdown ⇄ ProseMirror 管线（`utils/markdownPipeline/`）、大纲提取（`utils/markdownOutline.ts`）、换行风格检测（`utils/linebreakDetection.ts`）及其依赖闭包。改动：

- `@/` 路径别名改写为 `@vmark/`。
- `utils/debug.ts`、`utils/perfLog.ts` 改为不依赖 tauri-plugin-log 的精简实现。
- 测试文件未移植。

升级时先在 VMark 新版本重新计算依赖闭包，再逐文件比对。
