//! 工作区目录树与 Markdown 文件读写。

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// 单个目录最多列出的条目数，防止误选磁盘根目录时界面卡死。
const MAX_ENTRIES_PER_DIR: usize = 2000;
/// 目录树最大深度。
const MAX_DEPTH: usize = 16;
const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];

#[derive(Serialize)]
pub struct TreeNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<TreeNode>,
}

fn is_markdown(path: &Path) -> bool {
    let extension = path.extension().and_then(|value| value.to_str());
    match extension {
        Some(value) => {
            let lower = value.to_ascii_lowercase();
            MARKDOWN_EXTENSIONS.contains(&lower.as_str())
        }
        None => false,
    }
}

/// 与 Python 端 `_ordinary_path` 一致：跳过符号链接和 Windows 目录联接，避免越出工作区。
fn is_ordinary(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    true
}

/// 目录下没有任何条目（含隐藏条目）。
fn is_empty_dir(path: &Path) -> bool {
    match fs::read_dir(path) {
        Ok(mut entries) => entries.next().is_none(),
        Err(_) => false,
    }
}

fn read_dir_node(path: &Path, depth: usize, show_all: bool) -> Option<TreeNode> {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let mut node = TreeNode {
        name,
        path: path.to_string_lossy().into_owned(),
        is_dir: true,
        children: Vec::new(),
    };
    if depth >= MAX_DEPTH {
        return Some(node);
    }
    let entries = fs::read_dir(path).ok()?;
    let mut directories = Vec::new();
    let mut files = Vec::new();
    for entry in entries.flatten().take(MAX_ENTRIES_PER_DIR) {
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        // 隐藏目录（含 .documentcraft 批注库、.git）不进入目录树。
        if entry_name.starts_with('.') {
            continue;
        }
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !is_ordinary(&metadata) {
            continue;
        }
        let entry_path = entry.path();
        if metadata.is_dir() {
            if let Some(child) = read_dir_node(&entry_path, depth + 1, show_all) {
                // 默认只保留包含 Markdown 的目录，目录树聚焦于可阅读的文档。完全空的目录也保留，
                // 否则刚新建的文件夹会立刻从目录树消失；显示全部文件时所有目录都保留。
                if show_all || !child.children.is_empty() || is_empty_dir(&entry_path) {
                    directories.push(child);
                }
            }
        } else if show_all || is_markdown(&entry_path) {
            files.push(TreeNode {
                name: entry_name,
                path: entry_path.to_string_lossy().into_owned(),
                is_dir: false,
                children: Vec::new(),
            });
        }
    }
    directories.sort_by_key(|item| item.name.to_lowercase());
    files.sort_by_key(|item| item.name.to_lowercase());
    node.children.extend(directories);
    node.children.extend(files);
    Some(node)
}

/// 列出工作区目录树。默认只包含 Markdown 文件和含 Markdown 的目录；`show_all` 为真时列出全部文件和目录。
#[tauri::command]
pub async fn list_tree(root: String, show_all: Option<bool>) -> Result<TreeNode, String> {
    let show_all = show_all.unwrap_or(false);
    let task = tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&root);
        if !path.is_dir() {
            return Err(format!("工作区不是文件夹：{root}"));
        }
        read_dir_node(&path, 0, show_all).ok_or_else(|| format!("无法读取工作区：{root}"))
    });
    task.await.map_err(|error| error.to_string())?
}

/// 以 UTF-8 读取 Markdown，去掉 BOM。
#[tauri::command]
pub fn read_text(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|error| format!("无法读取 {path}：{error}"))?;
    let text = String::from_utf8(bytes).map_err(|_| format!("{path} 不是 UTF-8 编码的文本"))?;
    let content = text.strip_prefix('\u{feff}').unwrap_or(&text);
    Ok(content.to_string())
}

/// 保存 Markdown。先写同目录临时文件再替换，避免写到一半时源文件损坏。
#[tauri::command]
pub fn write_text(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !is_markdown(&target) {
        return Err("只能保存 Markdown 文件。".to_string());
    }
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if !is_ordinary(&metadata) {
            return Err("目标是链接，已拒绝写入。".to_string());
        }
    }
    let directory = target
        .parent()
        .ok_or_else(|| "保存路径缺少目录。".to_string())?;
    let file_name = target
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let staged = directory.join(format!(".{file_name}.documentcraft-save"));
    let write_result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&staged)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&staged);
        return Err(format!("保存失败：{error}"));
    }
    // Windows 上 rename 可以替换已有文件（MoveFileEx + REPLACE_EXISTING）。
    if let Err(error) = fs::rename(&staged, &target) {
        let _ = fs::remove_file(&staged);
        return Err(format!("保存失败：{error}"));
    }
    Ok(())
}

