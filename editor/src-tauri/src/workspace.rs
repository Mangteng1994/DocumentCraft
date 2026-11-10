//! 工作区目录树与 Markdown 文件读写。

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::extract::PAGE_BREAK;
use crate::textindex::{fold_text, indexable, DocEntry, IndexProgress, SearchIndex};

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

/// 搜索最多收集的文件数、读取正文的单个文件大小，以及返回的匹配总数和单文件匹配数。
const MAX_SEARCH_FILES: usize = 20000;
const MAX_SEARCH_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SEARCH_MATCHES: usize = 500;
const MAX_MATCHES_PER_FILE: usize = 50;
/// 匹配前后保留的上下文字符数。
const SNIPPET_BEFORE: usize = 30;
const SNIPPET_AFTER: usize = 60;
/// 在文档正文中截取上下文时，向命中位置前后查找行边界的最大字节数。中文每字 3 字节，
/// 60 个字符约 180 字节，留有余量；限制窗口是为了避免 PDF 中的超长行拖慢截取。
const SNIPPET_WINDOW_BYTES: usize = 240;
/// 按纯文本读取正文的扩展名。Word、PDF、Excel 等文档由 textindex 解析后检索，不在其中。
/// 只按扩展名判断，不嗅探内容：这些文件不是 UTF-8 时读取会失败，只能按文件名匹配。
const TEXT_EXTENSIONS: [&str; 44] = [
    "md", "markdown", "txt", "text", "csv", "tsv", "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf",
    "log", "xml", "html", "htm", "css", "js", "jsx", "ts", "tsx", "py", "rs", "java", "c", "cpp", "h", "hpp", "go",
    "sh", "sql", "tex", "bib", "rst", "org", "srt", "vtt", "base", "canvas", "ps1", "bat", "cmd",
];

/// 搜索范围：全部（文件名 + 正文）、只搜文件名、只搜正文。
#[derive(Clone, Copy, PartialEq)]
enum SearchMode {
    All,
    Names,
    Text,
}

impl SearchMode {
    fn parse(value: &str) -> Result<SearchMode, String> {
        match value {
            "all" => Ok(SearchMode::All),
            "names" => Ok(SearchMode::Names),
            "text" => Ok(SearchMode::Text),
            other => Err(format!("未知的搜索范围：{other}")),
        }
    }

    fn matches_names(self) -> bool {
        self != SearchMode::Text
    }

    fn matches_content(self) -> bool {
        self != SearchMode::Names
    }
}

#[derive(Serialize)]
pub struct SearchMatch {
    /// 从 1 起的行号。文档类结果为 0，位置见 locator。
    line: usize,
    /// 该匹配是文件中第几处（从 0 起），供前端在排版后的正文中定位。
    occurrence: usize,
    /// 位置说明：纯文本是行号，文档是「第 N 页」「第 N 段」等。
    locator: String,
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

/// 文档（docx、xlsx、pptx、pdf）正文索引的覆盖情况，随搜索结果返回，供界面提示进度。
#[derive(Serialize, Default)]
pub struct DocStats {
    /// 工作区内可解析的文档总数。
    total: usize,
    /// 已建立索引的文档数。
    indexed: usize,
    /// 解析失败（加密、损坏等）的文档数。
    failed: usize,
    /// 解析成功但没有文字的文档数，多为扫描件。
    no_text: usize,
    /// 索引正在后台建立。
    running: bool,
}

#[derive(Serialize)]
pub struct SearchResult {
    files: Vec<SearchFile>,
    /// 达到文件数或匹配总数上限，结果不完整。
    truncated: bool,
    docs: DocStats,
}

type DocIndex = HashMap<String, Arc<DocEntry>>;

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

/// 扩展名属于可按纯文本读取的类型。
fn is_text_file(path: &Path) -> bool {
    let extension = path.extension().and_then(|value| value.to_str());
    match extension {
        Some(value) => {
            let lower = value.to_ascii_lowercase();
            TEXT_EXTENSIONS.contains(&lower.as_str())
        }
        None => false,
    }
}

/// 收集工作区内的全部文件，规则与目录树一致：跳过隐藏文件和目录、链接和目录联接。
pub(crate) fn collect_files(path: &Path, depth: usize, files: &mut Vec<PathBuf>) {
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
            collect_files(&child, depth + 1, files);
        } else {
            files.push(child);
        }
    }
}

