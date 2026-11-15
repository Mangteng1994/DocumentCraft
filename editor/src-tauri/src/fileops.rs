//! 文件树右键菜单的后端（DC-064）：复制、移动、移入回收站和属性。
//!
//! 约定：
//! - 复制和移动到目标文件夹时，重名条目自动改名为「名称 - 副本」，绝不覆盖已有文件；
//! - 符号链接和联接点一律不处理（复制文件夹时跳过其中的链接），避免跟随链接误操作别处的数据；
//! - 删除只移入回收站，可以在回收站还原；
//! - 复制、移动、删除可能很慢（大文件夹、网络共享），命令都是异步的，在后台线程执行，不阻塞界面。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 属性窗口统计文件夹内容时最多检查的条目数和最长耗时，超出后标注为「部分统计」。
const PROPERTIES_MAX_ENTRIES: usize = 50_000;
const PROPERTIES_MAX_SECONDS: u64 = 3;
/// 复制文件夹的最大层级，防止异常深的目录结构撑爆调用栈。
const MAX_COPY_DEPTH: usize = 32;
/// 生成不重名的新名称时最多尝试的次数。
const MAX_UNIQUE_ATTEMPTS: usize = 1000;

/// 读取条目的元数据并拒绝符号链接。
fn existing_entry(path: &str) -> Result<(PathBuf, fs::Metadata), String> {
    let target = PathBuf::from(path);
    let metadata = fs::symlink_metadata(&target).map_err(|error| format!("无法读取 {path}：{error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("不处理符号链接或联接点。".to_string());
    }
    Ok((target, metadata))
}

/// 目标必须是已存在的文件夹。
fn existing_directory(path: &str) -> Result<PathBuf, String> {
    let directory = PathBuf::from(path);
    let metadata = fs::metadata(&directory).map_err(|error| format!("无法读取目标文件夹 {path}：{error}"))?;
    if !metadata.is_dir() {
        return Err("目标不是文件夹。".to_string());
    }
    Ok(directory)
}

/// 在目录下生成不与现有条目重名的路径：原名可用就用原名，否则依次尝试「名称 - 副本」「名称 - 副本 (2)」。
/// 文件把扩展名留在末尾，文件夹整个名称都视为主名。
fn unique_target(directory: &Path, name: &str, is_dir: bool) -> Result<PathBuf, String> {
    let first = directory.join(name);
    if fs::symlink_metadata(&first).is_err() {
        return Ok(first);
    }
    let source = Path::new(name);
    let mut stem = name.to_string();
    let mut extension = String::new();
    if !is_dir {
        if let Some(value) = source.file_stem() {
            stem = value.to_string_lossy().into_owned();
        }
        if let Some(value) = source.extension() {
            extension = format!(".{}", value.to_string_lossy());
        }
    }
    for attempt in 1..=MAX_UNIQUE_ATTEMPTS {
        let label = if attempt == 1 { " - 副本".to_string() } else { format!(" - 副本 ({attempt})") };
        let candidate = directory.join(format!("{stem}{label}{extension}"));
        if fs::symlink_metadata(&candidate).is_err() {
            return Ok(candidate);
        }
    }
    Err("重名条目太多，无法生成新名称。".to_string())
}

/// 文件夹不能复制或移动到它自己里面，否则会无限递归。用规范化路径比较，避免大小写和相对路径造成误判。
fn reject_into_itself(source: &Path, is_dir: bool, target_dir: &Path) -> Result<(), String> {
    if !is_dir {
        return Ok(());
    }
    let source_real = fs::canonicalize(source).map_err(|error| format!("无法解析源路径：{error}"))?;
    let target_real = fs::canonicalize(target_dir).map_err(|error| format!("无法解析目标路径：{error}"))?;
    if target_real.starts_with(&source_real) {
        return Err("不能把文件夹复制或移动到它自己里面。".to_string());
    }
    Ok(())
}

/// 递归复制文件或文件夹。遇到符号链接跳过，不跟随。
fn copy_recursive(source: &Path, target: &Path, depth: usize) -> Result<(), String> {
    if depth > MAX_COPY_DEPTH {
        return Err("文件夹层级太深，已停止复制。".to_string());
    }
    let metadata = fs::symlink_metadata(source).map_err(|error| format!("无法读取 {}：{error}", source.display()))?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        fs::create_dir(target).map_err(|error| format!("无法创建 {}：{error}", target.display()))?;
        let entries = fs::read_dir(source).map_err(|error| format!("无法读取 {}：{error}", source.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("无法读取 {}：{error}", source.display()))?;
            let child_target = target.join(entry.file_name());
            copy_recursive(&entry.path(), &child_target, depth + 1)?;
        }
        return Ok(());
    }
    fs::copy(source, target)
        .map(|_| ())
        .map_err(|error| format!("无法复制 {}：{error}", source.display()))
}

