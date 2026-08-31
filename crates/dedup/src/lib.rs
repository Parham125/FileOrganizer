use fo_hasher::{hash_file, hash_partial, HashAlgo};
use fo_indexer::FileEntry;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

mod names;
mod similar;
pub use names::{find_similar_names, NameGroup, NameMatch, NameStrategy};
pub use similar::{find_similar_images, perceptual_hash, SimilarFile, SimilarGroup, SimilarResult};

const PARTIAL_BYTES: usize = 8192;

/// How many readers hit the disk at once. A spinning disk (an external HDD)
/// collapses under concurrent readers seeking against each other, so it wants
/// `Sequential`; SSD/NVMe is faster with `Auto`, which is rayon across all cores.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ScanMode {
    #[default]
    Auto,
    Sequential,
}

impl ScanMode {
    /// "sequential" picks the single-reader path; anything else, including a
    /// missing label, is `Auto`.
    pub fn from_label(label: Option<&str>) -> ScanMode {
        match label {
            Some("sequential") => ScanMode::Sequential,
            _ => ScanMode::Auto,
        }
    }
}

/// A one-thread rayon pool for `Sequential`, so the existing parallel pipeline
/// runs unchanged but with a single reader. `None` means the global pool.
pub(crate) fn scan_pool(mode: ScanMode) -> Option<rayon::ThreadPool> {
    match mode {
        ScanMode::Auto => None,
        ScanMode::Sequential => rayon::ThreadPoolBuilder::new().num_threads(1).build().ok(),
    }
}

pub(crate) fn in_pool<T: Send>(
    pool: Option<&rayon::ThreadPool>,
    op: impl FnOnce() -> T + Send,
) -> T {
    match pool {
        Some(p) => p.install(op),
        None => op(),
    }
}

/// A set of files with identical content.
#[derive(Debug, Clone, Serialize)]
pub struct DupGroup {
    pub hash: String,
    pub size: u64,
    pub paths: Vec<PathBuf>,
}

/// Staged duplicate finder: size -> partial hash -> full hash.
///
/// Returns early with whatever full-hash groups were already complete when
/// `cancel` is raised; callers tell "cancelled" from "finished" by reading the
/// flag afterwards, not from the returned groups.
///
/// `unreadable` counts files that could not be read at all (an unplugged drive,
/// a permission wall, a file deleted since it was indexed). Those files are left
/// out of the groups, and without the count the scan would under-report
/// duplicates with nothing to show for it.
pub fn find_duplicates(
    entries: &[FileEntry],
    algo: HashAlgo,
    mode: ScanMode,
    cancel: &AtomicBool,
    unreadable: &AtomicUsize,
    progress: impl Fn(usize, usize) + Sync,
) -> Vec<DupGroup> {
    let pool = scan_pool(mode);
    let mut by_size: HashMap<u64, Vec<&FileEntry>> = HashMap::new();
    for e in entries {
        by_size.entry(e.size).or_default().push(e);
    }
    // Stage 2: partial hash within each non-singleton size group.
    let mut partial_candidates: Vec<&FileEntry> = Vec::new();
    for group in by_size.values() {
        if group.len() > 1 {
            partial_candidates.extend(group.iter().copied());
        }
    }
    // Read in directory order instead of HashMap order: a spinning disk pays a
    // seek for every jump between unrelated directories.
    partial_candidates.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    let partials: Vec<(&FileEntry, String)> = in_pool(pool.as_ref(), || {
        partial_candidates
            .par_iter()
            .filter_map(|e| {
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
                match hash_partial(&e.path, algo, PARTIAL_BYTES) {
                    Ok(h) => Some((*e, h)),
                    Err(_) => {
                        unreadable.fetch_add(1, Ordering::Relaxed);
                        None
                    }
                }
            })
            .collect()
    });
    // Nothing has been fully hashed yet, so there is no partial result to keep.
    if cancel.load(Ordering::Relaxed) {
        return Vec::new();
    }
    let mut by_partial: HashMap<(u64, String), Vec<&FileEntry>> = HashMap::new();
    for (e, h) in partials {
        by_partial.entry((e.size, h)).or_default().push(e);
    }
    // Stage 3: full hash within each surviving partial sub-group.
    let mut full_candidates: Vec<&FileEntry> = Vec::new();
    for group in by_partial.values() {
        if group.len() > 1 {
            full_candidates.extend(group.iter().copied());
        }
    }
    full_candidates.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    let total = full_candidates.len();
    let done = AtomicUsize::new(0);
    let fulls: Vec<(&FileEntry, String)> = in_pool(pool.as_ref(), || {
        full_candidates
            .par_iter()
            .filter_map(|e| {
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
                // a file that failed the partial stage never gets here, so this
                // cannot double-count the same file
                let out = match hash_file(&e.path, algo) {
                    Ok(h) => Some((*e, h)),
                    Err(_) => {
                        unreadable.fetch_add(1, Ordering::Relaxed);
                        None
                    }
                };
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                progress(n, total);
                out
            })
            .collect()
    });
    let mut by_full: HashMap<(u64, String), Vec<&FileEntry>> = HashMap::new();
    for (e, h) in fulls {
        by_full.entry((e.size, h)).or_default().push(e);
    }
    let mut groups: Vec<DupGroup> = by_full
        .into_iter()
        .filter(|(_, v)| v.len() > 1)
        .map(|((size, hash), v)| DupGroup {
            hash,
            size,
            paths: v.iter().map(|e| e.path.clone()).collect(),
        })
        .collect();
    groups.sort_by(|a, b| {
        let wa = a.size * (a.paths.len() as u64 - 1);
        let wb = b.size * (b.paths.len() as u64 - 1);
        wb.cmp(&wa)
    });
    groups
}

