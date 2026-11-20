import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发服务器固定端口，与 src-tauri/tauri.conf.json 的 devUrl 一致。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@vmark": fileURLToPath(new URL("./src/vendor/vmark", import.meta.url)),
    },
  },
  server: {
    port: 1430,
    strictPort: true,
    watch: {
      // Rust 构建产物（target/debug 下的 exe、pdb）在应用运行时被系统占用，
      // 监视它们会在 Windows 上持续报 EBUSY；前端热更新也不依赖这些文件。
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
  },
});
