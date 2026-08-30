//! Windows-only NTFS Master File Table fast enumerator.
//!
//! Reads the raw $MFT over a volume handle (`\\.\C:`) with the `ntfs` crate for
//! near-instant full-volume enumeration (Everything-style), then filters to the
//! entries that fall under the requested root. Requires administrator rights and
//! an NTFS volume; any failure returns an error so the caller falls back to
//! `WalkdirSource`.
//!
//! Scope: initial enumeration only.
// TODO(usn): live journal sync - track changes via the USN change journal.

use crate::{FileEntry, FileSource};
use anyhow::{bail, Context, Result};
use ntfs::structured_values::NtfsFileNamespace;
use ntfs::{KnownNtfsFileRecordNumber, Ntfs, NtfsFile, NtfsTime};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf, Prefix};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceW;

/// NTFS MFT-backed [`FileSource`] for near-instant full-volume enumeration.
pub struct MftSource;

impl FileSource for MftSource {
    fn enumerate(&self, root: &Path) -> Result<Vec<FileEntry>> {
        let letter = drive_letter(root).context("MFT source requires a drive-letter path")?;
        let sector_size = bytes_per_sector(letter)?;
        let volume = format!(r"\\.\{letter}:");
        let handle = File::open(&volume)
            .with_context(|| format!("failed to open {volume} (requires administrator)"))?;
        let mut fs = SectorReader::new(handle, sector_size);
        let mut ntfs = Ntfs::new(&mut fs).context("not an NTFS volume")?;
        let _ = ntfs.read_upcase_table(&mut fs);
        let count = record_count(&ntfs, &mut fs)?;
        let mut records: HashMap<u64, Record> = HashMap::with_capacity(count as usize);
        for n in 0..count {
            let file = match ntfs.file(&mut fs, n) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let name = match best_name(&file, &mut fs) {
                Some(n) => n,
                None => continue,
            };
            let modified = file
                .info()
                .ok()
                .map(|info| nt_to_system_time(info.modification_time()));
            records.insert(
                file.file_record_number(),
                Record {
                    name: name.name,
                    parent: name.parent,
                    is_dir: file.is_directory(),
                    size: data_size(&file, &mut fs),
                    modified,
                },
            );
        }
        let mut entries = Vec::new();
        for (&rn, rec) in &records {
            if rec.is_dir || rn < FIRST_USER_RECORD {
                continue;
            }
            let path = match full_path(rn, &records, letter) {
                Some(p) => p,
                None => continue,
            };
            if path_under(&path, root) {
                entries.push(FileEntry {
                    path: PathBuf::from(path),
                    size: rec.size,
                    modified: rec.modified,
                });
            }
        }
        Ok(entries)
    }
}

/// The first non-reserved MFT record; records below this are NTFS metadata files.
const FIRST_USER_RECORD: u64 = 16;

struct Record {
    name: String,
    parent: u64,
    is_dir: bool,
    size: u64,
    modified: Option<SystemTime>,
}

struct NameRef {
    name: String,
    parent: u64,
}

fn best_name<T: Read + Seek>(file: &NtfsFile<'_>, fs: &mut T) -> Option<NameRef> {
    for ns in [
        Some(NtfsFileNamespace::Win32),
        Some(NtfsFileNamespace::Win32AndDos),
        None,
    ] {
        if let Some(Ok(name)) = file.name(fs, ns, None) {
            return Some(NameRef {
                name: name.name().to_string_lossy(),
                parent: name.parent_directory_reference().file_record_number(),
            });
        }
    }
    None
}

fn data_size<T: Read + Seek>(file: &NtfsFile<'_>, fs: &mut T) -> u64 {
    match file.data(fs, "") {
        Some(Ok(item)) => item.to_attribute().map(|a| a.value_length()).unwrap_or(0),
        _ => 0,
    }
}

fn record_count<T: Read + Seek>(ntfs: &Ntfs, fs: &mut T) -> Result<u64> {
    let mft = ntfs
        .file(fs, KnownNtfsFileRecordNumber::MFT as u64)
        .context("failed to read $MFT")?;
    let size = data_size(&mft, fs);
    let record_size = ntfs.file_record_size() as u64;
    if record_size == 0 {
        bail!("invalid MFT record size");
    }
    Ok(size / record_size)
}

