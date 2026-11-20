//! 系统剪贴板里的文件列表（DC-069）。
//!
//! 文件树的复制、剪切要写入系统剪贴板，资源管理器、桌面和其他程序才能粘贴；
//! 在资源管理器里复制或剪切的文件，也要能粘贴到文件树里。Windows 用两种剪贴板格式配合：
//! - `CF_HDROP`：文件路径列表（DROPFILES 结构，后面跟以 NUL 分隔的 UTF-16 路径，整体以两个 NUL 结束）；
//! - `Preferred DropEffect`：一个 DWORD，1 表示复制，2 表示剪切（移动）。资源管理器靠它区分复制和剪切。
//! 其他平台没有这套格式，命令返回空列表或报错，前端会退回到应用内剪贴板。

use serde::Serialize;

/// 剪贴板上的文件列表和是否为剪切。
#[derive(Serialize, Default, Debug, PartialEq)]
pub struct ClipboardFiles {
    pub paths: Vec<String>,
    pub cut: bool,
}

/// DROPFILES 结构：偏移 0 的 u32 是路径列表起点，偏移 16 的 u32 非 0 表示路径是 UTF-16。
const DROPFILES_HEADER_SIZE: usize = 20;
const DROP_EFFECT_COPY: u32 = 1;
const DROP_EFFECT_MOVE: u32 = 2;

/// 把路径列表编码成 `CF_HDROP` 的内容：DROPFILES 头 + 每条路径以 NUL 结尾的 UTF-16 + 末尾再加一个 NUL。
pub fn encode_drop_files(paths: &[String]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(DROPFILES_HEADER_SIZE + paths.len() * 64);
    bytes.extend_from_slice(&(DROPFILES_HEADER_SIZE as u32).to_le_bytes());
    // pt（拖放点坐标）和 fNC 用不到，填 0。
    bytes.extend_from_slice(&[0u8; 12]);
    // fWide = 1：路径是 UTF-16。
    bytes.extend_from_slice(&1u32.to_le_bytes());
    for path in paths {
        for unit in path.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());
    }
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes
}

/// 解析 `CF_HDROP` 的内容，取出路径列表。格式不对（头太短、偏移越界）时返回空列表，而不是报错或越界。
pub fn decode_drop_files(bytes: &[u8]) -> Vec<String> {
    if bytes.len() < DROPFILES_HEADER_SIZE {
        return Vec::new();
    }
    let offset = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let wide = u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]) != 0;
    if offset < DROPFILES_HEADER_SIZE || offset > bytes.len() {
        return Vec::new();
    }
    let body = &bytes[offset..];
    let mut paths = Vec::new();
    if wide {
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        for part in units.split(|unit| *unit == 0) {
            // 空片段是列表末尾的结束标记；之后不会再有路径。
            if part.is_empty() {
                break;
            }
            paths.push(String::from_utf16_lossy(part));
        }
    } else {
        for part in body.split(|byte| *byte == 0) {
            if part.is_empty() {
                break;
            }
            paths.push(String::from_utf8_lossy(part).into_owned());
        }
    }
    paths
}

#[cfg(windows)]
mod platform {
    use super::{decode_drop_files, encode_drop_files, ClipboardFiles, DROP_EFFECT_COPY, DROP_EFFECT_MOVE};
    use clipboard_win::{formats, raw, Clipboard};

    /// 别的程序正占着剪贴板时重试的次数；每次间隔由库内部等待。
    const OPEN_ATTEMPTS: usize = 10;
    const DROP_EFFECT_FORMAT: &str = "Preferred DropEffect";

    fn open() -> Result<Clipboard, String> {
        Clipboard::new_attempts(OPEN_ATTEMPTS).map_err(|error| format!("无法打开剪贴板：{error}"))
    }

    pub fn write_files(paths: &[String], cut: bool) -> Result<(), String> {
        let _clipboard = open()?;
        raw::empty().map_err(|error| format!("无法清空剪贴板：{error}"))?;
        let list = encode_drop_files(paths);
        raw::set_without_clear(formats::CF_HDROP, &list).map_err(|error| format!("无法写入文件列表：{error}"))?;
        // 复制和剪切靠这个格式区分；注册失败时仍然保留文件列表，对方按默认的复制处理。
        if let Some(format) = raw::register_format(DROP_EFFECT_FORMAT) {
            let effect = if cut { DROP_EFFECT_MOVE } else { DROP_EFFECT_COPY };
            raw::set_without_clear(format.get(), &effect.to_le_bytes()).map_err(|error| format!("无法写入剪切标记：{error}"))?;
        }
        Ok(())
    }

