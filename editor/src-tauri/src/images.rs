//! 图片插入：把粘贴的图片数据或选中的本地图片保存到文档旁的 `assets/` 文件夹。
//!
//! 返回相对于文档目录的路径（如 `assets/image-1731200000000.png`），前端以此写入 Markdown，
//! 文档连同 `assets/` 一起移动或分享时图片不会丢失。已在当前 `assets/` 内的图片直接复用，
//! 其他来源的图片复制后插入，已有文件一律不覆盖，重名时加序号。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const ASSETS_FOLDER: &str = "assets";
const IMAGE_EXTENSIONS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tif"];
/// 单张图片上限，防止误把大文件写进文档目录。
const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;
/// 同名文件存在时尝试的序号上限。
const MAX_NAME_ATTEMPTS: usize = 1000;

pub(crate) fn normalized_extension(extension: &str) -> Result<String, String> {
    let lower = extension.trim_start_matches('.').to_ascii_lowercase();
    if IMAGE_EXTENSIONS.contains(&lower.as_str()) {
        return Ok(lower);
    }
    Err(format!("不支持的图片格式：{extension}"))
}

/// 文件名只保留字母、数字、汉字、连字符和下划线，空格等换成连字符，保证写进 Markdown 时无需转义。
fn safe_stem(stem: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        return "image".to_string();
    }
    trimmed.chars().take(60).collect()
}

fn assets_folder(document: &str) -> Result<PathBuf, String> {
    let directory = Path::new(document)
        .parent()
        .ok_or_else(|| "文档路径缺少目录。".to_string())?;
    let folder = directory.join(ASSETS_FOLDER);
    fs::create_dir_all(&folder).map_err(|error| format!("无法创建图片文件夹：{error}"))?;
    Ok(folder)
}

/// 以 create_new 写入，名称冲突时依次尝试 `名称-1`、`名称-2`……，返回相对路径。
fn write_unique(folder: &Path, stem: &str, extension: &str, data: &[u8]) -> Result<String, String> {
    for attempt in 0..MAX_NAME_ATTEMPTS {
        let name = if attempt == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{attempt}.{extension}")
        };
        let target = folder.join(&name);
        let opened = fs::OpenOptions::new().write(true).create_new(true).open(&target);
        let mut file = match opened {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法保存图片：{error}")),
        };
        if let Err(error) = file.write_all(data) {
            drop(file);
            let _ = fs::remove_file(&target);
            return Err(format!("无法保存图片：{error}"));
        }
        return Ok(format!("{ASSETS_FOLDER}/{name}"));
    }
    Err("图片文件夹中同名文件过多，请先整理。".to_string())
}

fn timestamp_stem() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    format!("image-{millis}")
}

/// 保存粘贴的图片数据，返回相对于文档目录的路径。
#[tauri::command]
pub fn store_image(document: String, data: Vec<u8>, extension: String) -> Result<String, String> {
    let extension = normalized_extension(&extension)?;
    if data.is_empty() {
        return Err("图片内容为空。".to_string());
    }
    if data.len() as u64 > MAX_IMAGE_BYTES {
        return Err("图片超过 50 MB，未插入。".to_string());
    }
    let folder = assets_folder(&document)?;
    write_unique(&folder, &timestamp_stem(), &extension, &data)
}

/// 导入本地图片并返回相对路径；当前文档的 assets 内图片直接复用，其他来源复制保存。
#[tauri::command]
pub fn import_image(document: String, source: String) -> Result<String, String> {
    let source_path = PathBuf::from(&source);
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("不是图片文件：{source}"))?;
    let extension = normalized_extension(extension)?;
    let metadata = fs::metadata(&source_path).map_err(|_| format!("找不到图片：{source}"))?;
    if !metadata.is_file() {
        return Err(format!("不是图片文件：{source}"));
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err("图片超过 50 MB，未插入。".to_string());
    }
    let folder = assets_folder(&document)?;
    // 按真实路径和目录边界判断归属，兼容 ..、分隔符和目录别名；其他目录里的 assets 仍需导入。
    let canonical_source = fs::canonicalize(&source_path)
        .map_err(|error| format!("无法解析图片路径：{error}"))?;
    let canonical_folder = fs::canonicalize(&folder)
        .map_err(|error| format!("无法解析图片文件夹：{error}"))?;
    if let Ok(relative) = canonical_source.strip_prefix(&canonical_folder) {
        let parts: Vec<_> = relative.iter().map(|part| part.to_string_lossy()).collect();
        let relative_path = parts.join("/");
        return Ok(format!("{ASSETS_FOLDER}/{relative_path}"));
    }
    let data = fs::read(&source_path).map_err(|error| format!("无法读取图片：{error}"))?;
    let stem = source_path
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    write_unique(&folder, &safe_stem(&stem), &extension, &data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("documentcraft-img-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn stores_into_assets_without_overwriting() {
        let root = scratch("store");
        let document = root.join("报告.md").to_string_lossy().into_owned();
        let source = root.join("截图 1.PNG");
        fs::write(&source, [1u8, 2, 3]).unwrap();
        let first = import_image(document.clone(), source.to_string_lossy().into_owned()).unwrap();
        let second = import_image(document.clone(), source.to_string_lossy().into_owned()).unwrap();
        assert_eq!(first, "assets/截图-1.png");
        assert_eq!(second, "assets/截图-1-1.png");
        assert_eq!(fs::read(root.join("assets").join("截图-1.png")).unwrap(), vec![1u8, 2, 3]);
        let pasted = store_image(document.clone(), vec![9u8], "png".to_string()).unwrap();
        assert!(pasted.starts_with("assets/image-") && pasted.ends_with(".png"));
        assert!(store_image(document.clone(), vec![9u8], "exe".to_string()).is_err());
        assert!(store_image(document.clone(), Vec::new(), "png".to_string()).is_err());
        let missing = root.join("不存在.png").to_string_lossy().into_owned();
        assert!(import_image(document, missing).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
