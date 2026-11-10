//! 文档正文索引：为工作区里的 Word、Excel、PowerPoint、PDF 建立文本缓存，供搜索按正文检索。
//!
//! 做法参照桌面全文搜索工具：首次在后台解析全部文档，之后只处理新增和修改过的文件。
//! - 缓存文件保存在应用数据目录（不写入用户的工作区，工作区常在云盘或版本库里），
//!   每个文档一个 JSON，记录路径、修改时间、大小和提取出的文本；修改时间或大小变化即视为过期。
//! - 内存中保留一份索引供搜索使用。搜索时索引可能还在建立，结果只覆盖已索引的文档，并报告进度。
//! - 解析失败（加密、损坏）和扫描件（没有文字层）也会记入缓存，避免每次都重新尝试。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use crate::extract::{doc_kind, extract_text, DocKind, MAX_DOCUMENT_BYTES};

/// 解析文档时最多同时使用的线程数。
const MAX_WORKERS: usize = 4;

/// 一个已索引的文档。`lower` 是 `text` 逐字符折叠大小写后的副本，两者字节长度一致，
/// 便于在 `lower` 中查找后直接按同一偏移从 `text` 截取原文。
pub struct DocEntry {
    pub kind: DocKind,
    pub text: String,
    pub lower: String,
    /// 解析失败的原因；成功时为 None。
    pub error: Option<String>,
}

impl DocEntry {
    fn new(kind: DocKind, text: String, error: Option<String>) -> DocEntry {
        let lower = fold_text(&text);
        DocEntry { kind, text, lower, error }
    }
}

/// 折叠单个字符的大小写。只在折叠后仍是单个字符且 UTF-8 长度不变时才替换，保证字节偏移一致。
fn fold_char(character: char) -> char {
    let mut lowered = character.to_lowercase();
    match (lowered.next(), lowered.next()) {
        (Some(single), None) if single.len_utf8() == character.len_utf8() => single,
        _ => character,
    }
}

/// 折叠大小写，输出与输入字节长度相同。搜索词用同一函数处理后再匹配。
pub fn fold_text(text: &str) -> String {
    text.chars().map(fold_char).collect()
}

/// 缓存文件的内容。
#[derive(Serialize, Deserialize)]
struct CacheFile {
    path: String,
    mtime: u64,
    size: u64,
    text: String,
    error: Option<String>,
}

/// 一个可索引文档的文件信息。
pub struct Indexable {
    pub kind: DocKind,
    pub size: u64,
    /// 修改时间（毫秒）。
    pub mtime: u64,
}

/// 判断文件是否参与正文索引：支持的类型、不是 Office 的 `~$` 锁文件、大小在上限内。
pub fn indexable(path: &Path) -> Option<Indexable> {
    let kind = doc_kind(path)?;
    let name = path.file_name()?.to_string_lossy();
    if name.starts_with("~$") {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return None;
    }
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    Some(Indexable { kind, size: metadata.len(), mtime })
}