    pub fn read_files() -> Result<ClipboardFiles, String> {
        let _clipboard = open()?;
        if !raw::is_format_avail(formats::CF_HDROP) {
            return Ok(ClipboardFiles::default());
        }
        let mut bytes = Vec::new();
        raw::get_vec(formats::CF_HDROP, &mut bytes).map_err(|error| format!("无法读取文件列表：{error}"))?;
        let paths = decode_drop_files(&bytes);
        let mut cut = false;
        if let Some(format) = raw::register_format(DROP_EFFECT_FORMAT) {
            let mut effect = Vec::new();
            if raw::is_format_avail(format.get()) && raw::get_vec(format.get(), &mut effect).is_ok() && effect.len() >= 4 {
                let value = u32::from_le_bytes([effect[0], effect[1], effect[2], effect[3]]);
                cut = value & DROP_EFFECT_MOVE != 0 && value & DROP_EFFECT_COPY == 0;
            }
        }
        Ok(ClipboardFiles { paths, cut })
    }

    pub fn clear() -> Result<(), String> {
        let _clipboard = open()?;
        raw::empty().map_err(|error| format!("无法清空剪贴板：{error}"))
    }
}

#[cfg(not(windows))]
mod platform {
    use super::ClipboardFiles;

    pub fn write_files(_paths: &[String], _cut: bool) -> Result<(), String> {
        Err("系统剪贴板的文件列表目前只支持 Windows。".to_string())
    }

    pub fn read_files() -> Result<ClipboardFiles, String> {
        Ok(ClipboardFiles::default())
    }

    pub fn clear() -> Result<(), String> {
        Ok(())
    }
}

/// 把文件或文件夹的路径写入系统剪贴板，cut 为 true 表示剪切（粘贴时移动）。
#[tauri::command]
pub async fn clipboard_write_files(paths: Vec<String>, cut: bool) -> Result<(), String> {
    if paths.is_empty() {
        return Err("没有要复制的文件。".to_string());
    }
    let task = tauri::async_runtime::spawn_blocking(move || platform::write_files(&paths, cut));
    task.await.map_err(|error| error.to_string())?
}

/// 读取系统剪贴板中的文件列表。剪贴板里没有文件时返回空列表。
#[tauri::command]
pub async fn clipboard_read_files() -> Result<ClipboardFiles, String> {
    let task = tauri::async_runtime::spawn_blocking(platform::read_files);
    task.await.map_err(|error| error.to_string())?
}

/// 清空系统剪贴板。剪切并粘贴完成后调用，避免同一批文件被重复移动。
#[tauri::command]
pub async fn clipboard_clear() -> Result<(), String> {
    let task = tauri::async_runtime::spawn_blocking(platform::clear);
    task.await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{decode_drop_files, encode_drop_files};

    #[test]
    fn paths_survive_a_round_trip() {
        let paths = vec![
            "C:\\work\\报告.md".to_string(),
            "D:\\data\\a b\\表格 1.xlsx".to_string(),
        ];
        let bytes = encode_drop_files(&paths);
        assert_eq!(decode_drop_files(&bytes), paths);
    }

    #[test]
    fn header_points_at_the_path_list() {
        let bytes = encode_drop_files(&["C:\\a".to_string()]);
        assert_eq!(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]), 20);
        assert_eq!(u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]), 1);
        // 头 20 字节 + "C:\a" 四个字符、一个结尾 NUL、一个列表结束 NUL，共 6 个 UTF-16 单元。
        assert_eq!(bytes.len(), 20 + 6 * 2);
    }

    #[test]
    fn malformed_lists_are_ignored() {
        assert!(decode_drop_files(&[]).is_empty());
        assert!(decode_drop_files(&[0u8; 10]).is_empty());
        // 偏移指向数据之外。
        let mut bytes = encode_drop_files(&["C:\\a".to_string()]);
        bytes[0] = 0xff;
        assert!(decode_drop_files(&bytes).is_empty());
    }

    #[test]
    fn ansi_lists_are_decoded() {
        // fWide = 0：路径是单字节字符。
        let mut bytes = vec![0u8; 20];
        bytes[0] = 20;
        bytes.extend_from_slice(b"C:\\a.txt\0C:\\b.txt\0\0");
        assert_eq!(decode_drop_files(&bytes), vec!["C:\\a.txt".to_string(), "C:\\b.txt".to_string()]);
    }
}
