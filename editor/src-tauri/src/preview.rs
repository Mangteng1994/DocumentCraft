//! 搜索结果的预览（DC-066）：读取文件正文，列出关键词命中所在的行及其上下文，
//! 供编辑器中间区域显示「识别到了什么」。
//!
//! 正文沿用 `extract` 模块的提取结果（Markdown、txt 等纯文本，Word、Excel、PowerPoint、PDF），
//! 命中位置的页、段、行说明与搜索结果列表一致。同一行的多处命中合并成一个块，并给出命中文字在该行内的
//! 字符范围（按 Unicode 字符计数，前端用同样的方式切分高亮）。

use serde::Serialize;
use std::fs;
use std::path::Path;

use crate::extract::{doc_kind, extract_text, is_markdown_file, is_text_file, DocKind, PAGE_BREAK};
use crate::textindex::fold_text;

/// 最多返回的命中块数，更多的命中只计数。
const MAX_PREVIEW_BLOCKS: usize = 200;
/// 单行过长（如 PDF 的整页文字）时，只截取命中附近这么多字符，命中前最多保留 LINE_LEAD_CHARS 个字符。
const LINE_WINDOW_CHARS: usize = 400;
const LINE_LEAD_CHARS: usize = 120;
/// 上下文行最多显示的字符数，以及向上下查找非空行的最大行数。
const CONTEXT_CHARS: usize = 160;
const CONTEXT_LOOKAROUND: usize = 3;

/// 一个命中块：包含命中的一行（同一行的多处命中合并），加上前后各一行上下文。
#[derive(Serialize)]
pub struct PreviewBlock {
    /// 位置说明：「第 3 页」「第 12 段」「第 40 行」等。
    locator: String,
    /// Markdown 标题的级别（1～6），不是标题时为 0。标题行已去掉开头的 # 号。
    heading_level: usize,
    context_before: String,
    /// 命中所在的行（过长时只有命中附近的一段）。
    text: String,
    /// 命中文字在 text 中的范围：[起始字符序号, 字符数]。
    ranges: Vec<[usize; 2]>,
    /// text 的开头或结尾被截断，前端补省略号。
    cut_start: bool,
    cut_end: bool,
    context_after: String,
}

#[derive(Serialize)]
pub struct FilePreview {
    path: String,
    name: String,
    /// markdown、text、docx、xlsx、pptx、pdf 或 other。
    kind: String,
    size: u64,
    /// 关键词在文件名中的范围，范围与 PreviewBlock::ranges 相同。
    name_ranges: Vec<[usize; 2]>,
    blocks: Vec<PreviewBlock>,
    /// 正文中的命中总数（可能多于 blocks 中列出的）。
    total_hits: usize,
    truncated: bool,
    /// 无法显示正文的原因，例如类型不支持、没有文字层、解析失败。
    note: String,
}

/// 正文中的一行：字节范围，以及它之前的换行符和换页符个数（用于生成页、段、行说明）。
struct Line {
    start: usize,
    end: usize,
    newlines: usize,
    pages: usize,
}

fn kind_name(path: &Path) -> &'static str {
    if is_markdown_file(path) {
        return "markdown";
    }
    match doc_kind(path) {
        Some(DocKind::Docx) => "docx",
        Some(DocKind::Xlsx) => "xlsx",
        Some(DocKind::Pptx) => "pptx",
        Some(DocKind::Pdf) => "pdf",
        _ => {
            if is_text_file(path) {
                "text"
            } else {
                "other"
            }
        }
    }
}

/// 按换行符和换页符把正文切成行，同时累计页、段计数。
fn split_lines(text: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut newlines = 0;
    let mut pages = 0;
    for (index, character) in text.char_indices() {
        if character != '\n' && character != PAGE_BREAK {
            continue;
        }
        lines.push(Line { start, end: index, newlines, pages });
        start = index + character.len_utf8();
        if character == '\n' {
            newlines += 1;
        } else {
            pages += 1;
        }
    }
    lines.push(Line { start, end: text.len(), newlines, pages });
    lines
}

/// 识别 Markdown 标题行，返回（级别，需要去掉的前缀字符数）。「#」后必须跟空白才算标题。
fn heading_prefix(line: &str) -> Option<(usize, usize)> {
    let trimmed = line.trim_start();
    let leading = line.chars().count() - trimmed.chars().count();
    let hashes = trimmed.chars().take_while(|character| *character == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest: Vec<char> = trimmed.chars().skip(hashes).collect();
    match rest.first() {
        Some(character) if character.is_whitespace() => {}
        _ => return None,
    }
    let spaces = rest.iter().take_while(|character| character.is_whitespace()).count();
    Some((hashes, leading + hashes + spaces))
}

fn clip_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(limit).collect();
    clipped.push('…');
    clipped
}

