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
  },
  build: {
    target: "es2022",
  },
});
