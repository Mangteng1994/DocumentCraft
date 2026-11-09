import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { App } from "./App";

// 设置读取完成前先按系统配色渲染，避免深色模式下启动时闪现浅色界面。
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.dataset.theme = prefersDark ? "dark" : "light";

const container = document.getElementById("root");
if (!container) {
  throw new Error("缺少 #root 容器");
}
const root = createRoot(container);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
