//! DocumentCraft 阅读编辑器的 Tauri 后端。
//!
//! 只提供编辑器需要的少量命令：工作区目录树、Markdown 读写、编辑器设置、调用 `docflow`
//! sidecar 和用系统程序打开导出结果。VMark 原有的终端、MCP、多窗口等后端模块不移植；
//! 自动更新改用官方 `tauri-plugin-updater` 直接检查本项目的 GitHub Release（DC-063），不沿用 VMark 的实现。

mod clipboard;
mod docflow;
mod extract;
mod fileops;
mod images;
mod image_rename;
mod preview;
mod settings;
mod textindex;
mod workspace;

use tauri_plugin_opener::OpenerExt;

/// 不交给系统默认程序打开的扩展名：双击即会运行的程序、脚本和快捷方式。
/// 目录树里点击文件会走 `open_path`，工作区中来历不明的程序不能因一次点击就被执行。
const BLOCKED_OPEN_EXTENSIONS: [&str; 22] = [
    "exe", "com", "bat", "cmd", "msi", "msp", "scr", "pif", "cpl", "lnk", "url", "ps1", "psm1", "vbs", "vbe",
    "js", "jse", "wsf", "wsh", "hta", "jar", "reg",
];

fn is_blocked_for_open(path: &str) -> bool {
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    match extension {
        Some(value) => BLOCKED_OPEN_EXTENSIONS.contains(&value.as_str()),
        None => false,
    }
}

/// 用系统默认程序打开导出的 Word、审核清单，以及目录树中的非 Markdown 文件。程序和脚本拒绝打开。
#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if is_blocked_for_open(&path) {
        return Err("出于安全考虑，不直接运行程序、脚本或快捷方式，请在资源管理器中自行处理。".to_string());
    }
    let opener = app.opener();
    opener
        .open_path(path, None::<&str>)
        .map_err(|error| format!("无法打开文件：{error}"))
}

/// 在文件资源管理器中定位条目（DC-069）：文件夹直接打开，文件则打开所在文件夹并选中它。
/// 只是显示位置，不会运行文件，所以不受 `open_path` 的程序与脚本限制约束。
#[tauri::command]
fn reveal_entry(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(&path);
    let metadata = std::fs::metadata(&target).map_err(|error| format!("无法读取 {path}：{error}"))?;
    let opener = app.opener();
    if metadata.is_dir() {
        return opener
            .open_path(path, None::<&str>)
            .map_err(|error| format!("无法打开文件夹：{error}"));
    }
    opener
        .reveal_item_in_dir(&target)
        .map_err(|error| format!("无法在资源管理器中显示：{error}"))
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
        .manage(std::sync::Arc::new(textindex::SearchIndex::default()))
        .invoke_handler(tauri::generate_handler![
            workspace::list_tree,
            workspace::list_dir,
            workspace::read_text,
            workspace::write_text,
            workspace::create_dir,
            workspace::create_markdown,
            workspace::create_folder,
            workspace::remove_markdown,
            workspace::search_workspace,
            workspace::index_workspace,
            fileops::file_properties,
            fileops::copy_entry,
            fileops::move_entry,
            fileops::trash_entry,
            fileops::rename_entry,
            clipboard::clipboard_write_files,
            clipboard::clipboard_read_files,
            clipboard::clipboard_read_editor,
            clipboard::clipboard_clear,
            preview::preview_file,
            images::store_image,
            images::import_image,
            image_rename::image_rename_documents,
            image_rename::rename_image_with_references,
            settings::load_settings,
            settings::save_settings,
            docflow::docflow_run,
            docflow::docflow_stream,
            docflow::docflow_cancel,
            docflow::docflow_active,
            open_path,
            reveal_entry,
            builtin_template,
        ]);
    // 更新插件的端点与公钥来自 tauri.conf.json 的 plugins.updater；安装包签名校验失败时插件会拒绝安装。
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .run(tauri::generate_context!())
        .expect("DocumentCraft 启动失败");
}

#[cfg(test)]
mod tests {
    use super::is_blocked_for_open;

    #[test]
    fn executables_and_scripts_are_not_opened() {
        assert!(is_blocked_for_open("C:\\work\\setup.EXE"));
        assert!(is_blocked_for_open("C:\\work\\run.ps1"));
        assert!(is_blocked_for_open("C:\\work\\链接.lnk"));
        assert!(!is_blocked_for_open("C:\\work\\数据.xlsx"));
        assert!(!is_blocked_for_open("C:\\work\\图.png"));
        assert!(!is_blocked_for_open("C:\\work\\README"));
    }
}
