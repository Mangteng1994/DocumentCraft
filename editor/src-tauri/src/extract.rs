//! 从 Word、Excel、PowerPoint 和 PDF 中提取纯文本，供工作区搜索建立索引。
//!
//! 约定：返回文本以 `\n` 分隔段落或行；PDF 与 PowerPoint 以换页符 `\u{c}` 分隔页和幻灯片，
//! 搜索结果据此计算「第几页」。Office 文件（docx、xlsx、pptx）是 zip 包，只读取其中的 XML；
//! 旧版 doc、xls、ppt 是二进制格式，不解析。提取失败（加密、损坏）返回错误，扫描件没有文字层时返回空文本。

use std::borrow::Cow;
use std::fs;
use std::io::{Read, Seek};
use std::path::Path;
use zip::ZipArchive;

/// 按纯文本读取正文的扩展名；同时用于判断是否建立纯文本的正文索引。
const TEXT_EXTENSIONS: [&str; 44] = [
    "md", "markdown", "txt", "text", "csv", "tsv", "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf",
    "log", "xml", "html", "htm", "css", "js", "jsx", "ts", "tsx", "py", "rs", "java", "c", "cpp", "h", "hpp", "go",
    "sh", "sql", "tex", "bib", "rst", "org", "srt", "vtt", "base", "canvas", "ps1", "bat", "cmd",
];
/// 读取纯文本正文的文件大小上限。更大的文件只按文件名搜索。
pub const MAX_TEXT_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// 扩展名属于可按纯文本读取的类型。只按扩展名判断，不嗅探内容：不是 UTF-8 的文件读取会失败，只能按文件名匹配。
pub fn is_text_file(path: &Path) -> bool {
    let extension = path.extension().and_then(|value| value.to_str());
    match extension {
        Some(value) => {
            let lower = value.to_ascii_lowercase();
            TEXT_EXTENSIONS.contains(&lower.as_str())
        }
        None => false,
    }
}

/// 扩展名是 Markdown。
pub fn is_markdown_file(path: &Path) -> bool {
    let extension = path.extension().and_then(|value| value.to_str());
    match extension {
        Some(value) => value.eq_ignore_ascii_case("md") || value.eq_ignore_ascii_case("markdown"),
        None => false,
    }
}

/// 单个文档提取出的文本上限（字节）。超出部分截断，避免极端文件占满内存。
pub const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
/// 参与解析的文件大小上限。更大的文件只按文件名搜索。
pub const MAX_DOCUMENT_BYTES: u64 = 200 * 1024 * 1024;
/// 换页符：分隔 PDF 的页和 PowerPoint 的幻灯片。
pub const PAGE_BREAK: char = '\u{c}';

/// 可解析正文的文档类型。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DocKind {
    Docx,
    Xlsx,
    Pptx,
    Pdf,
    /// 纯文本文件。大工作区把它们也放进索引，搜索时不必逐个去网络上读取。
    Text,
}

impl DocKind {
    /// 搜索结果中位置的说明。newlines、pages 是命中位置之前的换行符和换页符个数：
    /// 页、幻灯片按换页符计数，段落、行按换行符计数。
    pub fn locator(self, newlines: usize, pages: usize) -> String {
        match self {
            DocKind::Pdf => format!("第 {} 页", pages + 1),
            DocKind::Pptx => format!("第 {} 张", pages + 1),
            DocKind::Docx => format!("第 {} 段", newlines + 1),
            DocKind::Xlsx | DocKind::Text => format!("第 {} 行", newlines + 1),
        }
    }
}

/// 按扩展名判断文档类型，不区分大小写。
pub fn doc_kind(path: &Path) -> Option<DocKind> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "docx" => Some(DocKind::Docx),
        "xlsx" => Some(DocKind::Xlsx),
        "pptx" => Some(DocKind::Pptx),
        "pdf" => Some(DocKind::Pdf),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 轻量 XML 扫描：只需要标签名、属性和文本，不做完整解析。