/// 读取纯文本文件的内容。过大或不是 UTF-8 时返回 None，此时该文件只能按文件名匹配。
fn read_searchable_text(path: &Path) -> Option<String> {
    if !is_text_file(path) {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_SEARCH_FILE_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    String::from_utf8(bytes).ok()
}

fn floor_boundary(text: &str, mut index: usize) -> usize {
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_boundary(text: &str, mut index: usize) -> usize {
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

/// 按字符数截取命中位置前后的上下文，超出时加省略号。
fn snippet_parts(before: &str, hit: &str, after: &str) -> (String, String, String) {
    let before_count = before.chars().count();
    let skipped = before_count.saturating_sub(SNIPPET_BEFORE);
    let mut shown_before: String = before.chars().skip(skipped).collect();
    if skipped > 0 {
        shown_before.insert(0, '…');
    }
    let mut shown_after: String = after.chars().take(SNIPPET_AFTER).collect();
    if after.chars().count() > SNIPPET_AFTER {
        shown_after.push('…');
    }
    (shown_before.trim_start().to_string(), hit.to_string(), shown_after.trim_end().to_string())
}

/// 在已索引的文档正文中查找 needle（已折叠大小写）。位置按文档类型给出页、段或行。
fn search_document(entry: &DocEntry, needle: &str, budget: usize) -> (Vec<SearchMatch>, bool) {
    let limit = budget.min(MAX_MATCHES_PER_FILE);
    let mut matches = Vec::new();
    let mut more = false;
    let mut counted_to = 0;
    let mut newlines = 0;
    let mut pages = 0;
    let text = entry.text.as_str();
    let is_break = |character: char| character == '\n' || character == PAGE_BREAK;
    for (occurrence, (start, _)) in entry.lower.match_indices(needle).enumerate() {
        if matches.len() >= limit {
            more = true;
            break;
        }
        // 位置计数只扫描上一个命中到这一个命中之间的字节，整篇文档只扫一遍。
        for byte in &text.as_bytes()[counted_to..start] {
            if *byte == b'\n' {
                newlines += 1;
            } else if *byte == PAGE_BREAK as u8 {
                pages += 1;
            }
        }
        counted_to = start;
        let end = start + needle.len();
        let window_start = floor_boundary(text, start.saturating_sub(SNIPPET_WINDOW_BYTES));
        let line_start = match text[window_start..start].rfind(is_break) {
            Some(index) => window_start + index + 1,
            None => window_start,
        };
        let window_end = ceil_boundary(text, (end + SNIPPET_WINDOW_BYTES).min(text.len()));
        let line_end = match text[end..window_end].find(is_break) {
            Some(index) => end + index,
            None => window_end,
        };
        let (before, hit, after) = snippet_parts(&text[line_start..start], &text[start..end], &text[end..line_end]);
        matches.push(SearchMatch { line: 0, occurrence, locator: entry.kind.locator(newlines, pages), before, hit, after });
    }
    (matches, more)
}

/// 在纯文本中按行查找，返回匹配和是否超出单文件上限。
fn search_plain_text(text: &str, needle: &[char], budget: usize) -> (Vec<SearchMatch>, bool) {
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
            matches.push(SearchMatch { line: index + 1, occurrence, locator: (index + 1).to_string(), before, hit, after });
            occurrence += 1;
        }
        if more {
            break;
        }
    }
    (matches, more)
}

fn search_file(path: &Path, needle: &[char], folded: &str, mode: SearchMode, docs: &DocIndex, budget: usize) -> Option<SearchFile> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let name_match = mode.matches_names() && !find_all(&lower_chars(&name), needle).is_empty();
    let mut matches = Vec::new();
    let mut more = false;
    if mode.matches_content() {
        let key = path.to_string_lossy();
        if let Some(entry) = docs.get(key.as_ref()) {
            (matches, more) = search_document(entry, folded, budget);
        } else if let Some(text) = read_searchable_text(path) {
            (matches, more) = search_plain_text(&text, needle, budget);
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

/// 统计文档正文索引对当前工作区的覆盖情况。
fn document_stats(paths: &[PathBuf], docs: &DocIndex, running: bool) -> DocStats {
    let mut stats = DocStats { running, ..DocStats::default() };
    for path in paths {
        if indexable(path).is_none() {
            continue;
        }
        stats.total += 1;
        let key = path.to_string_lossy();
        if let Some(entry) = docs.get(key.as_ref()) {
            stats.indexed += 1;
            if entry.error.is_some() {
                stats.failed += 1;
            } else if entry.text.trim().is_empty() {
                stats.no_text += 1;
            }
        }
    }
    stats
}

fn search_root(root: &Path, query: &str, mode: SearchMode, docs: &DocIndex, indexing: bool) -> SearchResult {
    let trimmed = query.trim();
    let needle = lower_chars(trimmed);
    let folded = fold_text(trimmed);
    let mut paths = Vec::new();
    collect_files(root, 0, &mut paths);
    let mut truncated = paths.len() >= MAX_SEARCH_FILES;
    let mut files = Vec::new();
    let mut total = 0;
    for path in &paths {
        if total >= MAX_SEARCH_MATCHES {
            truncated = true;
            break;
        }
        if let Some(file) = search_file(path, &needle, &folded, mode, docs, MAX_SEARCH_MATCHES - total) {
            total += file.matches.len();
            files.push(file);
        }
    }
    let stats = if mode.matches_content() { document_stats(&paths, docs, indexing) } else { DocStats::default() };
    SearchResult { files, truncated, docs: stats }
}

/// 在工作区中搜索，不区分大小写，结果按文件路径排序。mode 取 `all`（文件名 + 正文）、
/// `names`（只搜文件名，含全部文件类型）、`text`（只搜正文）。正文包括纯文本文件和已建立索引的
/// Word、Excel、PowerPoint、PDF；索引未完成时只覆盖已索引的部分，进度见返回值的 docs。
#[tauri::command]
pub async fn search_workspace(
    index: tauri::State<'_, Arc<SearchIndex>>,
    root: String,
    query: String,
    mode: String,
) -> Result<SearchResult, String> {
    let mode = SearchMode::parse(&mode)?;
    if query.trim().is_empty() {
        return Ok(SearchResult { files: Vec::new(), truncated: false, docs: DocStats::default() });
    }
    let (docs, indexing) = index.snapshot(&root);
    let task = tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&root);
        if !path.is_dir() {
            return Err(format!("工作区不是文件夹：{root}"));
        }
        Ok(search_root(&path, &query, mode, &docs, indexing))
    });
    task.await.map_err(|error| error.to_string())?
}