#[cfg(test)]
mod tests {
    use super::*;
    use fo_indexer::{FileSource, WalkdirSource};
    use std::fs;

    fn run(entries: &[FileEntry], mode: ScanMode) -> Vec<DupGroup> {
        find_duplicates(
            entries,
            HashAlgo::Blake3,
            mode,
            &AtomicBool::new(false),
            &AtomicUsize::new(0),
            |_, _| {},
        )
    }

    #[test]
    fn finds_identical_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"hello world contents").unwrap();
        fs::write(dir.path().join("b.txt"), b"hello world contents").unwrap();
        fs::write(dir.path().join("c.txt"), b"totally different here").unwrap();
        let entries = WalkdirSource.enumerate(dir.path()).unwrap();
        let groups = run(&entries, ScanMode::Auto);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].paths.len(), 2);
        let mut names: Vec<String> = groups[0]
            .paths
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.txt", "b.txt"]);
        // add a third identical file -> group of 3
        fs::write(dir.path().join("d.txt"), b"hello world contents").unwrap();
        let entries = WalkdirSource.enumerate(dir.path()).unwrap();
        let groups = run(&entries, ScanMode::Auto);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].paths.len(), 3);
        // the one-reader path has to produce exactly the same answer
        let seq = run(&entries, ScanMode::Sequential);
        assert_eq!(seq.len(), 1);
        assert_eq!(seq[0].paths.len(), 3);
        assert_eq!(seq[0].hash, groups[0].hash);
    }

    #[test]
    fn cancelled_scan_returns_no_groups() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"hello world contents").unwrap();
        fs::write(dir.path().join("b.txt"), b"hello world contents").unwrap();
        let entries = WalkdirSource.enumerate(dir.path()).unwrap();
        let cancel = AtomicBool::new(true);
        let groups = find_duplicates(
            &entries,
            HashAlgo::Blake3,
            ScanMode::Sequential,
            &cancel,
            &AtomicUsize::new(0),
            |_, _| {},
        );
        assert!(
            groups.is_empty(),
            "a cancelled scan must not look like a clean finish"
        );
    }

    #[test]
    fn counts_unreadable_files_and_still_groups_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"hello world contents").unwrap();
        fs::write(dir.path().join("b.txt"), b"hello world contents").unwrap();
        // two more of a second size, so the size stage keeps them as candidates
        fs::write(dir.path().join("gone1.txt"), b"vanishing pair contents").unwrap();
        fs::write(dir.path().join("gone2.txt"), b"vanishing pair contents").unwrap();
        let entries = WalkdirSource.enumerate(dir.path()).unwrap();
        // stand in for an unplugged drive: the index rows survive, the files do not
        fs::remove_file(dir.path().join("gone1.txt")).unwrap();
        fs::remove_file(dir.path().join("gone2.txt")).unwrap();
        let unreadable = AtomicUsize::new(0);
        let groups = find_duplicates(
            &entries,
            HashAlgo::Blake3,
            ScanMode::Sequential,
            &AtomicBool::new(false),
            &unreadable,
            |_, _| {},
        );
        assert_eq!(unreadable.load(Ordering::Relaxed), 2);
        assert_eq!(groups.len(), 1, "the reachable pair still groups");
        assert_eq!(groups[0].paths.len(), 2);
        let mut names: Vec<String> = groups[0]
            .paths
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.txt", "b.txt"]);
    }
}
