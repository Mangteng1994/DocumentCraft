//! 系统剪贴板里的文件列表与编辑器粘贴数据（DC-069、DC-053）。
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

/// 从同一次剪贴板读取取得的编辑器内容。图片字节只在没有 HTML 和正文时返回。
#[derive(Serialize, Default)]
pub struct EditorClipboard {
    text: String,
    html: String,
    image: Option<ClipboardImage>,
}

#[derive(Serialize)]
struct ClipboardImage {
    mime: &'static str,
    bytes: Vec<u8>,
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
    use super::{ClipboardImage, EditorClipboard};
    use clipboard_win::{formats, options, raw, Clipboard, Getter, Setter};

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

    /// 在一次打开期间读取对应的原生 HTML 和文本，保留 WebView 可能滤掉的 Office 标签。
    pub fn read_editor(include_image: bool) -> Result<EditorClipboard, String> {
        let _clipboard = open()?;
        let mut contents = EditorClipboard::default();
        if raw::is_format_avail(formats::CF_UNICODETEXT) {
            formats::Unicode.read_clipboard(&mut contents.text)
                .map_err(|error| format!("无法读取剪贴板文字：{error}"))?;
        }
        if let Some(format) = formats::Html::new() {
            if raw::is_format_avail(format.code()) {
                let mut bytes = Vec::new();
                if format.read_clipboard(&mut bytes).is_ok() {
                    contents.html = String::from_utf8_lossy(&bytes).into_owned();
                }
            }
        }
        // 混合选区可能同时提供整段内容的位图预览，只有单独的图片才使用位图格式。
        if include_image && contents.text.trim().is_empty() && contents.html.trim().is_empty() {
            contents.image = read_image()?;
        }
        Ok(contents)
    }

    /// 在同一次打开期间写入 Windows 富文本和纯文本格式，供编辑区和其他应用粘贴。
    pub fn write_editor(window: &tauri::Window, html: &str, text: &str) -> Result<(), String> {
        let format = formats::Html::new()
            .ok_or_else(|| "无法注册富文本剪贴板格式。".to_string())?;
        // 清空再写入时使用编辑器窗口作为所有者，让两个格式归属同一个窗口。
        let owner = window.hwnd().map_err(|error| format!("无法定位剪贴板所有者：{error}"))?;
        let _clipboard = Clipboard::new_attempts_for(owner.0, OPEN_ATTEMPTS)
            .map_err(|error| format!("无法打开剪贴板：{error}"))?;
        raw::empty().map_err(|error| format!("无法清空剪贴板：{error}"))?;
        format.write_clipboard(&html)
            .map_err(|error| format!("无法写入剪贴板富文本：{error}"))?;
        // 两种格式需要同时保留，写入纯文本时避免再次清空剪贴板。
        if !text.is_empty() {
            raw::set_string_with(text, options::NoClear)
                .map_err(|error| format!("无法写入剪贴板文字：{error}"))?;
        }
        Ok(())
    }

    fn read_image() -> Result<Option<ClipboardImage>, String> {
        let mut bytes = Vec::new();
        if let Some(png) = raw::register_format("PNG") {
            if raw::is_format_avail(png.get()) {
                raw::get_vec(png.get(), &mut bytes)
                    .map_err(|error| format!("无法读取剪贴板 PNG：{error}"))?;
                return Ok(Some(ClipboardImage { mime: "image/png", bytes }));
            }
        }
        if raw::is_format_avail(formats::CF_BITMAP) {
            formats::Bitmap.read_clipboard(&mut bytes)
                .map_err(|error| format!("无法读取剪贴板位图：{error}"))?;
            return Ok(Some(ClipboardImage { mime: "image/bmp", bytes }));
        }
        Ok(None)
    }

    pub fn clear() -> Result<(), String> {
        let _clipboard = open()?;
        raw::empty().map_err(|error| format!("无法清空剪贴板：{error}"))
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{ClipboardFiles, EditorClipboard};

    pub fn write_files(_paths: &[String], _cut: bool) -> Result<(), String> {
        Err("系统剪贴板的文件列表目前只支持 Windows。".to_string())
    }

    pub fn read_files() -> Result<ClipboardFiles, String> {
        Ok(ClipboardFiles::default())
    }

    pub fn read_editor(_include_image: bool) -> Result<EditorClipboard, String> {
        Ok(EditorClipboard::default())
    }

    pub fn write_editor(_window: &tauri::Window, _html: &str, _text: &str) -> Result<(), String> {
        Err("编辑器富文本剪贴板目前只支持 Windows。".to_string())
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

/// 读取 Windows 剪贴板中的编辑内容，供显式粘贴操作调用。
#[tauri::command]
pub async fn clipboard_read_editor(include_image: bool) -> Result<EditorClipboard, String> {
    let task = tauri::async_runtime::spawn_blocking(move || platform::read_editor(include_image));
    task.await.map_err(|error| error.to_string())?
}

/// 把编辑器选区的 HTML 和纯文本写入 Windows 剪贴板。
#[tauri::command]
pub async fn clipboard_write_editor(
    window: tauri::Window,
    html: String,
    text: String,
) -> Result<(), String> {
    let task = tauri::async_runtime::spawn_blocking(move || platform::write_editor(&window, &html, &text));
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