/// Resolve a record's full path by walking parent references up to the root.
fn full_path(rn: u64, records: &HashMap<u64, Record>, letter: char) -> Option<String> {
    let root_rn = KnownNtfsFileRecordNumber::RootDirectory as u64;
    let mut parts: Vec<&str> = Vec::new();
    let mut cur = rn;
    let mut guard = 0;
    while cur != root_rn {
        let rec = records.get(&cur)?;
        parts.push(&rec.name);
        cur = rec.parent;
        guard += 1;
        if guard > 4096 {
            return None;
        }
    }
    parts.reverse();
    let mut path = format!("{letter}:\\");
    path.push_str(&parts.join("\\"));
    Some(path)
}

fn path_under(path: &str, root: &Path) -> bool {
    let p = path.to_lowercase();
    let r = root.to_string_lossy().to_lowercase();
    let r = r.trim_end_matches('\\');
    if r.len() <= 2 {
        return p.starts_with(r);
    }
    p == r || p.starts_with(&format!("{r}\\"))
}

fn drive_letter(root: &Path) -> Result<char> {
    match root.components().next() {
        Some(Component::Prefix(p)) => match p.kind() {
            Prefix::Disk(b) | Prefix::VerbatimDisk(b) => Ok((b as char).to_ascii_uppercase()),
            _ => bail!("not a drive-letter path"),
        },
        _ => bail!("path has no drive-letter prefix"),
    }
}

fn bytes_per_sector(letter: char) -> Result<u64> {
    let root: Vec<u16> = format!("{letter}:\\")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut bps: u32 = 0;
    unsafe {
        GetDiskFreeSpaceW(
            PCWSTR(root.as_ptr()),
            None,
            Some(&mut bps as *mut u32),
            None,
            None,
        )
        .context("GetDiskFreeSpaceW failed")?;
    }
    Ok(if bps == 0 { 512 } else { bps as u64 })
}

fn nt_to_system_time(time: NtfsTime) -> SystemTime {
    // NTFS timestamps are 100ns intervals since 1601-01-01; offset to the Unix epoch.
    const UNIX_OFFSET_SECS: u64 = 11_644_473_600;
    let intervals = time.nt_timestamp();
    let secs = intervals / 10_000_000;
    let nanos = ((intervals % 10_000_000) * 100) as u32;
    if secs < UNIX_OFFSET_SECS {
        UNIX_EPOCH
    } else {
        UNIX_EPOCH + Duration::new(secs - UNIX_OFFSET_SECS, nanos)
    }
}

/// Sector-aligned adapter so `ntfs` can seek/read arbitrary offsets on a raw
/// volume handle, which only permits reads aligned to the physical sector size.
struct SectorReader<T: Read + Seek> {
    inner: T,
    sector_size: u64,
    pos: u64,
    buf: Vec<u8>,
}

impl<T: Read + Seek> SectorReader<T> {
    fn new(inner: T, sector_size: u64) -> Self {
        SectorReader {
            inner,
            sector_size,
            pos: 0,
            buf: Vec::new(),
        }
    }
}

impl<T: Read + Seek> Read for SectorReader<T> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        let start = self.pos;
        let end = start + out.len() as u64;
        let aligned_start = start - (start % self.sector_size);
        let aligned_end = end.div_ceil(self.sector_size) * self.sector_size;
        self.buf.resize((aligned_end - aligned_start) as usize, 0);
        self.inner.seek(SeekFrom::Start(aligned_start))?;
        self.inner.read_exact(&mut self.buf)?;
        let offset = (start - aligned_start) as usize;
        out.copy_from_slice(&self.buf[offset..offset + out.len()]);
        self.pos = end;
        Ok(out.len())
    }
}

impl<T: Read + Seek> Seek for SectorReader<T> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.pos = match pos {
            SeekFrom::Start(n) => n,
            SeekFrom::Current(n) => (self.pos as i64 + n) as u64,
            SeekFrom::End(_) => self.inner.seek(pos)?,
        };
        Ok(self.pos)
    }
}
