//! 工作区目录树与 Markdown 文件读写。

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use crate::extract::{decode_text_bytes, is_text_file, MAX_TEXT_FILE_BYTES, PAGE_BREAK};
use crate::textindex::{fold_text, indexable, DocEntry, FileRec, IndexProgress, ScanResult, SearchIndex};

/// 单个目录最多列出的条目数，防止误选磁盘根目录时界面卡死。
const MAX_ENTRIES_PER_DIR: usize = 2000;
/// 目录树最大深度。
const MAX_DEPTH: usize = 16;
const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];

/// 一次性读取整棵目录树的预算：条目数和时间任一用完就放弃，改用按需加载。
/// 本地的普通工作区远低于这个预算，行为不变；网络共享上的大文件夹会超出。
const TREE_BUDGET_ENTRIES: usize = 4000;
const TREE_BUDGET_SECONDS: u64 = 2;

#[derive(Serialize)]
pub struct TreeNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<TreeNode>,
    /// 子项是否已读取。按需加载时，没展开过的文件夹为 false，展开时用 list_dir 读取。
    loaded: bool,
    /// 文件夹的条目超过单目录上限，只列出了前一部分。
    truncated: bool,
    /// 目录树以按需加载模式返回（只对根节点有意义）：只读了顶层，不含 Markdown 的文件夹也会显示。
    lazy: bool,
    /// 最后修改时间（毫秒时间戳），读不到时为 0。供前端按修改时间排序。
    modified: u64,
}

impl TreeNode {
    fn directory(path: &Path) -> TreeNode {
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        TreeNode {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir: true,
            children: Vec::new(),
            loaded: false,
            truncated: false,
            lazy: false,
            modified: 0,
        }
    }

