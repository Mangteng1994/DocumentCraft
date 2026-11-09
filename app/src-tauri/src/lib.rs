//! DocumentCraft 阅读编辑器的 Tauri 后端。
//!
//! 只提供编辑器需要的少量命令：工作区目录树、Markdown 读写、调用 `docflow` sidecar
//! 和用系统程序打开导出结果。VMark 原有的终端、MCP、多窗口、自动更新等后端模块不移植。

mod docflow;
mod workspace;

use tauri_plugin_opener::OpenerExt;

/// 用系统默认程序打开导出的 Word、审核清单等文件。
#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let opener = app.opener();
    opener
        .open_path(path, None::<&str>)
        .map_err(|error| format!("无法打开文件：{error}"))
}

/// 启动应用并注册命令。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(docflow::Jobs::default())
        .invoke_handler(tauri::generate_handler![
            workspace::list_tree,
            workspace::read_text,
            workspace::write_text,
            docflow::docflow_run,
            docflow::docflow_cancel,
            open_path,
        ]);
    builder
        .run(tauri::generate_context!())
        .expect("DocumentCraft 启动失败");
}