fn remove_entry(path: &Path, is_dir: bool) -> std::io::Result<()> {
    if is_dir {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn entry_name(source: &Path) -> Result<String, String> {
    source
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .ok_or_else(|| "无法确定条目名称（可能是磁盘根目录）。".to_string())
}

/// 把 source 复制到 target_dir 下，返回新条目的路径。
fn copy_entry_blocking(source: &str, target_dir: &str) -> Result<String, String> {
    let (source_path, metadata) = existing_entry(source)?;
    let directory = existing_directory(target_dir)?;
    let is_dir = metadata.is_dir();
    reject_into_itself(&source_path, is_dir, &directory)?;
    let name = entry_name(&source_path)?;
    let target = unique_target(&directory, &name, is_dir)?;
    if let Err(message) = copy_recursive(&source_path, &target, 0) {
        // 复制到一半失败时清理已经写出的部分，不留下残缺的副本。
        let _ = remove_entry(&target, is_dir);
        return Err(message);
    }
    Ok(target.to_string_lossy().into_owned())
}

/// 把 source 移动到 target_dir 下，返回新路径。同一磁盘上直接重命名；跨磁盘时先复制，成功后再删除原件。
fn move_entry_blocking(source: &str, target_dir: &str) -> Result<String, String> {
    let (source_path, metadata) = existing_entry(source)?;
    let directory = existing_directory(target_dir)?;
    let is_dir = metadata.is_dir();
    reject_into_itself(&source_path, is_dir, &directory)?;
    let source_parent = source_path
        .parent()
        .ok_or_else(|| "无法确定原文件夹。".to_string())?;
    let same_parent = match (fs::canonicalize(source_parent), fs::canonicalize(&directory)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    };
    if same_parent {
        return Err("它已经在这个文件夹中。".to_string());
    }
    let name = entry_name(&source_path)?;
    let target = unique_target(&directory, &name, is_dir)?;
    if fs::rename(&source_path, &target).is_ok() {
        return Ok(target.to_string_lossy().into_owned());
    }
    // 重命名失败多半是跨磁盘：改为复制后删除。复制失败则原件保持不动。
    if let Err(message) = copy_recursive(&source_path, &target, 0) {
        let _ = remove_entry(&target, is_dir);
        return Err(message);
    }
    if let Err(error) = remove_entry(&source_path, is_dir) {
        return Err(format!("已复制到新位置，但无法删除原条目：{error}"));
    }
    Ok(target.to_string_lossy().into_owned())
}

/// 复制文件或文件夹到目标文件夹。重名时自动改名，不覆盖。
#[tauri::command]
pub async fn copy_entry(source: String, target_dir: String) -> Result<String, String> {
    let task = tauri::async_runtime::spawn_blocking(move || copy_entry_blocking(&source, &target_dir));
    task.await.map_err(|error| error.to_string())?
}

/// 移动文件或文件夹到目标文件夹（剪切后粘贴）。重名时自动改名，不覆盖。
#[tauri::command]
pub async fn move_entry(source: String, target_dir: String) -> Result<String, String> {
    let task = tauri::async_runtime::spawn_blocking(move || move_entry_blocking(&source, &target_dir));
    task.await.map_err(|error| error.to_string())?
}

/// 把文件或文件夹移入回收站，可在回收站中还原。
#[tauri::command]
pub async fn trash_entry(path: String) -> Result<(), String> {
    let task = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let (target, _) = existing_entry(&path)?;
        // 没有上级的路径是磁盘根目录，不允许删除。
        if target.parent().is_none() {
            return Err("不能删除磁盘根目录。".to_string());
        }
        trash::delete(&target).map_err(|error| format!("无法移入回收站：{error}"))
    });
    task.await.map_err(|error| error.to_string())?
}

