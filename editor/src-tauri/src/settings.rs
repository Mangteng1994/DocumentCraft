//! 编辑器设置的持久化。
//!
//! 设置以 JSON 保存在应用配置目录（Windows 为 `%APPDATA%\app.documentcraft.editor\settings.json`），
//! 字段含义与默认值由前端 `editor/src/settings/` 定义，这里只负责原子读写。
//! AI 连接设置仍由 docflow 保存在 `%LOCALAPPDATA%\DocumentCraft\ai-settings.json`，不在此文件中。

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

const SETTINGS_FILE: &str = "settings.json";

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let folder = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位设置目录：{error}"))?;
    Ok(folder.join(SETTINGS_FILE))
}

/// 读取设置 JSON。文件不存在时返回空对象，由前端补默认值。
#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    let path = settings_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(error) => Err(format!("无法读取设置：{error}")),
    }
}

/// 保存设置 JSON。先写临时文件再替换，避免中途退出留下半个文件。
#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, content: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&content).map_err(|_| "设置不是有效的 JSON。".to_string())?;
    let path = settings_path(&app)?;
    let folder = path
        .parent()
        .ok_or_else(|| "设置路径缺少目录。".to_string())?;
    fs::create_dir_all(folder).map_err(|error| format!("无法创建设置目录：{error}"))?;
    let staged = folder.join(format!("{SETTINGS_FILE}.tmp"));
    let write_result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&staged)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&staged);
        return Err(format!("无法保存设置：{error}"));
    }
    fs::rename(&staged, &path).map_err(|error| format!("无法保存设置：{error}"))
}