/// FNV-1a 64 位哈希。缓存目录和文件名依赖它，必须跨版本稳定，所以不用标准库的 DefaultHasher。
fn stable_hash(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn root_key(root: &str) -> String {
    root.to_lowercase()
}

fn cache_name(path: &str) -> String {
    format!("{:016x}.json", stable_hash(&path.to_lowercase()))
}

/// 索引进度，通过事件发给前端。
#[derive(Clone, Serialize)]
pub struct IndexProgress {
    pub root: String,
    pub done: usize,
    pub total: usize,
    pub failed: usize,
    pub running: bool,
}

struct StoredEntry {
    mtime: u64,
    size: u64,
    entry: Arc<DocEntry>,
}

#[derive(Default)]
struct RootState {
    entries: HashMap<String, StoredEntry>,
    running: bool,
}

/// 全部工作区的内存索引，作为 Tauri 托管状态使用。
#[derive(Default)]
pub struct SearchIndex {
    roots: Mutex<HashMap<String, RootState>>,
}

impl SearchIndex {
    /// 取当前索引快照和是否正在建立。快照只复制指针，搜索期间不阻塞索引。
    pub fn snapshot(&self, root: &str) -> (HashMap<String, Arc<DocEntry>>, bool) {
        let roots = self.roots.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match roots.get(&root_key(root)) {
            Some(state) => {
                let entries = state.entries.iter().map(|(path, stored)| (path.clone(), Arc::clone(&stored.entry))).collect();
                (entries, state.running)
            }
            None => (HashMap::new(), false),
        }
    }

    /// 标记开始建立索引。已有任务在运行时返回 false。
    fn begin(&self, root: &str) -> bool {
        let mut roots = self.roots.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = roots.entry(root_key(root)).or_default();
        if state.running {
            return false;
        }
        state.running = true;
        true
    }

    fn previous(&self, root: &str) -> HashMap<String, (u64, u64, Arc<DocEntry>)> {
        let roots = self.roots.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match roots.get(&root_key(root)) {
            Some(state) => state
                .entries
                .iter()
                .map(|(path, stored)| (path.clone(), (stored.mtime, stored.size, Arc::clone(&stored.entry))))
                .collect(),
            None => HashMap::new(),
        }
    }

    fn finish(&self, root: &str, entries: HashMap<String, StoredEntry>) {
        let mut roots = self.roots.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = roots.entry(root_key(root)).or_default();
        state.entries = entries;
        state.running = false;
    }

    /// 异常退出时释放运行标记，避免之后再也无法建立索引。
    fn abort(&self, root: &str) {
        let mut roots = self.roots.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(state) = roots.get_mut(&root_key(root)) {
            state.running = false;
        }
    }

    /// 建立或增量更新工作区的文档索引。返回 false 表示已有任务在运行，本次未执行。
    /// `files` 是工作区内的全部文件；`cache_root` 是缓存根目录；`report` 接收进度。
    pub fn run(&self, root: &str, files: &[PathBuf], cache_root: &Path, report: &(dyn Fn(IndexProgress) + Sync)) -> bool {
        if !self.begin(root) {
            return false;
        }
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.build(root, files, cache_root, report)));
        if outcome.is_err() {
            self.abort(root);
        }
        true
    }

    fn build(&self, root: &str, files: &[PathBuf], cache_root: &Path, report: &(dyn Fn(IndexProgress) + Sync)) {
        let documents: Vec<(PathBuf, Indexable)> = files
            .iter()
            .filter_map(|path| indexable(path).map(|info| (path.clone(), info)))
            .collect();
        let total = documents.len();
        let progress = |done: usize, failed: usize, running: bool| IndexProgress { root: root.to_string(), done, total, failed, running };
        report(progress(0, 0, true));

        let cache_dir = cache_root.join(format!("{:016x}", stable_hash(&root_key(root))));
        let _ = fs::create_dir_all(&cache_dir);
        let previous = self.previous(root);
        let next = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);
        let failed = AtomicUsize::new(0);
        let fresh: Mutex<HashMap<String, StoredEntry>> = Mutex::new(HashMap::new());
        let workers = std::thread::available_parallelism().map(|count| count.get()).unwrap_or(2).clamp(1, MAX_WORKERS);

        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| loop {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    if index >= documents.len() {
                        break;
                    }
                    let (path, info) = &documents[index];
                    let key = path.to_string_lossy().into_owned();
                    let entry = load_entry(&key, path, info, &previous, &cache_dir);
                    if entry.error.is_some() {
                        failed.fetch_add(1, Ordering::SeqCst);
                    }
                    fresh
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .insert(key, StoredEntry { mtime: info.mtime, size: info.size, entry });
                    let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
                    if finished % 4 == 0 || finished == total {
                        report(progress(finished, failed.load(Ordering::SeqCst), finished < total));
                    }
                });
            }
        });

        let entries = fresh.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner());
        remove_stale_cache(&cache_dir, &entries);
        self.finish(root, entries);
        report(progress(total, failed.load(Ordering::SeqCst), false));
    }
}

/// 取得一个文档的索引项：内存中未过期的直接复用，其次读缓存，最后才解析原文件。
fn load_entry(
    key: &str,
    path: &Path,
    info: &Indexable,
    previous: &HashMap<String, (u64, u64, Arc<DocEntry>)>,
    cache_dir: &Path,
) -> Arc<DocEntry> {
    if let Some((mtime, size, entry)) = previous.get(key) {
        if *mtime == info.mtime && *size == info.size {
            return Arc::clone(entry);
        }
    }
    let cache_path = cache_dir.join(cache_name(key));
    if let Some(cached) = read_cache(&cache_path) {
        if cached.path.eq_ignore_ascii_case(key) && cached.mtime == info.mtime && cached.size == info.size {
            return Arc::new(DocEntry::new(info.kind, cached.text, cached.error));
        }
    }
    let (text, error) = match extract_text(path) {
        Ok(text) => (text, None),
        Err(message) => (String::new(), Some(message)),
    };
    write_cache(&cache_path, &CacheFile { path: key.to_string(), mtime: info.mtime, size: info.size, text: text.clone(), error: error.clone() });
    Arc::new(DocEntry::new(info.kind, text, error))
}

fn read_cache(path: &Path) -> Option<CacheFile> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// 先写临时文件再改名，避免中途退出留下写了一半的缓存。缓存只是加速手段，写失败不影响搜索。
fn write_cache(path: &Path, cache: &CacheFile) {
    let Ok(bytes) = serde_json::to_vec(cache) else {
        return;
    };
    let staged = path.with_extension("tmp");
    if fs::write(&staged, bytes).is_err() {
        return;
    }
    if fs::rename(&staged, path).is_err() {
        let _ = fs::remove_file(&staged);
    }
}

