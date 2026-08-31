use anyhow::{anyhow, bail, Context, Result};
use flate2::read::GzDecoder;
use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

/// Hard ceiling on how many headers we walk, so a crafted archive claiming
/// millions of members cannot hang the app or balloon memory.
const MAX_WALK_ENTRIES: usize = 100_000;

/// One member of an archive, as described by its header. Never extracted.
#[derive(Debug, Clone, Serialize)]
pub struct ArchiveEntry {
    pub name: String,
    pub size: u64,
    /// Stored size, where the container records a meaningful per-member value.
    pub compressed_size: Option<u64>,
    pub is_dir: bool,
}

/// What an archive contains, read from headers only.
#[derive(Debug, Clone, Serialize)]
pub struct ArchiveListing {
    pub format: String,
    pub entry_count: usize,
    pub total_uncompressed: u64,
    pub entries: Vec<ArchiveEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Zip,
    Tar,
    TarGz,
    SevenZ,
}

impl Format {
    fn name(self) -> &'static str {
        match self {
            Format::Zip => "zip",
            Format::Tar => "tar",
            Format::TarGz => "tar.gz",
            Format::SevenZ => "7z",
        }
    }
}

/// List what is inside an archive without extracting anything, reading at most
/// `limit` entries into the result. Only central directories and member headers
/// are touched; member payloads are never decompressed into memory or to disk.
pub fn list_archive(path: &Path, limit: usize) -> Result<ArchiveListing> {
    let format = detect_format(path)?;
    check_magic(path, format)?;
    let (entry_count, total_uncompressed, entries) = match format {
        Format::Zip => list_zip(path, limit)?,
        Format::Tar => {
            let mut archive = tar::Archive::new(BufReader::new(open(path)?));
            let entries = archive
                .entries_with_seek()
                .map_err(|e| anyhow!("could not read tar archive: {}", e))?;
            walk_tar(entries, limit)?
        }
        Format::TarGz => {
            let mut archive = tar::Archive::new(GzDecoder::new(BufReader::new(open(path)?)));
            let entries = archive
                .entries()
                .map_err(|e| anyhow!("could not read tar.gz archive: {}", e))?;
            walk_tar(entries, limit)?
        }
        Format::SevenZ => list_7z(path, limit)?,
    };
    Ok(ArchiveListing {
        format: format.name().to_string(),
        entry_count,
        total_uncompressed,
        truncated: entries.len() < entry_count,
        entries,
    })
}

fn open(path: &Path) -> Result<File> {
    File::open(path).with_context(|| format!("could not open {}", path.display()))
}

fn detect_format(path: &Path) -> Result<Format> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow!("unreadable file name"))?
        .to_lowercase();
    if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        return Ok(Format::TarGz);
    }
    match name.rsplit_once('.') {
        Some((_, "zip")) | Some((_, "jar")) => Ok(Format::Zip),
        Some((_, "tar")) => Ok(Format::Tar),
        Some((_, "7z")) => Ok(Format::SevenZ),
        Some((_, "rar")) => bail!("RAR archives are not supported yet"),
        Some((_, ext)) => bail!("unsupported archive type: .{}", ext),
        None => bail!(
            "{} has no file extension, so it is not a known archive",
            name
        ),
    }
}

/// Cheap sanity check so a mislabelled file fails with a useful message instead
/// of a parser error. Old v7 tars carry no signature, so they are left to the
/// header walk to validate.
fn check_magic(path: &Path, format: Format) -> Result<()> {
    let mut head = [0u8; 6];
    let read = open(path)?
        .read(&mut head)
        .with_context(|| format!("could not read {}", path.display()))?;
    let head = &head[..read];
    let ok = match format {
        Format::Zip => head.starts_with(b"PK"),
        Format::TarGz => head.starts_with(&[0x1f, 0x8b]),
        Format::SevenZ => head.starts_with(&[b'7', b'z', 0xbc, 0xaf, 0x27, 0x1c]),
        Format::Tar => true,
    };
    if !ok {
        bail!(
            "{} is not a valid {} archive (wrong file signature)",
            path.display(),
            format.name()
        );
    }
    Ok(())
}