// ---------------------------------------------------------------------------

enum Token<'a> {
    /// 起始标签：本地名（去掉命名空间前缀）、属性串、是否自闭合。
    Start { name: &'a str, attrs: &'a str, empty: bool },
    End(&'a str),
    Text(&'a str),
}

fn local_name(name: &str) -> &str {
    match name.rfind(':') {
        Some(index) => &name[index + 1..],
        None => name,
    }
}

/// 依次交出 XML 中的标签和文本。注释、处理指令跳过；CDATA 按文本处理。
fn scan_xml<'a>(xml: &'a str, mut handle: impl FnMut(Token<'a>)) {
    let mut position = 0;
    while position < xml.len() {
        let Some(open) = xml[position..].find('<').map(|index| index + position) else {
            handle(Token::Text(&xml[position..]));
            return;
        };
        if open > position {
            handle(Token::Text(&xml[position..open]));
        }
        let rest = &xml[open..];
        if rest.starts_with("<!--") {
            position = rest.find("-->").map_or(xml.len(), |index| open + index + 3);
            continue;
        }
        if rest.starts_with("<![CDATA[") {
            let body_start = open + 9;
            let body_end = rest.find("]]>").map_or(xml.len(), |index| open + index);
            handle(Token::Text(&xml[body_start..body_end]));
            position = (body_end + 3).min(xml.len());
            continue;
        }
        if rest.starts_with("<?") {
            position = rest.find("?>").map_or(xml.len(), |index| open + index + 2);
            continue;
        }
        let Some(close) = rest.find('>').map(|index| index + open) else {
            return;
        };
        let inner = xml[open + 1..close].trim();
        position = close + 1;
        if let Some(name) = inner.strip_prefix('/') {
            handle(Token::End(local_name(name.trim())));
            continue;
        }
        let empty = inner.ends_with('/');
        let inner = inner.trim_end_matches('/').trim_end();
        let (name, attrs) = match inner.find(char::is_whitespace) {
            Some(index) => (&inner[..index], &inner[index..]),
            None => (inner, ""),
        };
        handle(Token::Start { name: local_name(name), attrs, empty });
    }
}

/// 取属性值，如 `attr(" r=\"A1\" t=\"s\"", "t")` 得到 `s`。
fn attr<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    let key = format!("{name}=\"");
    let mut search_from = 0;
    while let Some(found) = attrs[search_from..].find(&key) {
        let start = search_from + found;
        let preceded_by_space = start == 0 || attrs[..start].ends_with(char::is_whitespace);
        if preceded_by_space {
            let value_start = start + key.len();
            let value_end = attrs[value_start..].find('"')? + value_start;
            return Some(&attrs[value_start..value_end]);
        }
        search_from = start + key.len();
    }
    None
}

/// 还原 XML 实体：五个预定义实体和数字字符引用。
fn unescape(text: &str) -> Cow<'_, str> {
    if !text.contains('&') {
        return Cow::Borrowed(text);
    }
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find('&') {
        result.push_str(&rest[..index]);
        rest = &rest[index..];
        let Some(end) = rest.find(';') else {
            break;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity.strip_prefix('#').and_then(|number| {
                let code = match number.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => number.parse::<u32>().ok(),
                };
                code.and_then(char::from_u32)
            }),
        };
        match decoded {
            Some(character) => {
                result.push(character);
                rest = &rest[end + 1..];
            }
            None => {
                result.push('&');
                rest = &rest[1..];
            }
        }
    }
    result.push_str(rest);
    Cow::Owned(result)
}

// ---------------------------------------------------------------------------
// zip 包读取
// ---------------------------------------------------------------------------

