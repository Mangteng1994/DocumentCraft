//! 图片重命名：读取完整工作区引用，锁定待更新文档后改名并回写，失败时恢复。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::{fileops, workspace};

const MAX_SCAN_ENTRIES: usize = 1_000_000;
const MAX_MARKDOWN_BYTES: usize = 128 * 1024 * 1024;
const MAX_SCAN_SECONDS: u64 = 60;

#[derive(Serialize)]
pub struct ImageRenameDocument {
    path: String,
    content: String,
}

#[derive(Deserialize)]
pub struct ImageReferenceChange {
    path: String,
    original: String,
    content: String,
}

fn is_markdown(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
}

/// 保留原始 UTF-8 文本，读取前后均核对体积预算，并按真实路径去重。
fn read_document(
    path: &Path,
    documents: &mut Vec<ImageRenameDocument>,
    seen: &mut HashSet<PathBuf>,
    total_bytes: &mut usize,
) -> Result<(), String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("无法定位文档 {}：{error}", path.display()))?;
    if !seen.insert(canonical) {
        return Ok(());
    }
    let size = fs::metadata(path)
        .map_err(|error| format!("无法读取 {}：{error}", path.display()))?
        .len();
    if size > (MAX_MARKDOWN_BYTES - *total_bytes) as u64 {
        return Err("工作区 Markdown 内容过多，未改名。请打开更小的工作区后重试。".to_string());
    }
    let bytes =
        fs::read(path).map_err(|error| format!("无法检查图片引用 {}：{error}", path.display()))?;
    *total_bytes += bytes.len();
    if *total_bytes > MAX_MARKDOWN_BYTES {
        return Err("工作区 Markdown 内容过多，未改名。请打开更小的工作区后重试。".to_string());
    }
    // 保留 BOM 和原换行，前端只按语法节点位置替换引用，不重排整篇文档。
    let content = String::from_utf8(bytes).map_err(|_| {
        format!(
            "{} 不是 UTF-8 Markdown，无法完整检查引用，未改名。",
            path.display()
        )
    })?;
    documents.push(ImageRenameDocument {
        path: path.to_string_lossy().into_owned(),
        content,
    });
    Ok(())
}

/// 遍历可见目录和补充页签；读取不完整时直接失败，保持图片与文档原样。
fn scan_documents(
    root: String,
    extra_paths: Vec<String>,
) -> Result<Vec<ImageRenameDocument>, String> {
    let mut pending = vec![PathBuf::from(root)];
    let mut documents = Vec::new();
    let mut seen = HashSet::new();
    let mut total_bytes = 0;
    let mut visited = 0;
    let started = Instant::now();
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("无法检查目录 {}：{error}", directory.display()))?;
        for entry in entries {
            visited += 1;
            if visited > MAX_SCAN_ENTRIES
                || started.elapsed() > Duration::from_secs(MAX_SCAN_SECONDS)
            {
                return Err(
                    "工作区过大，未能完整检查图片引用，未改名。请打开更小的工作区后重试。"
                        .to_string(),
                );
            }
            let entry = entry.map_err(|error| format!("无法读取目录条目：{error}"))?;
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let metadata = entry
                .metadata()
                .map_err(|error| format!("无法检查 {}：{error}", entry.path().display()))?;
            if !workspace::is_ordinary(&metadata) {
                continue;
            }
            let path = entry.path();
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() && is_markdown(&path) {
                read_document(&path, &mut documents, &mut seen, &mut total_bytes)?;
            }
        }
    }
    // 跨工作区保留的已打开页签也要同步；已被外部删除的文档由内存现场继续保留。
    for value in extra_paths {
        let path = PathBuf::from(value);
        if !path.is_file() || !is_markdown(&path) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if workspace::is_ordinary(&metadata) {
            read_document(&path, &mut documents, &mut seen, &mut total_bytes)?;
        }
    }
    Ok(documents)
}

/// 完整读取工作区可见 Markdown；遇到预算耗尽或无法读取时整体失败，避免遗漏共用引用。
#[tauri::command]
pub async fn image_rename_documents(
    root: String,
    extra_paths: Vec<String>,
) -> Result<Vec<ImageRenameDocument>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_documents(root, extra_paths))
        .await
        .map_err(|error| error.to_string())?
}

struct LockedDocument {
    file: File,
    change: ImageReferenceChange,
}