fn list_zip(path: &Path, limit: usize) -> Result<(usize, u64, Vec<ArchiveEntry>)> {
    let mut zip = zip::ZipArchive::new(BufReader::new(open(path)?))
        .map_err(|e| anyhow!("could not read zip archive: {}", e))?;
    let entry_count = zip.len();
    let mut total = 0u64;
    let mut entries = Vec::new();
    for i in 0..entry_count.min(MAX_WALK_ENTRIES) {
        // by_index_raw reads the header only; it never sets up a decompressor.
        let file = zip
            .by_index_raw(i)
            .map_err(|e| anyhow!("corrupt zip entry {}: {}", i, e))?;
        if file.encrypted() {
            bail!("this zip is encrypted, so its contents cannot be listed without a password");
        }
        total = total.saturating_add(file.size());
        if entries.len() < limit {
            entries.push(ArchiveEntry {
                name: file.name().to_string(),
                size: file.size(),
                compressed_size: Some(file.compressed_size()),
                is_dir: file.is_dir(),
            });
        }
    }
    Ok((entry_count, total, entries))
}

fn walk_tar<R: Read>(
    entries: tar::Entries<'_, R>,
    limit: usize,
) -> Result<(usize, u64, Vec<ArchiveEntry>)> {
    let mut count = 0usize;
    let mut total = 0u64;
    let mut out = Vec::new();
    for entry in entries.take(MAX_WALK_ENTRIES) {
        let entry = entry.map_err(|e| anyhow!("corrupt tar entry: {}", e))?;
        let header = entry.header();
        let size = header.size().unwrap_or(0);
        let is_dir = header.entry_type().is_dir();
        count += 1;
        if !is_dir {
            total = total.saturating_add(size);
        }
        if out.len() < limit {
            let name = entry
                .path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| String::from_utf8_lossy(&entry.path_bytes()).to_string());
            out.push(ArchiveEntry {
                name,
                size,
                compressed_size: None,
                is_dir,
            });
        }
    }
    Ok((count, total, out))
}