/// 创建目录（含上级目录），供 Copilot 保存对话和命令文件使用。
#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|error| format!("无法创建目录 {path}：{error}"))
}

/// 校验新建条目的名称：单个路径片段，不含分隔符、Windows 保留字符和结尾的点或空格。
fn validate_entry_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed != name {
        return Err("名称不能为空，且不能以空格开头或结尾。".to_string());
    }
    if name.ends_with('.') || name == ".." {
        return Err("名称不能以点结尾。".to_string());
    }
    if name.chars().any(|ch| ch.is_control() || "<>:\"/\\|?*".contains(ch)) {
        return Err("名称不能包含 < > : \" / \\ | ? * 等字符。".to_string());
    }
    Ok(())
}

/// 在指定目录下新建空的 Markdown 文件，返回其路径。已存在同名条目时拒绝，不覆盖。
#[tauri::command]
pub fn create_markdown(directory: String, name: String) -> Result<String, String> {
    validate_entry_name(&name)?;
    let target = Path::new(&directory).join(&name);
    if !is_markdown(&target) {
        return Err("文件名需以 .md 或 .markdown 结尾。".to_string());
    }
    // create_new 保证不会覆盖已有文件。
    let file = fs::OpenOptions::new().write(true).create_new(true).open(&target);
    match file {
        Ok(_) => Ok(target.to_string_lossy().into_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(format!("已存在同名文件：{name}")),
        Err(error) => Err(format!("无法创建 {name}：{error}")),
    }
}

/// 在指定目录下新建文件夹，返回其路径。已存在同名条目时拒绝。
#[tauri::command]
pub fn create_folder(directory: String, name: String) -> Result<String, String> {
    validate_entry_name(&name)?;
    let target = Path::new(&directory).join(&name);
    match fs::create_dir(&target) {
        Ok(()) => Ok(target.to_string_lossy().into_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(format!("已存在同名条目：{name}")),
        Err(error) => Err(format!("无法创建 {name}：{error}")),
    }
}

/// 删除一个 Markdown 文件（如 Copilot 对话记录或命令）。前端在调用前已向用户确认。
#[tauri::command]
pub fn remove_markdown(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !is_markdown(&target) {
        return Err("只能删除 Markdown 文件。".to_string());
    }
    let metadata = fs::symlink_metadata(&target).map_err(|error| format!("无法读取 {path}：{error}"))?;
    if !is_ordinary(&metadata) || !metadata.is_file() {
        return Err("目标不是普通文件，已拒绝删除。".to_string());
    }
    fs::remove_file(&target).map_err(|error| format!("无法删除 {path}：{error}"))
}

/// 搜索最多读取的 Markdown 文件数、单个文件大小，以及返回的匹配总数和单文件匹配数。
const MAX_SEARCH_FILES: usize = 5000;
const MAX_SEARCH_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SEARCH_MATCHES: usize = 500;
const MAX_MATCHES_PER_FILE: usize = 50;
/// 匹配前后保留的上下文字符数。
const SNIPPET_BEFORE: usize = 30;
const SNIPPET_AFTER: usize = 60;

#[derive(Serialize)]
pub struct SearchMatch {
    /// 从 1 起的行号。
    line: usize,
    /// 该匹配是文件中第几处（从 0 起），供前端在排版后的正文中定位。
    occurrence: usize,
    before: String,
    hit: String,
    after: String,
}

#[derive(Serialize)]
pub struct SearchFile {
    path: String,
    name: String,
    name_match: bool,
    matches: Vec<SearchMatch>,
    /// 文件中的匹配超过单文件上限，未全部列出。
    more: bool,
}

#[derive(Serialize)]
pub struct SearchResult {
    files: Vec<SearchFile>,
    /// 达到文件数或匹配总数上限，结果不完整。
    truncated: bool,
}

/// 逐字符小写，保证小写后的字符序号与原文一一对应，便于截取上下文。
fn lower_chars(text: &str) -> Vec<char> {
    text.chars()
        .map(|ch| ch.to_lowercase().next().unwrap_or(ch))
        .collect()
}

/// 返回 needle 在 haystack 中所有不重叠出现的起始字符序号。
fn find_all(haystack: &[char], needle: &[char]) -> Vec<usize> {
    let mut starts = Vec::new();
    if needle.is_empty() || haystack.len() < needle.len() {
        return starts;
    }
    let mut index = 0;
    while index + needle.len() <= haystack.len() {
        if haystack[index..index + needle.len()] == *needle {
            starts.push(index);
            index += needle.len();
        } else {
            index += 1;
        }
    }
    starts
}

fn snippet(chars: &[char], start: usize, length: usize) -> (String, String, String) {
    let from = start.saturating_sub(SNIPPET_BEFORE);
    let end = start + length;
    let to = (end + SNIPPET_AFTER).min(chars.len());
    let mut before: String = chars[from..start].iter().collect();
    let hit: String = chars[start..end].iter().collect();
    let mut after: String = chars[end..to].iter().collect();
    if from > 0 {
        before.insert(0, '…');
    }
    if to < chars.len() {
        after.push('…');
    }
    (before.trim_start().to_string(), hit, after.trim_end().to_string())
}

/// 收集工作区内的 Markdown 文件，规则与目录树一致：跳过隐藏目录、链接和目录联接。
fn collect_markdown(path: &Path, depth: usize, files: &mut Vec<PathBuf>) {
    if depth >= MAX_DEPTH || files.len() >= MAX_SEARCH_FILES {
        return;
    }
    let entries = match fs::read_dir(path) {
        Ok(value) => value,
        Err(_) => return,
    };
    let mut children: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten().take(MAX_ENTRIES_PER_DIR) {
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        if entry_name.starts_with('.') {
            continue;
        }
        children.push(entry.path());
    }
    children.sort_by_key(|item| item.to_string_lossy().to_lowercase());
    for child in children {
        if files.len() >= MAX_SEARCH_FILES {
            return;
        }
        let metadata = match fs::symlink_metadata(&child) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !is_ordinary(&metadata) {
            continue;
        }
        if metadata.is_dir() {
            collect_markdown(&child, depth + 1, files);
        } else if is_markdown(&child) && metadata.len() <= MAX_SEARCH_FILE_BYTES {
            files.push(child);
        }
    }
}

fn search_file(path: &Path, needle: &[char], budget: usize) -> Option<SearchFile> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let name_match = !find_all(&lower_chars(&name), needle).is_empty();
    // 非 UTF-8 文件只按文件名匹配。
    let text = fs::read(path).ok().and_then(|bytes| String::from_utf8(bytes).ok()).unwrap_or_default();
    let limit = budget.min(MAX_MATCHES_PER_FILE);
    let mut matches = Vec::new();
    let mut occurrence = 0;
    let mut more = false;
    for (index, line) in text.lines().enumerate() {
        let original: Vec<char> = line.chars().collect();
        let lowered = lower_chars(line);
        for start in find_all(&lowered, needle) {
            if matches.len() >= limit {
                more = true;
                break;
            }
            let (before, hit, after) = snippet(&original, start, needle.len());
            matches.push(SearchMatch { line: index + 1, occurrence, before, hit, after });
            occurrence += 1;
        }
        if more {
            break;
        }
    }
    if !name_match && matches.is_empty() {
        return None;
    }
    Some(SearchFile {
        path: path.to_string_lossy().into_owned(),
        name,
        name_match,
        matches,
        more,
    })
}

fn search_root(root: &Path, query: &str) -> SearchResult {
    let needle = lower_chars(query.trim());
    let mut paths = Vec::new();
    collect_markdown(root, 0, &mut paths);
    let mut truncated = paths.len() >= MAX_SEARCH_FILES;
    let mut files = Vec::new();
    let mut total = 0;
    for path in paths {
        if total >= MAX_SEARCH_MATCHES {
            truncated = true;
            break;
        }
        if let Some(file) = search_file(&path, &needle, MAX_SEARCH_MATCHES - total) {
            total += file.matches.len();
            files.push(file);
        }
    }
    SearchResult { files, truncated }
}

/// 在工作区所有 Markdown 中按文件名和正文搜索，不区分大小写。结果按文件路径排序。
#[tauri::command]
pub async fn search_workspace(root: String, query: String) -> Result<SearchResult, String> {
    if query.trim().is_empty() {
        return Ok(SearchResult { files: Vec::new(), truncated: false });
    }
    let task = tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&root);
        if !path.is_dir() {
            return Err(format!("工作区不是文件夹：{root}"));
        }
        Ok(search_root(&path, &query))
    });
    task.await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("documentcraft-ws-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("子目录").join("空目录")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        root
    }

    #[test]
    fn tree_lists_markdown_keeps_empty_folders_and_skips_hidden() {
        let root = scratch("tree");
        fs::write(root.join("报告.md"), "# 报告\n").unwrap();
        fs::write(root.join("说明.txt"), "x").unwrap();
        fs::write(root.join("子目录").join("笔记.markdown"), "# 笔记\n").unwrap();
        fs::write(root.join(".hidden").join("隐藏.md"), "# 隐藏\n").unwrap();
        let tree = read_dir_node(&root, 0, false).unwrap();
        let names: Vec<&str> = tree.children.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(names, vec!["子目录", "报告.md"]);
        let folder = &tree.children[0];
        let inner: Vec<&str> = folder.children.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(inner, vec!["空目录", "笔记.markdown"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn show_all_lists_other_files_and_empty_folders() {
        let root = scratch("all");
        fs::write(root.join("说明.txt"), "x").unwrap();
        fs::write(root.join(".hidden").join("隐藏.md"), "# 隐藏
").unwrap();
        let tree = read_dir_node(&root, 0, true).unwrap();
        let names: Vec<&str> = tree.children.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(names, vec!["子目录", "说明.txt"]);
        assert_eq!(tree.children[0].children.len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_entries_refuse_overwrite_and_bad_names() {
        let root = scratch("create");
        let dir = root.to_string_lossy().into_owned();
        let created = create_markdown(dir.clone(), "新笔记.md".to_string()).unwrap();
        fs::write(&created, "keep").unwrap();
        assert!(create_markdown(dir.clone(), "新笔记.md".to_string()).is_err());
        assert_eq!(fs::read_to_string(&created).unwrap(), "keep");
        assert!(create_markdown(dir.clone(), "a.txt".to_string()).is_err());
        assert!(create_markdown(dir.clone(), "..\\x.md".to_string()).is_err());
        assert!(create_folder(dir.clone(), "新文件夹".to_string()).is_ok());
        assert!(create_folder(dir.clone(), "新文件夹".to_string()).is_err());
        assert!(create_folder(dir, "a/b".to_string()).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn search_matches_names_and_lines_case_insensitively() {
        let root = scratch("search");
        fs::write(root.join("流量报告.md"), "# Flow 试验\n第二行没有\n入口 flow 与 FLOW 两处\n").unwrap();
        fs::write(root.join("子目录").join("笔记.md"), "无关内容\n").unwrap();
        fs::write(root.join("说明.txt"), "flow").unwrap();
        fs::write(root.join(".hidden").join("隐藏.md"), "flow").unwrap();
        let result = search_root(&root, "flow");
        assert_eq!(result.files.len(), 1);
        let file = &result.files[0];
        assert_eq!(file.name, "流量报告.md");
        assert!(!file.name_match);
        let lines: Vec<usize> = file.matches.iter().map(|item| item.line).collect();
        assert_eq!(lines, vec![1, 3, 3]);
        let occurrences: Vec<usize> = file.matches.iter().map(|item| item.occurrence).collect();
        assert_eq!(occurrences, vec![0, 1, 2]);
        assert_eq!(file.matches[2].hit, "FLOW");
        assert_eq!(file.matches[1].before, "入口 ");
        let by_name = search_root(&root, "笔记");
        assert_eq!(by_name.files.len(), 1);
        assert!(by_name.files[0].name_match);
        assert!(by_name.files[0].matches.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_then_read_keeps_text_and_rejects_other_extensions() {
        let root = scratch("write");
        let path = root.join("文档.md").to_string_lossy().into_owned();
        fs::write(&path, "\u{feff}旧内容\r\n").unwrap();
        assert_eq!(read_text(path.clone()).unwrap(), "旧内容\r\n");
        write_text(path.clone(), "# 新内容\r\n".to_string()).unwrap();
        assert_eq!(read_text(path.clone()).unwrap(), "# 新内容\r\n");
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains("documentcraft-save"))
            .collect();
        assert!(leftovers.is_empty());
        let other = root.join("a.txt").to_string_lossy().into_owned();
        assert!(write_text(other, "x".to_string()).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