/// 取命中行上方（step 为 -1）或下方（step 为 1）最近的一个非空行作为上下文。
fn nearby_context(text: &str, lines: &[Line], index: usize, step: isize) -> String {
    let mut cursor = index as isize;
    for _ in 0..CONTEXT_LOOKAROUND {
        cursor += step;
        if cursor < 0 || cursor as usize >= lines.len() {
            break;
        }
        let line = &lines[cursor as usize];
        let content = text[line.start..line.end].trim();
        if !content.is_empty() {
            return clip_chars(content, CONTEXT_CHARS);
        }
    }
    String::new()
}

/// 在已折叠大小写的文本中找 needle，返回每处命中的 [起始字符序号, 字符数]。
fn find_ranges(haystack: &str, needle: &str) -> Vec<[usize; 2]> {
    let length = needle.chars().count();
    haystack
        .match_indices(needle)
        .map(|(start, _)| [haystack[..start].chars().count(), length])
        .collect()
}

/// 一行内的命中（字节范围，相对整篇正文）。
type LineHits = Vec<(usize, usize)>;

struct BlockSource<'a> {
    text: &'a str,
    lower: &'a str,
    lines: &'a [Line],
    markdown: bool,
    locator_kind: DocKind,
}

fn build_block(source: &BlockSource, line_index: usize, hits: &LineHits) -> PreviewBlock {
    let line = &source.lines[line_index];
    // 行尾的回车（CRLF 文件）不属于内容；去掉行尾不影响命中位置的字符序号。
    let raw = source.text[line.start..line.end].trim_end_matches('\r');
    let mut chars: Vec<char> = raw.chars().collect();
    let mut ranges: Vec<(usize, usize)> = hits
        .iter()
        .map(|(start, end)| {
            let from = source.text[line.start..*start].chars().count();
            let length = source.lower[*start..*end].chars().count();
            (from, length)
        })
        .collect();

    let mut heading_level = 0;
    if source.markdown {
        if let Some((level, prefix)) = heading_prefix(raw) {
            heading_level = level;
            chars.drain(0..prefix.min(chars.len()));
            ranges = ranges
                .into_iter()
                .filter(|(from, _)| *from >= prefix)
                .map(|(from, length)| (from - prefix, length))
                .collect();
        }
    }

    let total = chars.len();
    let (window_start, window_end) = if total <= LINE_WINDOW_CHARS {
        (0, total)
    } else {
        let first = ranges.first().map(|range| range.0).unwrap_or(0);
        let start = first.saturating_sub(LINE_LEAD_CHARS);
        (start, (start + LINE_WINDOW_CHARS).min(total))
    };
    let shown: Vec<[usize; 2]> = ranges
        .into_iter()
        .filter(|(from, length)| *from >= window_start && from + length <= window_end)
        .map(|(from, length)| [from - window_start, length])
        .collect();
    let text: String = chars[window_start..window_end].iter().collect();

    PreviewBlock {
        locator: source.locator_kind.locator(line.newlines, line.pages),
        heading_level,
        context_before: nearby_context(source.text, source.lines, line_index, -1),
        text,
        ranges: shown,
        cut_start: window_start > 0,
        cut_end: window_end < total,
        context_after: nearby_context(source.text, source.lines, line_index, 1),
    }
}