/// 删除已不在工作区里的文档对应的缓存文件。
fn remove_stale_cache(cache_dir: &Path, entries: &HashMap<String, StoredEntry>) {
    let expected: HashSet<String> = entries.keys().map(|key| cache_name(key)).collect();
    let Ok(listing) = fs::read_dir(cache_dir) else {
        return;
    };
    for item in listing.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if !expected.contains(&name) {
            let _ = fs::remove_file(item.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::AtomicBool;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("documentcraft-idx-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_docx(path: &Path, paragraph: &str) {
        let document = format!(r#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>{paragraph}</w:t></w:r></w:p></w:body></w:document>"#);
        let mut writer = ZipWriter::new(fs::File::create(path).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file("word/document.xml", options).unwrap();
        writer.write_all(document.as_bytes()).unwrap();
        writer.finish().unwrap();
    }

    #[test]
    fn folding_keeps_byte_length_and_lowercases() {
        let text = "FLOW 流速 \u{212a}ELVIN İstanbul";
        let folded = fold_text(text);
        assert_eq!(folded.len(), text.len());
        assert!(folded.starts_with("flow 流速"));
    }

    #[test]
    fn indexes_incrementally_reuses_cache_and_cleans_up() {
        let workspace = scratch("ws");
        let cache_root = scratch("cache");
        let first = workspace.join("报告.docx");
        write_docx(&first, "流速 0.5 m/s");
        fs::write(workspace.join("~$报告.docx"), "lock").unwrap();
        fs::write(workspace.join("坏.docx"), "not a zip").unwrap();
        fs::write(workspace.join("说明.txt"), "x").unwrap();
        let files = vec![first.clone(), workspace.join("~$报告.docx"), workspace.join("坏.docx"), workspace.join("说明.txt")];
        let root = workspace.to_string_lossy().into_owned();
        let index = SearchIndex::default();
        let finished = AtomicBool::new(false);
        let report = |progress: IndexProgress| {
            if !progress.running {
                finished.store(true, Ordering::SeqCst);
            }
        };

        assert!(index.run(&root, &files, &cache_root, &report));
        assert!(finished.load(Ordering::SeqCst));
        let (entries, running) = index.snapshot(&root);
        assert!(!running);
        assert_eq!(entries.len(), 2, "锁文件和 txt 不入索引");
        let key = first.to_string_lossy().into_owned();
        assert_eq!(entries[&key].text, "流速 0.5 m/s\n");
        assert!(entries[&workspace.join("坏.docx").to_string_lossy().into_owned()].error.is_some());
        let cache_dir: Vec<_> = fs::read_dir(fs::read_dir(&cache_root).unwrap().next().unwrap().unwrap().path()).unwrap().collect();
        assert_eq!(cache_dir.len(), 2);

        // 重启后内存索引为空，从缓存恢复，不重新解析：把缓存里的文本改掉，若读到改后的文本就证明走了缓存。
        let cache_file = fs::read_dir(fs::read_dir(&cache_root).unwrap().next().unwrap().unwrap().path())
            .unwrap()
            .flatten()
            .map(|item| item.path())
            .find(|path| fs::read_to_string(path).unwrap().contains("流速"))
            .unwrap();
        let tampered = fs::read_to_string(&cache_file).unwrap().replace("流速 0.5", "缓存 0.5");
        fs::write(&cache_file, tampered).unwrap();
        let restarted = SearchIndex::default();
        assert!(restarted.run(&root, &files, &cache_root, &report));
        assert_eq!(restarted.snapshot(&root).0[&key].text, "缓存 0.5 m/s\n");

        // 文件修改后缓存过期，重新解析；删除文件后缓存清理。
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_docx(&first, "新的内容更长一些");
        assert!(restarted.run(&root, &files, &cache_root, &report));
        assert_eq!(restarted.snapshot(&root).0[&key].text, "新的内容更长一些\n");
        fs::remove_file(workspace.join("坏.docx")).unwrap();
        let remaining: Vec<PathBuf> = vec![first.clone()];
        assert!(restarted.run(&root, &remaining, &cache_root, &report));
        assert_eq!(restarted.snapshot(&root).0.len(), 1);
        let leftovers = fs::read_dir(fs::read_dir(&cache_root).unwrap().next().unwrap().unwrap().path()).unwrap().count();
        assert_eq!(leftovers, 1);
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&cache_root);
    }

    #[test]
    fn second_run_is_refused_while_running() {
        let index = SearchIndex::default();
        assert!(index.begin("D:\\工作区"));
        assert!(!index.begin("d:\\工作区"), "路径大小写不同也视为同一工作区");
        index.abort("D:\\工作区");
        assert!(index.begin("D:\\工作区"));
    }
}
