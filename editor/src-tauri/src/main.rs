// 发布版使用 Windows GUI 子系统，双击启动时不弹出控制台。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    documentcraft_editor_lib::run()
}