/// 生成文件的预览。mode 与搜索范围一致：names 只看文件名，text 只看正文，all 两者都看。
fn build_preview(path_text: &str, query: &str, mode: &str) -> Result<FilePreview, String> {
    let path = Path::new(path_text);
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取 {path_text}：{error}"))?;
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let kind = kind_name(path);
    let mut preview = FilePreview {
        path: path_text.to_string(),
        name,
        kind: kind.to_string(),
        size: metadata.len(),
        name_ranges: Vec::new(),
        blocks: Vec::new(),
        total_hits: 0,
        truncated: false,
        note: String::new(),
    };
    let needle = fold_text(query.trim());
    if needle.is_empty() {
        return Ok(preview);
    }
    if mode != "text" {
        preview.name_ranges = find_ranges(&fold_text(&preview.name), &needle);
    }
    if mode == "names" {
        return Ok(preview);
    }
    if kind == "other" {
        preview.note = "这个类型的文件暂不支持预览正文，可以用默认应用打开。".to_string();
        return Ok(preview);
    }
    let text = match extract_text(path) {
        Ok(value) => value,
        Err(message) => {
            preview.note = message;
            return Ok(preview);
        }
    };
    if text.trim().is_empty() {
        preview.note = "没有提取到文字，可能是扫描件（没有文字层）。".to_string();
        return Ok(preview);
    }

    let lower = fold_text(&text);
    let lines = split_lines(&text);
    // 同一行的多处命中合并为一组；超过块数上限后只计数，不再新增块。
    let mut groups: Vec<(usize, LineHits)> = Vec::new();
    for (start, matched) in lower.match_indices(needle.as_str()) {
        preview.total_hits += 1;
        let end = start + matched.len();
        let line_index = lines.partition_point(|line| line.start <= start).saturating_sub(1);
        let same_line = matches!(groups.last(), Some((index, _)) if *index == line_index);
        if same_line {
            if let Some(group) = groups.last_mut() {
                group.1.push((start, end));
            }
            continue;
        }
        if groups.len() >= MAX_PREVIEW_BLOCKS {
            preview.truncated = true;
            continue;
        }
        groups.push((line_index, vec![(start, end)]));
    }

    let source = BlockSource {
        text: &text,
        lower: &lower,
        lines: &lines,
        markdown: kind == "markdown",
        locator_kind: doc_kind(path).unwrap_or(DocKind::Text),
    };
    for (line_index, hits) in &groups {
        preview.blocks.push(build_block(&source, *line_index, hits));
    }
    Ok(preview)
}

/// 读取文件并返回关键词命中的预览。解析 PDF、Office 文档可能较慢，放在后台线程执行。
#[tauri::command]
pub async fn preview_file(path: String, query: String, mode: String) -> Result<FilePreview, String> {
    let task = tauri::async_runtime::spawn_blocking(move || build_preview(&path, &query, &mode));
    task.await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_sample(label: &str, content: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("documentcraft-preview-{label}-{}.md", std::process::id()));
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn heading_and_body_hits_are_separate_blocks() {
        let path = write_sample("blocks", "# 标题 Alpha\n\n正文含 alpha 与 ALPHA\n结尾");

        let preview = build_preview(path.to_str().unwrap(), "alpha", "all").unwrap();

        assert_eq!(preview.total_hits, 3);
        assert_eq!(preview.blocks.len(), 2);
        let heading = &preview.blocks[0];
        assert_eq!(heading.heading_level, 1);
        assert_eq!(heading.text, "标题 Alpha");
        assert_eq!(heading.ranges, vec![[3, 5]]);
        let body = &preview.blocks[1];
        assert_eq!(body.heading_level, 0);
        assert_eq!(body.ranges, vec![[4, 5], [12, 5]]);
        assert_eq!(body.context_before, "# 标题 Alpha");
        assert_eq!(body.context_after, "结尾");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn names_mode_skips_content_and_text_mode_skips_name() {
        let path = write_sample("modes", "正文里有 preview 这个词");
        let keyword = "preview";

        let names = build_preview(path.to_str().unwrap(), keyword, "names").unwrap();
        assert!(!names.name_ranges.is_empty());
        assert!(names.blocks.is_empty());

        let text = build_preview(path.to_str().unwrap(), keyword, "text").unwrap();
        assert!(text.name_ranges.is_empty());
        assert_eq!(text.blocks.len(), 1);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn gbk_text_file_is_previewed() {
        let path = std::env::temp_dir().join(format!("documentcraft-preview-gbk-{}.txt", std::process::id()));
        let sample = "测试记录：本批样品检测合格，已经复核并归档保存。\n第二行没有关键词，只是为了凑够编码识别需要的样本长度。";
        let (gbk, _, _) = encoding_rs::GBK.encode(sample);
        fs::write(&path, &*gbk).unwrap();

        let preview = build_preview(path.to_str().unwrap(), "检测", "text").unwrap();

        assert_eq!(preview.total_hits, 1);
        assert_eq!(preview.blocks.len(), 1);
        assert!(preview.blocks[0].text.contains("样品检测合格"));
        assert!(preview.note.is_empty());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn unsupported_type_reports_a_note() {
        let path = std::env::temp_dir().join(format!("documentcraft-preview-{}.bin", std::process::id()));
        fs::write(&path, [0u8, 1, 2]).unwrap();

        let preview = build_preview(path.to_str().unwrap(), "x", "all").unwrap();

        assert!(preview.blocks.is_empty());
        assert!(!preview.note.is_empty());
        let _ = fs::remove_file(&path);
    }
}