fn read_entry<R: Read + Seek>(archive: &mut ZipArchive<R>, name: &str) -> Option<String> {
    let mut entry = archive.by_name(name).ok()?;
    // 单个 XML 部件上限，防止压缩炸弹。
    let limit = (MAX_TEXT_BYTES as u64) * 8;
    let mut bytes = Vec::new();
    entry.by_ref().take(limit).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// 列出包内以 prefix 开头、以 .xml 结尾的部件，按名称中的数字排序（slide2 在 slide10 之前）。
fn numbered_parts<R: Read + Seek>(archive: &ZipArchive<R>, prefix: &str) -> Vec<String> {
    let mut names: Vec<String> = archive
        .file_names()
        .filter(|name| name.starts_with(prefix) && name.ends_with(".xml") && !name.contains("/_rels/"))
        .map(str::to_string)
        .collect();
    let number = |name: &str| -> u64 {
        let digits: String = name.chars().filter(char::is_ascii_digit).collect();
        digits.parse().unwrap_or(0)
    };
    names.sort_by_key(|name| (number(name), name.clone()));
    names
}

// ---------------------------------------------------------------------------
// 各格式的提取
// ---------------------------------------------------------------------------

/// docx 与 pptx 共用：`<t>` 内是文字，`</p>` 换行，`<tab>` 制表，`<br>` 换行。
fn office_paragraphs(xml: &str, output: &mut String) {
    let mut in_text = false;
    scan_xml(xml, |token| match token {
        Token::Start { name: "t", empty: false, .. } => in_text = true,
        Token::Start { name: "tab", .. } => output.push('\t'),
        Token::Start { name: "br" | "cr", .. } => output.push('\n'),
        Token::End("t") => in_text = false,
        Token::End("p") => {
            if !output.ends_with('\n') {
                output.push('\n');
            }
        }
        Token::End("tc") => output.push('\t'),
        Token::Text(text) if in_text => output.push_str(&unescape(text)),
        _ => {}
    });
}

fn extract_docx<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<String, String> {
    let mut output = String::new();
    // 正文之后附上脚注、尾注和批注，批注里常有评审意见。
    for part in ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml", "word/comments.xml"] {
        if let Some(xml) = read_entry(archive, part) {
            office_paragraphs(&xml, &mut output);
        } else if part == "word/document.xml" {
            return Err("不是有效的 Word 文档。".to_string());
        }
    }
    Ok(output)
}

fn extract_pptx<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<String, String> {
    let slides = numbered_parts(archive, "ppt/slides/slide");
    if slides.is_empty() {
        return Err("不是有效的 PowerPoint 文档。".to_string());
    }
    let mut output = String::new();
    for slide in slides {
        if let Some(xml) = read_entry(archive, &slide) {
            office_paragraphs(&xml, &mut output);
        }
        output.push(PAGE_BREAK);
    }
    Ok(output)
}

/// xlsx 的共享字符串表：每个 `<si>` 是一个字符串，富文本由多个 `<t>` 拼成，拼音注音 `<rPh>` 不计。
fn shared_strings(xml: &str) -> Vec<String> {
    let mut strings = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    let mut phonetic_depth = 0;
    scan_xml(xml, |token| match token {
        Token::Start { name: "si", .. } => current.clear(),
        Token::Start { name: "rPh", empty: false, .. } => phonetic_depth += 1,
        Token::Start { name: "t", empty: false, .. } => in_text = true,
        Token::End("rPh") => phonetic_depth -= 1,
        Token::End("t") => in_text = false,
        Token::End("si") => strings.push(std::mem::take(&mut current)),
        Token::Text(text) if in_text && phonetic_depth == 0 => current.push_str(&unescape(text)),
        _ => {}
    });
    strings
}

/// 工作簿中工作表的名称，按出现顺序。
fn sheet_names(xml: &str) -> Vec<String> {
    let mut names = Vec::new();
    scan_xml(xml, |token| {
        if let Token::Start { name: "sheet", attrs, .. } = token {
            if let Some(value) = attr(attrs, "name") {
                names.push(unescape(value).into_owned());
            }
        }
    });
    names
}

