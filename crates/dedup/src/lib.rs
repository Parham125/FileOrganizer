use fo_hasher::{hash_file, hash_partial, HashAlgo};
use fo_indexer::FileEntry;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

const PARTIAL_BYTES: usize = 8192;

/// A set of files with identical content.
#[derive(Debug, Clone, Serialize)]
pub struct DupGroup {
    pub hash: String,
    pub size: u64,
    pub paths: Vec<PathBuf>,
}

/// Staged duplicate finder: size -> partial hash -> full hash.
pub fn find_duplicates(
    entries: &[FileEntry],
    algo: HashAlgo,
    progress: impl Fn(usize, usize) + Sync,
) -> Vec<DupGroup> {
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
    let partials: Vec<(&FileEntry, String)> = partial_candidates
        .par_iter()
        .filter_map(|e| {
            hash_partial(&e.path, algo, PARTIAL_BYTES)
                .ok()
                .map(|h| (*e, h))
        })
        .collect();
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
    let total = full_candidates.len();
    let done = AtomicUsize::new(0);
    let fulls: Vec<(&FileEntry, String)> = full_candidates
        .par_iter()
        .filter_map(|e| {
            let out = hash_file(&e.path, algo).ok().map(|h| (*e, h));
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            progress(n, total);
            out
        })
        .collect();
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

    #[test]
    fn finds_identical_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"hello world contents").unwrap();
        fs::write(dir.path().join("b.txt"), b"hello world contents").unwrap();
        fs::write(dir.path().join("c.txt"), b"totally different here").unwrap();
        let entries = WalkdirSource.enumerate(dir.path()).unwrap();
        let groups = find_duplicates(&entries, HashAlgo::Blake3, |_, _| {});
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
        let groups = find_duplicates(&entries, HashAlgo::Blake3, |_, _| {});
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].paths.len(), 3);
    }
}