/// 在已持有的独占文件句柄上回写内容，保留文件本身的权限与身份。
fn write_locked(file: &mut File, content: &str) -> std::io::Result<()> {
    file.seek(SeekFrom::Start(0))?;
    file.write_all(content.as_bytes())?;
    file.set_len(content.len() as u64)?;
    file.sync_all()
}

/// 核对源图片与全部待改文档，完成文件改名和引用写入；失败时恢复并报告恢复异常。
fn commit_rename(
    document: String,
    source: String,
    new_stem: String,
    changes: Vec<ImageReferenceChange>,
) -> Result<String, String> {
    let source_path = PathBuf::from(&source);
    let metadata =
        fs::symlink_metadata(&source_path).map_err(|error| format!("无法读取图片：{error}"))?;
    if !metadata.is_file() || !workspace::is_ordinary(&metadata) {
        return Err("只能重命名普通本地图片文件。".to_string());
    }
    let directory = Path::new(&document).parent().ok_or("文档路径缺少目录。")?;
    let assets = fs::canonicalize(directory.join("assets"))
        .map_err(|error| format!("无法定位 assets：{error}"))?;
    let canonical_source = fs::canonicalize(&source_path).map_err(|error| error.to_string())?;
    if !canonical_source.starts_with(assets) {
        return Err("仅支持重命名当前文档 assets 文件夹中的图片。".to_string());
    }
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or("图片缺少扩展名。")?;
    crate::images::normalized_extension(extension)?;
    let stem = new_stem.trim();
    let name = fileops::validate_new_name(&format!("{stem}.{extension}"))?;
    if stem.is_empty() {
        return Err("图片名称不能为空。".to_string());
    }
    let original_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("无法读取原图片名称。")?;
    if original_name == name {
        return Ok(source);
    }

    let mut locked = Vec::new();
    let mut seen = HashSet::new();
    for change in changes {
        let path = Path::new(&change.path);
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("无法检查 {}：{error}", change.path))?;
        if !is_markdown(path) || !metadata.is_file() || !workspace::is_ordinary(&metadata) {
            return Err(format!("拒绝更新非普通 Markdown 文件：{}", change.path));
        }
        let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
        if !seen.insert(canonical) {
            return Err("文档更新列表中出现重复路径。".to_string());
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true);
        // Windows 中从校验到回写均保持独占句柄，阻止其他程序在检查后覆盖文件。
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let mut file = options
            .open(path)
            .map_err(|error| format!("无法锁定 {}，请关闭占用程序后重试：{error}", change.path))?;
        let mut original = Vec::new();
        file.read_to_end(&mut original)
            .map_err(|error| error.to_string())?;
        if original != change.original.as_bytes() {
            return Err(format!("{} 已被外部修改，未改名，请重试。", change.path));
        }
        locked.push(LockedDocument { file, change });
    }

    // 复用文件树的名称校验和重名保护；先取得全部文档句柄，再进行文件改名。
    let target = fileops::rename_entry_blocking(&source, &name)?;
    for index in 0..locked.len() {
        let item = &mut locked[index];
        if let Err(error) = write_locked(&mut item.file, &item.change.content) {
            let failed_path = item.change.path.clone();
            let mut failures = Vec::new();
            for previous in &mut locked[..=index] {
                if let Err(restore_error) =
                    write_locked(&mut previous.file, &previous.change.original)
                {
                    failures.push(format!("{}：{restore_error}", previous.change.path));
                }
            }
            if let Err(restore_error) = fileops::rename_entry_blocking(&target, original_name) {
                failures.push(format!("图片 {target}：{restore_error}"));
            }
            if failures.is_empty() {
                return Err(format!(
                    "无法更新 {failed_path}：{error}；已恢复原文件名与引用。"
                ));
            }
            return Err(format!(
                "无法更新 {failed_path}：{error}；以下文件恢复失败，请检查：{}",
                failures.join("；")
            ));
        }
    }
    Ok(target)
}

/// 改名并同步已核对过的 Markdown 引用，保持扩展名、拒绝覆盖，写入失败时恢复。
#[tauri::command]
pub async fn rename_image_with_references(
    document: String,
    source: String,
    new_stem: String,
    changes: Vec<ImageReferenceChange>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || commit_rename(document, source, new_stem, changes))
        .await
        .map_err(|error| error.to_string())?
}