/// 在后台建立或增量更新工作区的文档正文索引，进度通过 `search-index` 事件发给前端。
/// 已有任务在运行时直接返回。文档很多时首次建立可能持续数分钟，期间搜索仍可使用。
#[tauri::command]
pub async fn index_workspace(
    app: tauri::AppHandle,
    index: tauri::State<'_, Arc<SearchIndex>>,
    root: String,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let cache_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定缓存位置：{error}"))?
        .join("search-cache");
    let index = Arc::clone(&index);
    let task = tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&root);
        if !path.is_dir() {
            return Err(format!("工作区不是文件夹：{root}"));
        }
        let mut files = Vec::new();
        collect_files(&path, 0, &mut files);
        let emitter = app.clone();
        let report = move |progress: IndexProgress| {
            let _ = emitter.emit("search-index", progress);
        };
        index.run(&root, &files, &cache_root, &report);
        Ok(())
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
        fs::write(root.join(".hidden").join("隐藏.md"), "flow").unwrap();
        let result = search_root(&root, "flow", SearchMode::All, &HashMap::new(), false);
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
        let by_name = search_root(&root, "笔记", SearchMode::All, &HashMap::new(), false);
        assert_eq!(by_name.files.len(), 1);
        assert!(by_name.files[0].name_match);
        assert!(by_name.files[0].matches.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn search_modes_cover_names_of_all_files_and_text_content() {
        let root = scratch("modes");
        fs::write(root.join("报告.md"), "# 流速\n").unwrap();
        fs::write(root.join("流速记录.txt"), "第一行\n流速 0.5\n").unwrap();
        fs::write(root.join("流速分析.docx"), [0u8, 1, 2]).unwrap();
        // xlsx 是压缩包，正文里即使出现关键词也不读取。
        fs::write(root.join("数据.xlsx"), "PK 流速".as_bytes()).unwrap();
        fs::write(root.join("旧文件.txt"), [0xB6u8, 0xD4, 0xB1, 0xC8]).unwrap();
        fs::write(root.join(".hidden").join("流速.txt"), "流速").unwrap();
        let names_of = |result: &SearchResult| -> Vec<String> { result.files.iter().map(|file| file.name.clone()).collect() };

        // 所有：全部文件的文件名 + 纯文本正文；二进制文件正文不读取，隐藏目录不搜。
        let all = search_root(&root, "流速", SearchMode::All, &HashMap::new(), false);
        assert_eq!(names_of(&all), vec!["报告.md", "流速分析.docx", "流速记录.txt"]);
        let docx = all.files.iter().find(|file| file.name == "流速分析.docx").unwrap();
        assert!(docx.name_match && docx.matches.is_empty());
        let text = all.files.iter().find(|file| file.name == "流速记录.txt").unwrap();
        assert!(text.name_match);
        assert_eq!(text.matches.len(), 1);
        assert_eq!(text.matches[0].line, 2);

        // 所有文件名：只匹配文件名，不读取正文。
        let names = search_root(&root, "流速", SearchMode::Names, &HashMap::new(), false);
        assert_eq!(names_of(&names), vec!["流速分析.docx", "流速记录.txt"]);
        assert!(names.files.iter().all(|file| file.matches.is_empty()));

        // 所有纯文本正文：只匹配纯文本内容，文件名不参与，非 UTF-8 的文本被跳过。
        let content = search_root(&root, "流速", SearchMode::Text, &HashMap::new(), false);
        assert_eq!(names_of(&content), vec!["报告.md", "流速记录.txt"]);
        assert!(content.files.iter().all(|file| !file.name_match));
        let legacy = search_root(&root, "旧文件", SearchMode::Text, &HashMap::new(), false);
        assert!(legacy.files.is_empty());
        assert!(SearchMode::parse("bogus").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn document_search_reports_page_paragraph_and_index_coverage() {
        let root = scratch("docs");
        let report = root.join("报告.pdf");
        let slides = root.join("汇报.pptx");
        let sheet = root.join("数据.xlsx");
        let scanned = root.join("扫描件.pdf");
        for path in [&report, &slides, &sheet, &scanned, &root.join("待索引.docx")] {
            fs::write(path, "x").unwrap();
        }
        let mut docs: DocIndex = HashMap::new();
        let mut add = |path: &Path, kind: crate::extract::DocKind, text: &str, error: Option<&str>| {
            let entry = DocEntry { kind, lower: fold_text(text), text: text.to_string(), error: error.map(str::to_string) };
            docs.insert(path.to_string_lossy().into_owned(), Arc::new(entry));
        };
        // PDF：第 1 页没有关键词，第 2 页有两处；大写英文也要能搜到。
        add(&report, crate::extract::DocKind::Pdf, "封面\n\u{c}本页讨论流速与 Flow Meter。\n结论：流速偏低\u{c}", None);
        add(&slides, crate::extract::DocKind::Pptx, "目标\n\u{c}流速试验方案\n\u{c}", None);
        add(&sheet, crate::extract::DocKind::Xlsx, "【数据】\n姓名\t编号\n流速\t0.5\n", None);
        add(&scanned, crate::extract::DocKind::Pdf, "  \u{c} ", None);
        let result = search_root(&root, "流速", SearchMode::All, &docs, true);
        let find = |name: &str| result.files.iter().find(|file| file.name == name).unwrap();
        let pages: Vec<&str> = find("报告.pdf").matches.iter().map(|item| item.locator.as_str()).collect();
        assert_eq!(pages, vec!["第 2 页", "第 2 页"]);
        assert_eq!(find("报告.pdf").matches[0].before, "本页讨论");
        assert_eq!(find("报告.pdf").matches[0].after, "与 Flow Meter。");
        assert_eq!(find("汇报.pptx").matches[0].locator, "第 2 张");
        assert_eq!(find("数据.xlsx").matches[0].locator, "第 3 行");
        // 大小写不敏感：搜 flow meter 命中原文 Flow Meter，命中片段保持原文大小写。
        let english = search_root(&root, "flow METER", SearchMode::Text, &docs, false);
        assert_eq!(english.files.len(), 1);
        assert_eq!(english.files[0].matches[0].hit, "Flow Meter");
        // 覆盖情况：5 个文档里 4 个已索引，扫描件没有文字，docx 尚未索引。
        assert_eq!(result.docs.total, 5);
        assert_eq!(result.docs.indexed, 4);
        assert_eq!(result.docs.no_text, 1);
        assert!(result.docs.running);
        // 只搜文件名时不统计正文索引，也不读取正文。
        let names = search_root(&root, "流速", SearchMode::Names, &docs, false);
        assert!(names.files.is_empty());
        assert_eq!(names.docs.total, 0);
        let _ = fs::remove_dir_all(&root);
    }

    /// 手动验证真实工作区的索引与搜索耗时：
    /// `DOCUMENTCRAFT_WORKSPACE=文件夹 DOCUMENTCRAFT_QUERY=关键词 cargo test real_workspace -- --ignored --nocapture`。
    #[test]
    #[ignore]
    fn real_workspace_index_and_search() {
        let workspace = std::env::var("DOCUMENTCRAFT_WORKSPACE").expect("需要设置 DOCUMENTCRAFT_WORKSPACE");
        let query = std::env::var("DOCUMENTCRAFT_QUERY").expect("需要设置 DOCUMENTCRAFT_QUERY");
        let root = PathBuf::from(&workspace);
        let cache_root = std::env::temp_dir().join(format!("documentcraft-real-cache-{}", std::process::id()));
        let mut files = Vec::new();
        collect_files(&root, 0, &mut files);
        let index = SearchIndex::default();
        let last = std::sync::Mutex::new(String::new());
        let report = |progress: IndexProgress| {
            *last.lock().unwrap() = format!("{}/{}，失败 {}", progress.done, progress.total, progress.failed);
        };
        let started = std::time::Instant::now();
        index.run(&workspace, &files, &cache_root, &report);
        println!("首次建立索引：{:?}（{}）", started.elapsed(), last.lock().unwrap());
        let started = std::time::Instant::now();
        index.run(&workspace, &files, &cache_root, &report);
        println!("二次更新（全部命中内存）：{:?}", started.elapsed());
        let restarted = SearchIndex::default();
        let started = std::time::Instant::now();
        restarted.run(&workspace, &files, &cache_root, &report);
        println!("重启后从缓存恢复：{:?}", started.elapsed());
        let (docs, _) = restarted.snapshot(&workspace);
        let memory: usize = docs.values().map(|entry| entry.text.len() + entry.lower.len()).sum();
        println!("内存中文本约 {} MB，文档 {} 个", memory / 1024 / 1024, docs.len());
        let started = std::time::Instant::now();
        let result = search_root(&root, &query, SearchMode::All, &docs, false);
        let matches: usize = result.files.iter().map(|file| file.matches.len()).sum();
        println!("搜索「{query}」：{:?}，{} 个文件 {} 处匹配，{} 个文件含文档命中", started.elapsed(), result.files.len(), matches, result.files.iter().filter(|file| file.matches.iter().any(|item| item.line == 0)).count());
        for file in result.files.iter().filter(|file| file.matches.iter().any(|item| item.line == 0)).take(3) {
            let first = &file.matches[0];
            println!("  {} · {} · {}{}{}", file.name, first.locator, first.before, first.hit, first.after);
        }
        println!("覆盖：共 {} 个文档，已索引 {}，失败 {}，无文字 {}", result.docs.total, result.docs.indexed, result.docs.failed, result.docs.no_text);
        let _ = fs::remove_dir_all(&cache_root);
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