fn sheet_rows(xml: &str, strings: &[String], output: &mut String) {
    let mut cell_type = String::new();
    let mut in_value = false;
    let mut in_inline = false;
    let mut in_inline_text = false;
    let mut value = String::new();
    let mut line_has_cells = false;
    scan_xml(xml, |token| match token {
        Token::Start { name: "c", attrs, .. } => {
            cell_type = attr(attrs, "t").unwrap_or("").to_string();
            value.clear();
        }
        Token::Start { name: "v", empty: false, .. } => in_value = true,
        Token::Start { name: "is", empty: false, .. } => in_inline = true,
        Token::Start { name: "t", empty: false, .. } if in_inline => in_inline_text = true,
        Token::End("v") => in_value = false,
        Token::End("t") => in_inline_text = false,
        Token::End("is") => in_inline = false,
        Token::Text(text) if in_value || in_inline_text => value.push_str(&unescape(text)),
        Token::End("c") => {
            let cell = if cell_type == "s" {
                value.trim().parse::<usize>().ok().and_then(|index| strings.get(index)).cloned().unwrap_or_default()
            } else {
                value.trim().to_string()
            };
            if !cell.is_empty() {
                if line_has_cells {
                    output.push('\t');
                }
                output.push_str(&cell);
                line_has_cells = true;
            }
        }
        Token::End("row") => {
            if line_has_cells {
                output.push('\n');
            }
            line_has_cells = false;
        }
        _ => {}
    });
}

fn extract_xlsx<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<String, String> {
    let sheets = numbered_parts(archive, "xl/worksheets/sheet");
    if sheets.is_empty() {
        return Err("不是有效的 Excel 工作簿。".to_string());
    }
    let strings = read_entry(archive, "xl/sharedStrings.xml").map(|xml| shared_strings(&xml)).unwrap_or_default();
    let names = read_entry(archive, "xl/workbook.xml").map(|xml| sheet_names(&xml)).unwrap_or_default();
    let mut output = String::new();
    for (index, sheet) in sheets.iter().enumerate() {
        // 工作表名与文件序号按出现顺序对应；数量对不上时用序号代替。
        let title = if names.len() == sheets.len() { names[index].clone() } else { format!("工作表 {}", index + 1) };
        output.push_str(&format!("【{title}】\n"));
        if let Some(xml) = read_entry(archive, sheet) {
            sheet_rows(&xml, &strings, &mut output);
        }
    }
    Ok(output)
}

fn extract_office(path: &Path, kind: DocKind) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|error| format!("无法读取：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|_| "不是有效的 Office 文档，或文档已加密。".to_string())?;
    match kind {
        DocKind::Docx => extract_docx(&mut archive),
        DocKind::Xlsx => extract_xlsx(&mut archive),
        DocKind::Pptx => extract_pptx(&mut archive),
        DocKind::Pdf | DocKind::Text => Err("内部错误：该类型不走 Office 路径。".to_string()),
    }
}

fn is_han(character: char) -> bool {
    ('\u{3400}'..='\u{9fff}').contains(&character)
}

/// 整理 PDF 一页的文字：PDF 按视觉行断行，中文被行尾换行或空格切开，会导致跨行的词搜不到。
/// 前后都是汉字时去掉中间的换行和空格；中英文之间的空格和其他换行保持不变。
fn reflow_page(page: &str) -> String {
    let characters: Vec<char> = page.chars().collect();
    let mut output = String::with_capacity(page.len());
    for (index, &character) in characters.iter().enumerate() {
        if character != '\n' && character != ' ' {
            output.push(character);
            continue;
        }
        let previous = output.chars().next_back();
        let next = characters[index + 1..].iter().find(|&&next| next != '\n' && next != ' ');
        let between_han = previous.is_some_and(is_han) && next.is_some_and(|&next| is_han(next));
        if !between_han {
            output.push(character);
        }
    }
    output
}

