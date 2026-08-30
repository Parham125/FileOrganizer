use anyhow::Result;
use std::io::Read;
use std::path::Path;

/// Max input file size we will attempt to read (bytes).
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// Cap on returned text so a single huge document can't blow up the index (bytes).
const MAX_TEXT_BYTES: usize = 1024 * 1024;

/// Extensions treated as UTF-8 text/code and read directly.
const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "log", "json", "toml", "yaml", "yml", "ini", "cfg",
    "conf", "xml", "rs", "py", "js", "jsx", "ts", "tsx", "html", "htm", "css", "scss", "sh",
    "bash", "zsh", "c", "h", "cpp", "hpp", "cc", "java", "go", "rb", "php", "sql", "swift", "kt",
    "lua", "pl", "r", "vue", "svelte",
];

/// Extract searchable text from a document, capped at ~1 MB.
/// Returns `Ok(None)` for unsupported extensions, files over the size cap, or
/// documents that yield no usable text. Errors only bubble up for genuinely
/// unexpected failures; callers should skip a file rather than abort a crawl.
pub fn extract_text(path: &Path) -> Result<Option<String>> {
    let ext = match path.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_lowercase(),
        None => return Ok(None),
    };
    let supported = TEXT_EXTS.contains(&ext.as_str()) || ext == "pdf" || ext == "docx";
    if !supported {
        return Ok(None);
    }
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_FILE_BYTES {
            return Ok(None);
        }
    }
    let text = if ext == "pdf" {
        pdf_extract::extract_text(path).unwrap_or_default()
    } else if ext == "docx" {
        extract_docx(path).unwrap_or_default()
    } else {
        let bytes = std::fs::read(path)?;
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Ok(normalize(text))
}

/// Trim to the byte cap on a char boundary and drop empties.
fn normalize(mut text: String) -> Option<String> {
    if text.len() > MAX_TEXT_BYTES {
        let mut end = MAX_TEXT_BYTES;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Read `word/document.xml` out of a .docx and strip XML tags, keeping paragraph
/// and tab breaks as whitespace so adjacent runs don't fuse into one token.
fn extract_docx(path: &Path) -> Result<String> {
    let file = std::fs::File::open(path)?;
    let mut zip = zip::ZipArchive::new(file)?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")?.read_to_string(&mut xml)?;
    let mut out = String::with_capacity(xml.len() / 2);
    let mut in_tag = false;
    let mut tag = String::new();
    for ch in xml.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' => {
                in_tag = false;
                if tag.starts_with("w:p") || tag.starts_with("/w:p") {
                    out.push('\n');
                } else if tag.starts_with("w:tab") || tag.starts_with("w:br") {
                    out.push(' ');
                }
            }
            _ if in_tag => tag.push(ch),
            _ => out.push(ch),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_text_and_skips_binary() {
        let dir = tempfile::tempdir().unwrap();
        let txt = dir.path().join("a.txt");
        std::fs::write(&txt, b"hello wombat world").unwrap();
        let got = extract_text(&txt).unwrap().unwrap();
        assert!(got.contains("wombat"));
        let bin = dir.path().join("a.bin");
        std::fs::write(&bin, [0u8, 1, 2, 3]).unwrap();
        assert!(extract_text(&bin).unwrap().is_none());
        let empty = dir.path().join("empty.md");
        std::fs::write(&empty, b"   ").unwrap();
        assert!(extract_text(&empty).unwrap().is_none());
    }

    #[test]
    fn extracts_docx_body() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.docx");
        let f = std::fs::File::create(&path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        zw.start_file::<_, ()>(
            "word/document.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zw.write_all(
            b"<w:document><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p>\
              <w:p><w:r><w:t>platypus</w:t></w:r></w:p></w:body></w:document>",
        )
        .unwrap();
        zw.finish().unwrap();
        let got = extract_text(&path).unwrap().unwrap();
        assert!(got.contains("hello"));
        assert!(got.contains("platypus"));
    }
}