    fn file(name: String, path: &Path, modified: u64) -> TreeNode {
        TreeNode {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir: false,
            children: Vec::new(),
            loaded: true,
            truncated: false,
            lazy: false,
            modified,
        }
    }
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
pub(crate) fn is_ordinary(metadata: &fs::Metadata) -> bool {
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

/// 读取目录树的预算。网络共享上每读一个目录都有往返延迟，大文件夹读完要几分钟，
/// 所以超出预算就放弃整棵树的读取，调用方改用按需加载。
struct Budget {
    entries_left: usize,
    deadline: Instant,
    exceeded: bool,
}

impl Budget {
    fn new(entries: usize, seconds: u64) -> Budget {
        Budget { entries_left: entries, deadline: Instant::now() + Duration::from_secs(seconds), exceeded: false }
    }

    /// 记一条读取；预算用完后返回 false。
    fn spend(&mut self) -> bool {
        if self.exceeded {
            return false;
        }
        self.entries_left = self.entries_left.saturating_sub(1);
        if self.entries_left == 0 || Instant::now() >= self.deadline {
            self.exceeded = true;
        }
        !self.exceeded
    }
}

/// 读取目录下的一层子项，不递归。文件夹原样列出（子项未读取），文件按 show_all 与 Markdown 规则过滤。
/// 逐项用 `DirEntry::metadata`：Windows 上它直接取目录枚举时带回的属性，不需要再访问一次文件系统，
/// 在网络共享上比逐个 `symlink_metadata` 快得多。
fn read_level(path: &Path, show_all: bool) -> Result<TreeNode, String> {
    let entries = fs::read_dir(path).map_err(|error| format!("无法读取 {}：{error}", path.to_string_lossy()))?;
    let mut node = TreeNode::directory(path);
    let mut directories = Vec::new();
    let mut files = Vec::new();
    for (index, entry) in entries.flatten().enumerate() {
        if index >= MAX_ENTRIES_PER_DIR {
            node.truncated = true;
            break;
        }
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        // 隐藏目录（含 .documentcraft 批注库、.git）不进入目录树。
        if entry_name.starts_with('.') {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !is_ordinary(&metadata) {
            continue;
        }
        let entry_path = entry.path();
        if metadata.is_dir() {
            let mut directory = TreeNode::directory(&entry_path);
            directory.modified = modified_millis(&metadata);
            directories.push(directory);
        } else if show_all || is_markdown(&entry_path) {
            files.push(TreeNode::file(entry_name, &entry_path, modified_millis(&metadata)));
        }
    }
    directories.sort_by_key(|item| item.name.to_lowercase());
    files.sort_by_key(|item| item.name.to_lowercase());
    node.children.extend(directories);
    node.children.extend(files);
    node.loaded = true;
    Ok(node)
}

/// 递归读取整棵子树，只保留含 Markdown 的文件夹（`show_all` 时全部保留）。预算用完返回 None。
fn read_dir_node(path: &Path, depth: usize, show_all: bool, budget: &mut Budget) -> Option<TreeNode> {
    if budget.exceeded {
        return None;
    }
    let mut node = TreeNode::directory(path);
    if depth >= MAX_DEPTH {
        return Some(node);
    }
    let entries = fs::read_dir(path).ok()?;
    let mut directories = Vec::new();
    let mut files = Vec::new();
    for (index, entry) in entries.flatten().enumerate() {
        if index >= MAX_ENTRIES_PER_DIR {
            node.truncated = true;
            break;
        }
        if !budget.spend() {
            return None;
        }
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        if entry_name.starts_with('.') {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !is_ordinary(&metadata) {
            continue;
        }
        let entry_path = entry.path();
        if metadata.is_dir() {
            if let Some(mut child) = read_dir_node(&entry_path, depth + 1, show_all, budget) {
                child.modified = modified_millis(&metadata);
                // 默认只保留包含 Markdown 的目录，目录树聚焦于可阅读的文档。完全空的目录也保留，
                // 否则刚新建的文件夹会立刻从目录树消失；显示全部文件时所有目录都保留。
                if show_all || !child.children.is_empty() || is_empty_dir(&entry_path) {
                    directories.push(child);
                }
            } else if budget.exceeded {
                return None;
            }
        } else if show_all || is_markdown(&entry_path) {
            files.push(TreeNode::file(entry_name, &entry_path, modified_millis(&metadata)));
        }
    }
    directories.sort_by_key(|item| item.name.to_lowercase());
    files.sort_by_key(|item| item.name.to_lowercase());
    node.children.extend(directories);
    node.children.extend(files);
    node.loaded = depth < MAX_DEPTH;
    Some(node)
}

/// 列出工作区目录树。预算内能读完时，默认只包含 Markdown 文件和含 Markdown 的目录（`show_all` 为真时
/// 列出全部文件和目录）；工作区很大、超出预算时改为按需加载，只返回顶层，`lazy` 为真。
#[tauri::command]
pub async fn list_tree(root: String, show_all: Option<bool>) -> Result<TreeNode, String> {
    let show_all = show_all.unwrap_or(false);
    let task = tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&root);
        if !path.is_dir() {
            return Err(format!("工作区不是文件夹：{root}"));
        }
        let mut budget = Budget::new(TREE_BUDGET_ENTRIES, TREE_BUDGET_SECONDS);
        if let Some(tree) = read_dir_node(&path, 0, show_all, &mut budget) {
            return Ok(tree);
        }
        let mut top = read_level(&path, show_all)?;
        top.lazy = true;
        Ok(top)
    });
    task.await.map_err(|error| error.to_string())?
}

/// 读取一个文件夹的直接子项，供按需加载模式展开文件夹时使用。
#[tauri::command]
pub async fn list_dir(path: String, show_all: Option<bool>) -> Result<TreeNode, String> {
    let show_all = show_all.unwrap_or(false);
    let task = tauri::async_runtime::spawn_blocking(move || {
        let directory = PathBuf::from(&path);
        if !directory.is_dir() {
            return Err(format!("不是文件夹：{path}"));
        }
        read_level(&directory, show_all)
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

/// 返回的匹配总数和单文件匹配数。
const MAX_SEARCH_MATCHES: usize = 500;
const MAX_MATCHES_PER_FILE: usize = 50;
/// 匹配前后保留的上下文字符数。
const SNIPPET_BEFORE: usize = 30;
const SNIPPET_AFTER: usize = 60;
/// 在文档正文中截取上下文时，向命中位置前后查找行边界的最大字节数。中文每字 3 字节，
/// 60 个字符约 180 字节，留有余量；限制窗口是为了避免 PDF 中的超长行拖慢截取。
const SNIPPET_WINDOW_BYTES: usize = 240;
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

/// PPTX 命中页的原始标识和显示信息。UI 可直接传页码和 ID，无需解析 locator。
#[derive(Serialize)]
struct SearchSlide {
    number: usize,
    id: u32,
    title: Option<String>,
}

#[derive(Serialize)]
pub struct SearchMatch {
    /// 从 1 起的行号。文档类结果为 0，位置见 locator。
    line: usize,
    /// 该匹配是文件中第几处（从 0 起），供前端在排版后的正文中定位。
    occurrence: usize,
    /// 位置说明：纯文本是行号，文档是「第 N 页」「第 N 段」等。
    locator: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    slide: Option<SearchSlide>,
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
    /// 索引正在后台建立（含扫描文件夹的阶段）。
    running: bool,
    /// 工作区较大，没有自动建立索引，等用户手动触发。
    deferred: bool,
}

#[derive(Serialize)]
pub struct SearchResult {
    files: Vec<SearchFile>,
    /// 达到文件数或匹配总数上限，结果不完整。
    truncated: bool,
    /// 文件列表扫描被上限打断，列表之外的文件夹没有参与搜索；此时「没有匹配」不代表文件不存在。
    scan_incomplete: bool,
    docs: DocStats,
    /// 现场遍历超时，需要先在后台扫描文件夹；本次没有搜索结果。
    needs_scan: bool,
    /// 使用的是大工作区缓存的文件列表。
    large: bool,
    /// 参与搜索的文件总数。
    file_count: usize,
    /// 使用缓存文件列表时，这份列表是多少秒前扫描的；现场遍历时为 0。
    scan_age_seconds: u64,
}

impl SearchResult {
    fn empty() -> SearchResult {
        SearchResult { files: Vec::new(), truncated: false, scan_incomplete: false, docs: DocStats::default(), needs_scan: false, large: false, file_count: 0, scan_age_seconds: 0 }
    }
}

type DocIndex = HashMap<String, Arc<DocEntry>>;

/// 一次搜索用到的索引与工作区状态。
struct SearchContext<'a> {
    docs: &'a DocIndex,
    /// 索引正在后台建立。
    indexing: bool,
    /// 大工作区没有自动建立索引，等用户手动触发。
    deferred: bool,
    /// 大工作区：Markdown 正文来自索引，不在搜索时现场读取；其他纯文本只能按文件名搜索。
    large: bool,
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

/// 一次扫描最多收集的文件数。网络共享上的大工作区可能有几十万个文件，超出后列表标记为不完整。
/// 扫描按文件夹名排序深度优先，到达上限后其后的文件夹整个没有进列表，所以上限要高于常见的大共享
/// （曾为 30 万，在 30 万以上的共享里搜不到靠后文件夹中的文件）。每条记录约 150 字节，100 万条约 150 MB。
const MAX_SCAN_FILES: usize = 1_000_000;
/// 扫描时单个文件夹最多读取的条目数。目录树为了显示速度限制为 `MAX_ENTRIES_PER_DIR`，
/// 但搜索不能因此丢文件：超过这个数才放弃，并把列表标记为不完整。
const MAX_SCAN_ENTRIES_PER_DIR: usize = 200_000;
/// 搜索时现场遍历文件夹的时间上限。超出就认为工作区较大，改为后台扫描并缓存文件列表。
const LIVE_WALK_SECONDS: u64 = 2;
/// 判定为大工作区的条件：文件数超过阈值、扫描耗时超过阈值，或位于网络路径（`\\服务器\共享`）。
const LARGE_FILE_COUNT: usize = 20_000;
const LARGE_SCAN_SECONDS: u64 = 3;
/// 大工作区的文件列表缓存这么久之后才重新扫描。
const LARGE_RESCAN_SECONDS: u64 = 30 * 60;

struct WalkOutcome {
    files: Vec<FileRec>,
    /// 完整走完。被时间或文件数上限打断时为 false。
    complete: bool,
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 收集工作区内的全部文件，规则与目录树一致：跳过隐藏文件和目录、链接和目录联接。
/// 文件大小和修改时间取自目录枚举（`DirEntry::metadata`），不为每个文件再访问一次文件系统。
/// `deadline` 到期或文件数达到 `max_files` 时提前结束；`on_progress` 每发现 500 个文件调用一次。
fn walk_files(root: &Path, max_files: usize, deadline: Option<Instant>, on_progress: &dyn Fn(usize)) -> WalkOutcome {
    let mut files = Vec::new();
    let mut complete = true;
    walk_directory(root, 0, max_files, deadline, on_progress, &mut files, &mut complete);
    WalkOutcome { files, complete }
}

fn walk_directory(
    path: &Path,
    depth: usize,
    max_files: usize,
    deadline: Option<Instant>,
    on_progress: &dyn Fn(usize),
    files: &mut Vec<FileRec>,
    complete: &mut bool,
) {
    if !*complete || depth >= MAX_DEPTH {
        return;
    }
    if files.len() >= max_files || deadline.is_some_and(|limit| Instant::now() >= limit) {
        *complete = false;
        return;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    let mut children: Vec<(PathBuf, fs::Metadata)> = Vec::new();
    for (index, entry) in entries.flatten().enumerate() {
        if index >= MAX_SCAN_ENTRIES_PER_DIR {
            // 单个文件夹条目多到读不完：后面的文件搜不到，必须让界面知道列表不完整。
            *complete = false;
            break;
        }
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        if entry_name.starts_with('.') {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !is_ordinary(&metadata) {
            continue;
        }
        children.push((entry.path(), metadata));
    }
    children.sort_by_key(|(child, _)| child.to_string_lossy().to_lowercase());
    for (child, metadata) in children {
        if metadata.is_dir() {
            walk_directory(&child, depth + 1, max_files, deadline, on_progress, files, complete);
            if !*complete {
                return;
            }
            continue;
        }
        files.push(FileRec { path: child, size: metadata.len(), mtime: modified_millis(&metadata) });
        if files.len() % 500 == 0 {
            on_progress(files.len());
        }
        if files.len() >= max_files {
            *complete = false;
            return;
        }
    }
}

/// 读取纯文本文件的内容，自动识别 UTF-8、GBK 等编码。过大或编码无法识别时返回 None，此时该文件只能按文件名匹配。
fn read_searchable_text(path: &Path) -> Option<String> {
    if !is_text_file(path) {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    decode_text_bytes(&bytes)
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
        let slide = entry.slides.get(pages).map(|source| SearchSlide {
            number: pages + 1,
            id: source.id,
            title: source.title.clone(),
        });
        matches.push(SearchMatch {
            line: 0,
            occurrence,
            locator: entry.kind.locator(newlines, pages),
            slide,
            before,
            hit,
            after,
        });
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
            matches.push(SearchMatch {
                line: index + 1,
                occurrence,
                locator: (index + 1).to_string(),
                slide: None,
                before,
                hit,
                after,
            });
            occurrence += 1;
        }
        if more {
            break;
        }
    }
    (matches, more)
}

fn search_file(path: &Path, needle: &[char], folded: &str, mode: SearchMode, context: &SearchContext, budget: usize) -> Option<SearchFile> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let name_match = mode.matches_names() && !find_all(&lower_chars(&name), needle).is_empty();
    let mut matches = Vec::new();
    let mut more = false;
    if mode.matches_content() {
        let key = path.to_string_lossy();
        if let Some(entry) = context.docs.get(key.as_ref()) {
            (matches, more) = search_document(entry, folded, budget);
        } else if !context.large {
            if let Some(text) = read_searchable_text(path) {
                (matches, more) = search_plain_text(&text, needle, budget);
            }
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
fn document_stats(files: &[FileRec], context: &SearchContext) -> DocStats {
    let mut stats = DocStats { running: context.indexing, deferred: context.deferred, ..DocStats::default() };
    for rec in files {
        if indexable(rec, context.large).is_none() {
            continue;
        }
        stats.total += 1;
        let key = rec.path.to_string_lossy();
        if let Some(entry) = context.docs.get(key.as_ref()) {
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

/// 在给定的文件列表中搜索。
fn search_files(files: &[FileRec], query: &str, mode: SearchMode, context: &SearchContext) -> SearchResult {
    let trimmed = query.trim();
    let needle = lower_chars(trimmed);
    let folded = fold_text(trimmed);
    let mut truncated = false;
    let mut found = Vec::new();
    let mut total = 0;
    for rec in files {
        if total >= MAX_SEARCH_MATCHES {
            truncated = true;
            break;
        }
        if let Some(file) = search_file(&rec.path, &needle, &folded, mode, context, MAX_SEARCH_MATCHES - total) {
            total += file.matches.len();
            found.push(file);
        }
    }
    let stats = if mode.matches_content() { document_stats(files, context) } else { DocStats::default() };
    SearchResult { files: found, truncated, scan_incomplete: false, docs: stats, needs_scan: false, large: context.large, file_count: files.len(), scan_age_seconds: 0 }
}

/// 现场遍历工作区后搜索，仅供测试使用；正式路径见 `search_workspace`。
#[cfg(test)]
fn search_root(root: &Path, query: &str, mode: SearchMode, docs: &DocIndex, indexing: bool) -> SearchResult {
    let walked = walk_files(root, MAX_SCAN_FILES, None, &|_| {});
    search_files(&walked.files, query, mode, &SearchContext { docs, indexing, deferred: false, large: false })
}

/// 在工作区中搜索，不区分大小写，结果按文件路径排序。mode 取 `all`（文件名 + 正文）、
/// `names`（只搜文件名，含全部文件类型）、`text`（只搜正文）。正文包括纯文本文件和已建立索引的
/// Word、Excel、PowerPoint、PDF；索引未完成时只覆盖已索引的部分，进度见返回值的 docs。
///
/// 小工作区每次现场遍历；大工作区（网络共享、文件很多）使用后台扫描缓存的文件列表。现场遍历超过
/// 时间上限时返回 `needs_scan`，前端据此启动后台扫描，扫描完成后再搜索。
#[tauri::command]
pub async fn search_workspace(
    index: tauri::State<'_, Arc<SearchIndex>>,
    root: String,
    query: String,
    mode: String,
) -> Result<SearchResult, String> {
    let mode = SearchMode::parse(&mode)?;
    if query.trim().is_empty() {
        return Ok(SearchResult::empty());
    }
    let scan = index.scan_snapshot(&root);
    let (docs, indexing) = index.snapshot(&root);
    let deferred = index.is_deferred(&root);
    let task = tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&root);
        if !path.is_dir() {
            return Err(format!("工作区不是文件夹：{root}"));
        }
        if let Some(cached) = scan.as_ref().filter(|cached| cached.large) {
            let context = SearchContext { docs: &docs, indexing, deferred, large: true };
            let mut result = search_files(&cached.files, &query, mode, &context);
            result.scan_incomplete = cached.truncated;
            result.scan_age_seconds = cached.scanned_at.elapsed().as_secs();
            return Ok(result);
        }
        let deadline = Instant::now() + Duration::from_secs(LIVE_WALK_SECONDS);
        let walked = walk_files(&path, MAX_SCAN_FILES, Some(deadline), &|_| {});
        if !walked.complete {
            return Ok(SearchResult { needs_scan: true, ..SearchResult::empty() });
        }
        let context = SearchContext { docs: &docs, indexing, deferred, large: false };
        Ok(search_files(&walked.files, &query, mode, &context))
    });
    task.await.map_err(|error| error.to_string())?
}

fn scan_progress(root: &str, found: usize, running: bool) -> IndexProgress {
    IndexProgress { root: root.to_string(), phase: "scan", done: found, total: 0, failed: 0, running }
}

/// 取工作区的文件列表：大工作区的缓存在有效期内直接复用（`refresh` 为真时强制重新扫描），否则重新扫描并报告进度。
fn ensure_scan(index: &SearchIndex, root: &str, path: &Path, refresh: bool, report: &(dyn Fn(IndexProgress) + Sync)) -> Arc<ScanResult> {
    if let Some(existing) = index.scan_snapshot(root) {
        if !refresh && existing.large && existing.scanned_at.elapsed() < Duration::from_secs(LARGE_RESCAN_SECONDS) {
            return existing;
        }
    }
    let started = Instant::now();
    report(scan_progress(root, 0, true));
    let on_progress = |found: usize| report(scan_progress(root, found, true));
    let walked = walk_files(path, MAX_SCAN_FILES, None, &on_progress);
    let large = root.starts_with(r"\\") || walked.files.len() > LARGE_FILE_COUNT || started.elapsed() > Duration::from_secs(LARGE_SCAN_SECONDS);
    let found = walked.files.len();
    let scan = Arc::new(ScanResult { files: walked.files, scanned_at: Instant::now(), large, truncated: !walked.complete });
    index.store_scan(root, Arc::clone(&scan));
    report(scan_progress(root, found, false));
    scan
}

/// 在后台准备搜索：先扫描文件列表，再为 Word、Excel、PowerPoint、PDF 建立或增量更新正文索引。
/// 进度通过 `search-index` 事件发给前端（phase 为 scan 或 index）。已有任务在运行时直接返回。
///
/// 大工作区（网络共享、文件很多）读取全部文档代价很高，默认只扫描、不自动建立文档索引，记为「已推迟」；
/// 用户确认后以 `manual` 为真再调用才建立。
#[tauri::command]
pub async fn index_workspace(
    app: tauri::AppHandle,
    index: tauri::State<'_, Arc<SearchIndex>>,
    root: String,
    manual: Option<bool>,
    refresh: Option<bool>,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let manual = manual.unwrap_or(false);
    let refresh = refresh.unwrap_or(false);
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
        if !index.begin(&root) {
            return Ok(());
        }
        let emitter = app.clone();
        let report = move |progress: IndexProgress| {
            let _ = emitter.emit("search-index", progress);
        };
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let scan = ensure_scan(&index, &root, &path, refresh, &report);
            if scan.large && !manual {
                index.finish_deferred(&root, true);
                report(IndexProgress { root: root.clone(), phase: "index", done: 0, total: 0, failed: 0, running: false });
                return;
            }
            index.build(&root, &scan.files, scan.large, &cache_root, &report);
        }));
        if outcome.is_err() {
            index.abort(&root);
        }
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
        let tree = read_dir_node(&root, 0, false, &mut Budget::new(TREE_BUDGET_ENTRIES, TREE_BUDGET_SECONDS)).unwrap();
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
        let tree = read_dir_node(&root, 0, true, &mut Budget::new(TREE_BUDGET_ENTRIES, TREE_BUDGET_SECONDS)).unwrap();
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
            let entry = DocEntry { kind, lower: fold_text(text), text: text.to_string(), slides: Vec::new(), error: error.map(str::to_string) };
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
        let files = walk_files(&root, MAX_SCAN_FILES, None, &|_| {}).files;
        let index = SearchIndex::default();
        let last = std::sync::Mutex::new(String::new());
        let report = |progress: IndexProgress| {
            *last.lock().unwrap() = format!("{}/{}，失败 {}", progress.done, progress.total, progress.failed);
        };
        let started = std::time::Instant::now();
        index.run(&workspace, &files, false, &cache_root, &report);
        println!("首次建立索引：{:?}（{}）", started.elapsed(), last.lock().unwrap());
        let started = std::time::Instant::now();
        index.run(&workspace, &files, false, &cache_root, &report);
        println!("二次更新（全部命中内存）：{:?}", started.elapsed());
        let restarted = SearchIndex::default();
        let started = std::time::Instant::now();
        restarted.run(&workspace, &files, false, &cache_root, &report);
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

    /// 手动验证大工作区（如网络共享）的目录树打开耗时：
    /// `DOCUMENTCRAFT_WORKSPACE=文件夹 cargo test real_large_tree -- --ignored --nocapture`。
    #[test]
    #[ignore]
    fn real_large_tree_opens_quickly() {
        let workspace = std::env::var("DOCUMENTCRAFT_WORKSPACE").expect("需要设置 DOCUMENTCRAFT_WORKSPACE");
        let root = PathBuf::from(&workspace);
        let started = Instant::now();
        let mut budget = Budget::new(TREE_BUDGET_ENTRIES, TREE_BUDGET_SECONDS);
        let full = read_dir_node(&root, 0, false, &mut budget);
        println!("整树读取：{:?}，预算用尽 {}，得到完整树 {}", started.elapsed(), budget.exceeded, full.is_some());
        let started = Instant::now();
        let top = read_level(&root, false).unwrap();
        println!("顶层一层：{:?}，{} 项（文件夹 {}）", started.elapsed(), top.children.len(), top.children.iter().filter(|node| node.is_dir).count());
        if let Some(first) = top.children.iter().find(|node| node.is_dir) {
            let started = Instant::now();
            let level = read_level(Path::new(&first.path), false).unwrap();
            println!("展开「{}」：{:?}，{} 项，截断 {}", first.name, started.elapsed(), level.children.len(), level.truncated);
        }
        let started = Instant::now();
        let walked = walk_files(&root, MAX_SCAN_FILES, Some(Instant::now() + Duration::from_secs(60)), &|_| {});
        println!("60 秒内扫描文件列表：{:?}，发现 {} 个文件，是否走完 {}", started.elapsed(), walked.files.len(), walked.complete);
    }

    /// 手动验证大工作区的完整扫描与按文件名搜索（会完整遍历一遍，网络共享上需要几分钟）：
    /// `DOCUMENTCRAFT_WORKSPACE=文件夹 DOCUMENTCRAFT_QUERY=关键词 cargo test real_large_scan -- --ignored --nocapture`。
    #[test]
    #[ignore]
    fn real_large_scan_and_name_search() {
        let workspace = std::env::var("DOCUMENTCRAFT_WORKSPACE").expect("需要设置 DOCUMENTCRAFT_WORKSPACE");
        let query = std::env::var("DOCUMENTCRAFT_QUERY").expect("需要设置 DOCUMENTCRAFT_QUERY");
        let root = PathBuf::from(&workspace);
        let index = SearchIndex::default();
        let last = std::sync::Mutex::new(0usize);
        let report = |progress: IndexProgress| {
            *last.lock().unwrap() = progress.done;
        };
        let started = Instant::now();
        let scan = ensure_scan(&index, &workspace, &root, false, &report);
        println!("完整扫描：{:?}，{} 个文件，大工作区 {}，列表不完整 {}", started.elapsed(), scan.files.len(), scan.large, scan.truncated);
        let docs = scan.files.iter().filter(|rec| indexable(rec, false).is_some()).count();
        let texts = scan.files.iter().filter(|rec| indexable(rec, true).is_some()).count() - docs;
        println!("其中可建立正文索引的文档 {docs} 个，纯文本文件 {texts} 个");
        let empty: DocIndex = HashMap::new();
        let context = SearchContext { docs: &empty, indexing: false, deferred: true, large: true };
        let started = Instant::now();
        let names = search_files(&scan.files, &query, SearchMode::Names, &context);
        println!("按文件名搜索「{query}」：{:?}，{} 个文件", started.elapsed(), names.files.len());
        let started = Instant::now();
        let text = search_files(&scan.files, &query, SearchMode::Text, &context);
        println!("按正文搜索（未建索引）：{:?}，{} 个文件，覆盖 {}/{}", started.elapsed(), text.files.len(), text.docs.indexed, text.docs.total);
    }

    #[test]
    fn tree_switches_to_lazy_loading_when_the_budget_runs_out() {
        let root = scratch("lazy");
        for index in 0..6 {
            fs::write(root.join("子目录").join(format!("文件{index}.txt")), "x").unwrap();
        }
        fs::write(root.join("子目录").join("笔记.md"), "# 笔记\n").unwrap();
        fs::write(root.join("说明.txt"), "x").unwrap();

        // 预算够用：整棵树读完，只含 Markdown 的文件夹（不含 txt），所有文件夹都已读取。
        let mut enough = Budget::new(1000, 60);
        let full = read_dir_node(&root, 0, false, &mut enough).unwrap();
        assert!(!enough.exceeded && full.loaded && !full.lazy);

        // 预算太小：放弃整棵树，按需加载。只读一层，文件夹未读取，不含 Markdown 的文件夹也列出。
        let mut tiny = Budget::new(3, 60);
        assert!(read_dir_node(&root, 0, false, &mut tiny).is_none());
        assert!(tiny.exceeded);
        let top = read_level(&root, false).unwrap();
        let names: Vec<&str> = top.children.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(names, vec!["子目录"], "默认只显示 Markdown，txt 被过滤");
        assert!(top.loaded && !top.children[0].loaded && top.children[0].children.is_empty());
        let inner = read_level(&root.join("子目录"), false).unwrap();
        let inner_names: Vec<&str> = inner.children.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(inner_names, vec!["空目录", "笔记.md"]);
        assert!(inner.children.iter().find(|node| node.name == "空目录").is_some_and(|node| !node.loaded));
        let all = read_level(&root, true).unwrap();
        assert_eq!(all.children.iter().map(|node| node.name.as_str()).collect::<Vec<_>>(), vec!["子目录", "说明.txt"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_directory_with_too_many_entries_is_listed_partially_and_flagged() {
        let root = scratch("many");
        for index in 0..(MAX_ENTRIES_PER_DIR + 30) {
            fs::write(root.join(format!("n{index}.md")), "x").unwrap();
        }
        let level = read_level(&root, false).unwrap();
        assert!(level.truncated);
        assert!(level.children.len() <= MAX_ENTRIES_PER_DIR);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn file_walk_stops_at_the_cap_and_the_deadline() {
        let root = scratch("walk");
        for index in 0..5 {
            fs::write(root.join(format!("文件{index}.txt")), "x").unwrap();
        }
        let capped = walk_files(&root, 3, None, &|_| {});
        assert_eq!(capped.files.len(), 3);
        assert!(!capped.complete);
        let expired = walk_files(&root, 100, Some(Instant::now() - Duration::from_secs(1)), &|_| {});
        assert!(!expired.complete && expired.files.is_empty());
        let full = walk_files(&root, 100, None, &|_| {});
        assert!(full.complete);
        assert_eq!(full.files.len(), 5);
        assert!(full.files.iter().all(|rec| rec.size == 1));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn large_workspaces_search_markdown_through_the_index_instead_of_reading_files() {
        let root = scratch("largetext");
        let note = root.join("记录.md");
        let other = root.join("数据.txt");
        fs::write(&note, "第一行\n流速 0.5\n").unwrap();
        fs::write(&other, "流速").unwrap();
        let walked = walk_files(&root, MAX_SCAN_FILES, None, &|_| {}).files;
        let empty: DocIndex = HashMap::new();
        let large = SearchContext { docs: &empty, indexing: false, deferred: true, large: true };
        // 大工作区且没有索引：不现场读取文件，正文搜不到；统计里 Markdown 算「未索引」，其他纯文本不在索引范围。
        let unindexed = search_files(&walked, "流速", SearchMode::Text, &large);
        assert!(unindexed.files.is_empty());
        assert_eq!((unindexed.docs.total, unindexed.docs.indexed, unindexed.docs.deferred), (1, 0, true));
        // 小工作区仍然现场读取，Markdown 和 txt 都能搜到，总是最新。
        let small = SearchContext { docs: &empty, indexing: false, deferred: false, large: false };
        assert_eq!(search_files(&walked, "流速", SearchMode::Text, &small).files.len(), 2);
        assert_eq!(search_files(&walked, "流速", SearchMode::Text, &small).docs.total, 0);
        // 手动建立索引后，Markdown 从索引里查，位置按行；txt 仍然搜不到正文。
        let mut docs: DocIndex = HashMap::new();
        let text = "第一行\n流速 0.5\n";
        let entry = DocEntry { kind: crate::extract::DocKind::Text, lower: fold_text(text), text: text.to_string(), slides: Vec::new(), error: None };
        docs.insert(note.to_string_lossy().into_owned(), Arc::new(entry));
        let indexed_context = SearchContext { docs: &docs, indexing: false, deferred: false, large: true };
        let found = search_files(&walked, "流速", SearchMode::Text, &indexed_context);
        assert_eq!(found.files.len(), 1);
        assert_eq!(found.files[0].matches[0].locator, "第 2 行");
        assert_eq!((found.docs.total, found.docs.indexed), (1, 1));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn network_workspaces_are_large_and_their_scan_is_cached() {
        let root = scratch("scan");
        fs::write(root.join("a.docx"), "x").unwrap();
        let index = SearchIndex::default();
        let report = |_: IndexProgress| {};
        // 网络路径（以两个反斜杠开头）直接视为大工作区；缓存有效期内复用同一份扫描结果。
        let network = r"\\服务器\共享\科研部";
        let first = ensure_scan(&index, network, &root, false, &report);
        assert!(first.large && first.files.len() == 1);
        let second = ensure_scan(&index, network, &root, false, &report);
        assert!(Arc::ptr_eq(&first, &second));
        // 本地的小工作区每次都重新扫描，改动立即可见。
        let local = root.to_string_lossy().into_owned();
        let scanned = ensure_scan(&index, &local, &root, false, &report);
        assert!(!scanned.large);
        fs::write(root.join("b.docx"), "x").unwrap();
        assert_eq!(ensure_scan(&index, &local, &root, false, &report).files.len(), 2);
        // 大工作区不自动建立文档索引：记为推迟，手动建立后清除。
        assert!(index.begin(network));
        index.finish_deferred(network, true);
        assert!(index.is_deferred(network));
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