/// 提取 PDF 文字层。第三方库遇到异常字体或损坏文件时可能 panic，这里捕获后按失败处理。
fn extract_pdf(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("无法读取：{error}"))?;
    let outcome = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(&bytes));
    match outcome {
        Ok(Ok(pages)) => {
            let reflowed: Vec<String> = pages.iter().map(|page| reflow_page(page)).collect();
            Ok(reflowed.join(&PAGE_BREAK.to_string()))
        }
        Ok(Err(_)) => Err("无法解析 PDF，文件可能已损坏或加密。".to_string()),
        Err(_) => Err("解析 PDF 时出错，已跳过。".to_string()),
    }
}

fn truncate_on_boundary(mut text: String, limit: usize) -> String {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text
}

/// 读取 UTF-8 纯文本，去掉 BOM。不是 UTF-8 或文件过大时返回错误。
fn extract_plain_text(path: &Path) -> Result<String, String> {
    let size = fs::metadata(path).map_err(|error| format!("无法读取：{error}"))?.len();
    if size > MAX_TEXT_FILE_BYTES {
        return Err("文件过大，已跳过正文。".to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("无法读取：{error}"))?;
    let text = String::from_utf8(bytes).map_err(|_| "不是 UTF-8 编码的文本。".to_string())?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// 提取文档正文。文件过大、类型不支持或解析失败时返回错误；扫描件没有文字层时返回空文本。
pub fn extract_text(path: &Path) -> Result<String, String> {
    if doc_kind(path).is_none() && is_text_file(path) {
        return extract_plain_text(path);
    }
    let kind = doc_kind(path).ok_or_else(|| "不支持的文档类型。".to_string())?;
    let size = fs::metadata(path).map_err(|error| format!("无法读取：{error}"))?.len();
    if size > MAX_DOCUMENT_BYTES {
        return Err("文件过大，已跳过正文。".to_string());
    }
    let text = match kind {
        DocKind::Pdf => extract_pdf(path)?,
        DocKind::Text => extract_plain_text(path)?,
        other => extract_office(path, other)?,
    };
    Ok(truncate_on_boundary(text, MAX_TEXT_BYTES))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    fn write_package(name: &str, parts: &[(&str, &str)]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("documentcraft-extract-{}-{}", std::process::id(), name));
        let file = fs::File::create(&path).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (part, content) in parts {
            writer.start_file(*part, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
        path
    }

    #[test]
    fn unescape_handles_named_and_numeric_entities() {
        assert_eq!(unescape("a &amp; b &lt;c&gt; &#20013;&#x6587;"), "a & b <c> 中文");
        assert_eq!(unescape("无实体"), "无实体");
        assert_eq!(unescape("坏 &实体 未结束"), "坏 &实体 未结束");
    }

    #[test]
    fn reflow_joins_chinese_lines_but_keeps_mixed_text() {
        assert_eq!(reflow_page("流量\n计 测量"), "流量计测量");
        assert_eq!(reflow_page("RAG 模块\n结束 end\nnext"), "RAG 模块结束 end\nnext");
        assert_eq!(reflow_page("标题\n\n正文"), "标题正文");
        // 汉字与汉字之间无论原先是否分行都会连起来；数字、字母与汉字之间的换行保留。
        assert_eq!(reflow_page("第 1 页\n第二行"), "第 1 页第二行");
        assert_eq!(reflow_page("Page 1\n第二行"), "Page 1\n第二行");
    }

    #[test]
    fn docx_text_keeps_paragraphs_tabs_and_comments() {
        let document = r#"<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
            <w:p><w:r><w:t>第一段 </w:t></w:r><w:r><w:t xml:space="preserve">含 &amp; 符号</w:t></w:r></w:p>
            <w:p><w:r><w:t>表头</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>数值</w:t></w:r></w:p>
            </w:body></w:document>"#;
        let comments = r#"<w:comments xmlns:w="x"><w:comment><w:p><w:r><w:t>批注内容</w:t></w:r></w:p></w:comment></w:comments>"#;
        let path = write_package("a.docx", &[("word/document.xml", document), ("word/comments.xml", comments)]);
        let text = extract_text(&path).unwrap();
        assert_eq!(text, "第一段 含 & 符号\n表头\t数值\n批注内容\n");
        assert_eq!(DocKind::Docx.locator(1, 0), "第 2 段");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn pptx_slides_are_ordered_numerically_and_separated_by_page_breaks() {
        let slide = |text: &str| format!(r#"<p:sld xmlns:a="x" xmlns:p="y"><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:sld>"#);
        let (one, two, ten) = (slide("第一张"), slide("第二张"), slide("第十张"));
        let path = write_package(
            "a.pptx",
            &[("ppt/slides/slide10.xml", ten.as_str()), ("ppt/slides/slide2.xml", two.as_str()), ("ppt/slides/slide1.xml", one.as_str())],
        );
        let text = extract_text(&path).unwrap();
        assert_eq!(text, "第一张\n\u{c}第二张\n\u{c}第十张\n\u{c}");
        assert_eq!(DocKind::Pptx.locator(1, 1), "第 2 张");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn xlsx_resolves_shared_strings_inline_text_and_sheet_names() {
        let shared = r#"<sst><si><t>姓名</t></si><si><r><t>流</t></r><r><t>速</t></r><rPh><t>ignored</t></rPh></si></sst>"#;
        let workbook = r#"<workbook><sheets><sheet name="数据 &amp; 表" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
        let sheet = r#"<worksheet><sheetData>
            <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
            <row r="2"><c r="A2" t="inlineStr"><is><t>内联</t></is></c><c r="B2"><v>0.5</v></c></row>
            </sheetData></worksheet>"#;
        let path = write_package(
            "a.xlsx",
            &[("xl/sharedStrings.xml", shared), ("xl/workbook.xml", workbook), ("xl/worksheets/sheet1.xml", sheet)],
        );
        let text = extract_text(&path).unwrap();
        assert_eq!(text, "【数据 & 表】\n姓名\t流速\n内联\t0.5\n");
        let _ = fs::remove_file(&path);
    }

    /// 手动验证真实文档的提取效果：`DOCUMENTCRAFT_SAMPLE=文件路径 cargo test real_document -- --ignored --nocapture`。
    #[test]
    #[ignore]
    fn real_document_sample() {
        let path = std::env::var("DOCUMENTCRAFT_SAMPLE").expect("需要设置 DOCUMENTCRAFT_SAMPLE");
        println!("路径：{path:?}");
        let started = std::time::Instant::now();
        let outcome = extract_text(Path::new(&path));
        let elapsed = started.elapsed();
        match outcome {
            Ok(text) => {
                let preview: String = text.chars().take(300).collect();
                println!("耗时 {elapsed:?}，字符数 {}，页/幻灯片分隔 {}，预览：\n{preview}", text.chars().count(), text.matches(PAGE_BREAK).count());
            }
            Err(error) => println!("耗时 {elapsed:?}，失败：{error}"),
        }
    }

    #[test]
    fn broken_and_unsupported_files_return_errors_without_panicking() {
        let bogus = std::env::temp_dir().join(format!("documentcraft-extract-{}-bogus.docx", std::process::id()));
        fs::write(&bogus, "not a zip").unwrap();
        assert!(extract_text(&bogus).is_err());
        let fake_pdf = std::env::temp_dir().join(format!("documentcraft-extract-{}-fake.pdf", std::process::id()));
        fs::write(&fake_pdf, "%PDF-1.4 garbage").unwrap();
        assert!(extract_text(&fake_pdf).is_err());
        assert!(extract_text(Path::new("a.txt")).is_err());
        assert_eq!(doc_kind(Path::new("报告.DOCX")), Some(DocKind::Docx));
        assert_eq!(doc_kind(Path::new("旧.doc")), None);
        let _ = fs::remove_file(&bogus);
        let _ = fs::remove_file(&fake_pdf);
    }
}