/// 属性窗口显示的信息。时间为 Unix 毫秒，读取不到时为 None。
#[derive(Serialize)]
pub struct FileProperties {
    name: String,
    path: String,
    folder: String,
    is_dir: bool,
    extension: String,
    /// 文件为自身大小；文件夹为统计到的内容总大小。
    size: u64,
    /// 文件夹内统计到的文件数和子文件夹数。
    files: usize,
    folders: usize,
    /// 文件夹太大，统计在预算用完时停止，数字只是下限。
    partial: bool,
    created: Option<u64>,
    modified: Option<u64>,
    accessed: Option<u64>,
    readonly: bool,
}

fn millis(time: std::io::Result<SystemTime>) -> Option<u64> {
    let time = time.ok()?;
    let duration = time.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_millis() as u64)
}

/// 统计文件夹内容：总大小、文件数、子文件夹数。条目数或耗时超出预算时提前结束并标记为部分统计。
fn measure_folder(root: &Path) -> (u64, usize, usize, bool) {
    let started = Instant::now();
    let limit = Duration::from_secs(PROPERTIES_MAX_SECONDS);
    let mut stack = vec![root.to_path_buf()];
    let mut size = 0u64;
    let mut files = 0usize;
    let mut folders = 0usize;
    let mut examined = 0usize;
    while let Some(folder) = stack.pop() {
        let Ok(entries) = fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            examined += 1;
            if examined > PROPERTIES_MAX_ENTRIES || started.elapsed() > limit {
                return (size, files, folders, true);
            }
            // DirEntry::metadata 不跟随符号链接，链接直接跳过。
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                folders += 1;
                stack.push(entry.path());
            } else {
                files += 1;
                size += metadata.len();
            }
        }
    }
    (size, files, folders, false)
}

fn properties_blocking(path: &str) -> Result<FileProperties, String> {
    let (target, metadata) = existing_entry(path)?;
    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let folder = target
        .parent()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let extension = target
        .extension()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let is_dir = metadata.is_dir();
    let mut size = metadata.len();
    let mut files = 0;
    let mut folders = 0;
    let mut partial = false;
    if is_dir {
        (size, files, folders, partial) = measure_folder(&target);
    }
    Ok(FileProperties {
        name,
        path: target.to_string_lossy().into_owned(),
        folder,
        is_dir,
        extension,
        size,
        files,
        folders,
        partial,
        created: millis(metadata.created()),
        modified: millis(metadata.modified()),
        accessed: millis(metadata.accessed()),
        readonly: metadata.permissions().readonly(),
    })
}

/// 读取文件或文件夹的属性。
#[tauri::command]
pub async fn file_properties(path: String) -> Result<FileProperties, String> {
    let task = tauri::async_runtime::spawn_blocking(move || properties_blocking(&path));
    task.await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("documentcraft-fileops-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn copy_keeps_original_and_never_overwrites() {
        let root = scratch("copy");
        let source = root.join("报告.md");
        fs::write(&source, "正文").unwrap();
        let folder = root.join("目标");
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("报告.md"), "已有").unwrap();

        let copied = copy_entry_blocking(source.to_str().unwrap(), folder.to_str().unwrap()).unwrap();

        assert!(copied.ends_with("报告 - 副本.md"));
        assert_eq!(fs::read_to_string(folder.join("报告.md")).unwrap(), "已有");
        assert_eq!(fs::read_to_string(&copied).unwrap(), "正文");
        assert!(source.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn folder_cannot_move_into_itself() {
        let root = scratch("self");
        let folder = root.join("a");
        let inner = folder.join("b");
        fs::create_dir_all(&inner).unwrap();

        let result = copy_entry_blocking(folder.to_str().unwrap(), inner.to_str().unwrap());

        assert!(result.is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn move_relocates_and_rejects_same_folder() {
        let root = scratch("move");
        let source = root.join("a.txt");
        fs::write(&source, "x").unwrap();
        let folder = root.join("目标");
        fs::create_dir(&folder).unwrap();

        let same = move_entry_blocking(source.to_str().unwrap(), root.to_str().unwrap());
        assert!(same.is_err());

        let moved = move_entry_blocking(source.to_str().unwrap(), folder.to_str().unwrap()).unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read_to_string(&moved).unwrap(), "x");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn properties_count_folder_contents() {
        let root = scratch("props");
        fs::write(root.join("a.txt"), "12345").unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("b.txt"), "123").unwrap();

        let info = properties_blocking(root.to_str().unwrap()).unwrap();

        assert!(info.is_dir);
        assert_eq!(info.files, 2);
        assert_eq!(info.folders, 1);
        assert_eq!(info.size, 8);
        assert!(!info.partial);
        let _ = fs::remove_dir_all(&root);
    }
}
