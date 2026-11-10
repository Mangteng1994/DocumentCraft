//! DocumentCraft 阅读编辑器的 Tauri 后端。
//!
//! 只提供编辑器需要的少量命令：工作区目录树、Markdown 读写、编辑器设置、调用 `docflow`
//! sidecar 和用系统程序打开导出结果。VMark 原有的终端、MCP、多窗口、自动更新等后端模块不移植。

mod docflow;
mod settings;
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

/// 内置 Word 模板的文件名。安装版放在 exe 同目录，由 tauri.bundle.conf.json 作为资源安装。
const BUILTIN_TEMPLATE_NAME: &str = "builtin-template.docx";

/// 返回内置 Word 模板的路径：先找 exe 同目录（安装版），再找仓库内的 editor/resources（开发模式）。
#[tauri::command]
fn builtin_template() -> Result<String, String> {
    if let Ok(executable) = std::env::current_exe() {
        if let Some(folder) = executable.parent() {
            let installed = folder.join(BUILTIN_TEMPLATE_NAME);
            if installed.is_file() {
                return Ok(installed.to_string_lossy().into_owned());
            }
        }
    }
    let source = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("resources")
        .join(BUILTIN_TEMPLATE_NAME);
    if source.is_file() {
        return Ok(source.to_string_lossy().into_owned());
    }
    Err("找不到内置 Word 模板，请在设置中选择模板。".to_string())
}

/// 启动应用并注册命令。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(docflow::Jobs::default())
        .invoke_handler(tauri::generate_handler![
            workspace::list_tree,
            workspace::read_text,
            workspace::write_text,
            workspace::create_dir,
            workspace::create_markdown,
            workspace::create_folder,
            workspace::remove_markdown,
            settings::load_settings,
            settings::save_settings,
            docflow::docflow_run,
            docflow::docflow_stream,
            docflow::docflow_cancel,
            open_path,
            builtin_template,
        ]);
    builder
        .run(tauri::generate_context!())
        .expect("DocumentCraft 启动失败");
}