fn list_7z(path: &Path, limit: usize) -> Result<(usize, u64, Vec<ArchiveEntry>)> {
    let archive = sevenz_rust::Archive::open(path).map_err(|e| match e {
        sevenz_rust::Error::PasswordRequired => {
            anyhow!(
                "this 7z archive is encrypted, so its contents cannot be listed without a password"
            )
        }
        other => anyhow!("could not read 7z archive: {}", other),
    })?;
    let entry_count = archive.files.len();
    let mut total = 0u64;
    let mut entries = Vec::new();
    for file in archive.files.iter().take(MAX_WALK_ENTRIES) {
        if !file.is_directory {
            total = total.saturating_add(file.size);
        }
        if entries.len() < limit {
            entries.push(ArchiveEntry {
                name: file.name.clone(),
                size: file.size,
                // 7z packs members into solid blocks, so a per-entry value is
                // only meaningful when the container actually recorded one.
                compressed_size: (file.compressed_size > 0).then_some(file.compressed_size),
                is_dir: file.is_directory,
            });
        }
    }
    Ok((entry_count, total, entries))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_zip(path: &Path, members: &[(&str, &[u8])]) {
        let mut writer = zip::ZipWriter::new(File::create(path).unwrap());
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in members {
            writer.start_file(*name, opts).unwrap();
            writer.write_all(body).unwrap();
        }
        writer.add_directory("docs/", opts).unwrap();
        writer.finish().unwrap();
    }

    fn write_targz(path: &Path, members: &[(&str, &[u8])]) {
        let encoder = GzEncoder::new(File::create(path).unwrap(), Compression::default());
        let mut builder = tar::Builder::new(encoder);
        for (name, body) in members {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, *name, *body).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
    }

    #[test]
    fn lists_zip_entries_and_sizes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("sample.zip");
        write_zip(&path, &[("a.txt", b"hello"), ("b/c.txt", b"worldworld")]);
        let listing = list_archive(&path, 200).unwrap();
        assert_eq!(listing.format, "zip");
        assert_eq!(listing.entry_count, 3);
        assert_eq!(listing.total_uncompressed, 15);
        assert!(!listing.truncated);
        let a = listing.entries.iter().find(|e| e.name == "a.txt").unwrap();
        assert_eq!(a.size, 5);
        assert!(a.compressed_size.is_some());
        assert!(!a.is_dir);
        assert!(listing
            .entries
            .iter()
            .any(|e| e.name == "docs/" && e.is_dir));
    }

    #[test]
    fn lists_plain_tar_entries_and_sizes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("sample.tar");
        let mut builder = tar::Builder::new(File::create(&path).unwrap());
        for (name, body) in [("a.txt", &b"hello"[..]), ("b/c.txt", &b"worldworld"[..])] {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, name, body).unwrap();
        }
        builder.finish().unwrap();
        let listing = list_archive(&path, 200).unwrap();
        assert_eq!(listing.format, "tar");
        assert_eq!(listing.entry_count, 2);
        assert_eq!(listing.total_uncompressed, 15);
        assert_eq!(listing.entries[1].name, "b/c.txt");
    }

    #[test]
    fn lists_7z_entries_and_sizes() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("payload");
        std::fs::create_dir(&src).unwrap();
        File::create(src.join("a.txt"))
            .unwrap()
            .write_all(b"hello")
            .unwrap();
        File::create(src.join("b.txt"))
            .unwrap()
            .write_all(b"worldworld")
            .unwrap();
        let path = dir.path().join("sample.7z");
        sevenz_rust::compress_to_path(&src, &path).unwrap();
        let listing = list_archive(&path, 200).unwrap();
        assert_eq!(listing.format, "7z");
        // compress_to_path also records the source directory itself
        assert_eq!(listing.entry_count, 3);
        assert_eq!(listing.total_uncompressed, 15);
        assert!(!listing.truncated);
        let a = listing.entries.iter().find(|e| e.name == "a.txt").unwrap();
        assert_eq!(a.size, 5);
        assert!(!a.is_dir);
        assert!(listing.entries.iter().any(|e| e.is_dir));
    }

    #[test]
    fn lists_targz_entries_and_sizes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("sample.tar.gz");
        write_targz(&path, &[("a.txt", b"hello"), ("b/c.txt", b"worldworld")]);
        let listing = list_archive(&path, 200).unwrap();
        assert_eq!(listing.format, "tar.gz");
        assert_eq!(listing.entry_count, 2);
        assert_eq!(listing.total_uncompressed, 15);
        assert!(!listing.truncated);
        assert_eq!(listing.entries[0].name, "a.txt");
        assert_eq!(listing.entries[0].size, 5);
        assert_eq!(listing.entries[0].compressed_size, None);
    }

    #[test]
    fn truncates_at_limit_but_keeps_true_totals() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("many.zip");
        write_zip(
            &zip_path,
            &[("a.txt", b"hello"), ("b/c.txt", b"worldworld")],
        );
        let listing = list_archive(&zip_path, 1).unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entry_count, 3);
        assert_eq!(listing.total_uncompressed, 15);
        assert!(listing.truncated);
        let tgz_path = dir.path().join("many.tar.gz");
        write_targz(
            &tgz_path,
            &[("a.txt", b"hello"), ("b/c.txt", b"worldworld")],
        );
        let listing = list_archive(&tgz_path, 1).unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entry_count, 2);
        assert!(listing.truncated);
    }

    #[test]
    fn rejects_unsupported_and_corrupt_archives() {
        let dir = tempdir().unwrap();
        let doc = dir.path().join("notes.pdf");
        File::create(&doc).unwrap().write_all(b"%PDF-1.4").unwrap();
        let err = list_archive(&doc, 10).unwrap_err().to_string();
        assert!(err.contains("unsupported archive type: .pdf"), "{}", err);
        let rar = dir.path().join("stuff.rar");
        File::create(&rar)
            .unwrap()
            .write_all(b"Rar!\x1a\x07")
            .unwrap();
        let err = list_archive(&rar, 10).unwrap_err().to_string();
        assert!(
            err.contains("RAR archives are not supported yet"),
            "{}",
            err
        );
        let fake = dir.path().join("broken.zip");
        File::create(&fake)
            .unwrap()
            .write_all(b"not a zip at all")
            .unwrap();
        let err = list_archive(&fake, 10).unwrap_err().to_string();
        assert!(err.contains("wrong file signature"), "{}", err);
        let truncated = dir.path().join("half.zip");
        File::create(&truncated)
            .unwrap()
            .write_all(b"PK\x03\x04garbage")
            .unwrap();
        let err = list_archive(&truncated, 10).unwrap_err().to_string();
        assert!(err.contains("could not read zip archive"), "{}", err);
    }
}
