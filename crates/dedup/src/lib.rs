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

/// A set of byte-identical files found by `verify_exact`.
#[derive(Debug, Clone, Serialize)]
pub struct ExactGroup {
    pub hash: String,
    pub size: u64,
    pub paths: Vec<PathBuf>,
}

/// The answer to "are these actually the same file?" for one hand-picked set.
///
/// `groups` holds the sets that matched byte for byte, `unique` the files that
/// were compared and matched nothing, `unreadable` the ones that could not be
/// read at all. A set can split: three same-named files where two match and one
/// differs gives one group of 2 plus one unique, which is why this is not a
/// boolean. `compared == 0` means nothing was looked at, a different answer from
/// "everything was looked at and nothing matched".
///
/// `bytes_hashed` is bytes actually read off the disk: the partial reads of the
/// files the partial stage ruled out as well as the whole files the last stage
/// read. Only the files settled by size alone contribute nothing, because those
/// are the only ones never opened.
#[derive(Debug, Clone, Serialize)]
pub struct ExactCheck {
    pub groups: Vec<ExactGroup>,
    pub unique: Vec<PathBuf>,
    pub unreadable: Vec<PathBuf>,
    pub compared: usize,
    pub bytes_hashed: u64,
    pub cancelled: bool,
}

/// The same staged comparison `find_duplicates` runs (size -> partial hash ->
/// full hash), over one small hand-picked set instead of a whole index.
///
/// Sizes are read from the disk now, not taken from the index: the point of this
/// pass is to check the files as they are, so a file that moved or was replaced
/// since it was indexed shows up as it is today. A file that cannot be stat'd or
/// hashed lands in `unreadable` rather than being dropped, because an unplugged
/// drive has to be sayable.
pub fn verify_exact(
    paths: &[PathBuf],
    algo: HashAlgo,
    mode: ScanMode,
    cancel: &AtomicBool,
) -> ExactCheck {
    // An empty set has no verdict in it. Callers are expected to refuse one up
    // front rather than show "0 files compared" as if a check had run, so this
    // returns without building a pool or touching the disk.
    if paths.is_empty() {
        return ExactCheck {
            groups: Vec::new(),
            unique: Vec::new(),
            unreadable: Vec::new(),
            compared: 0,
            bytes_hashed: 0,
            cancelled: false,
        };
    }
    let pool = scan_pool(mode);
    let mut unreadable: Vec<PathBuf> = Vec::new();
    let mut bytes_hashed = 0u64;
    let mut sized: Vec<(PathBuf, u64)> = Vec::new();
    for p in paths {
        match std::fs::metadata(p) {
            Ok(m) if m.is_file() => sized.push((p.clone(), m.len())),
            // a directory or a symlink to nothing is no more comparable than an
            // unplugged drive, so it is reported the same way
            _ => unreadable.push(p.clone()),
        }
    }
    if cancel.load(Ordering::Relaxed) {
        return ExactCheck {
            groups: Vec::new(),
            unique: Vec::new(),
            unreadable,
            compared: 0,
            bytes_hashed: 0,
            cancelled: true,
        };
    }
    // Stage 1: size. A size that nothing else in the set shares is settled here
    // without reading a byte.
    let mut by_size: HashMap<u64, Vec<&(PathBuf, u64)>> = HashMap::new();
    for s in &sized {
        by_size.entry(s.1).or_default().push(s);
    }
    let mut unique: Vec<PathBuf> = Vec::new();
    let mut partial_candidates: Vec<&(PathBuf, u64)> = Vec::new();
    for group in by_size.values() {
        if group.len() > 1 {
            partial_candidates.extend(group.iter().copied());
        } else {
            unique.push(group[0].0.clone());
        }
    }
    partial_candidates.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    // Stage 2: partial hash of the first and last 8 KiB.
    let partials: Vec<(&(PathBuf, u64), Option<String>)> = in_pool(pool.as_ref(), || {
        partial_candidates
            .par_iter()
            .map(|s| (*s, hash_partial(&s.0, algo, PARTIAL_BYTES).ok()))
            .collect()
    });
    let mut by_partial: HashMap<(u64, String), Vec<&(PathBuf, u64)>> = HashMap::new();
    for (s, h) in partials {
        match h {
            Some(h) => {
                // hash_partial reads the whole file when it is smaller than the
                // two windows, so this is what came off the disk, not a cap.
                bytes_hashed += s.1.min(2 * PARTIAL_BYTES as u64);
                by_partial.entry((s.1, h)).or_default().push(s);
            }
            None => unreadable.push(s.0.clone()),
        }
    }
    if cancel.load(Ordering::Relaxed) {
        return ExactCheck {
            groups: Vec::new(),
            unique: Vec::new(),
            unreadable,
            compared: 0,
            bytes_hashed: 0,
            cancelled: true,
        };
    }
    let mut full_candidates: Vec<&(PathBuf, u64)> = Vec::new();
    for group in by_partial.values() {
        if group.len() > 1 {
            full_candidates.extend(group.iter().copied());
        } else {
            unique.push(group[0].0.clone());
        }
    }
    full_candidates.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    // Stage 3: full hash. Two files can share a size and both 8 KiB ends and
    // still differ in the middle, so only this stage proves a match.
    // This is the only stage that reads whole files, so it is the one a user
    // stops. Without the check here a set of large videos on a spinning disk
    // ignores Cancel until it finishes.
    let fulls: Vec<(&(PathBuf, u64), Option<String>)> = in_pool(pool.as_ref(), || {
        full_candidates
            .par_iter()
            .map(|s| {
                if cancel.load(Ordering::Relaxed) {
                    return (*s, None);
                }
                (*s, hash_file(&s.0, algo).ok())
            })
            .collect()
    });
    // A skipped file is not an unreadable one, so a stopped run reports nothing
    // rather than blaming the files it never got to.
    if cancel.load(Ordering::Relaxed) {
        return ExactCheck {
            groups: Vec::new(),
            unique: Vec::new(),
            unreadable,
            compared: 0,
            bytes_hashed: 0,
            cancelled: true,
        };
    }
    let mut by_full: HashMap<(u64, String), Vec<&(PathBuf, u64)>> = HashMap::new();
    for (s, h) in fulls {
        match h {
            Some(h) => {
                bytes_hashed += s.1;
                by_full.entry((s.1, h)).or_default().push(s);
            }
            None => unreadable.push(s.0.clone()),
        }
    }
    let mut groups: Vec<ExactGroup> = Vec::new();
    for ((size, hash), v) in by_full {
        if v.len() > 1 {
            let mut paths: Vec<PathBuf> = v.iter().map(|s| s.0.clone()).collect();
            paths.sort();
            groups.push(ExactGroup { hash, size, paths });
        } else {
            unique.push(v[0].0.clone());
        }
    }
    groups.sort_by(|a, b| b.paths.len().cmp(&a.paths.len()).then(a.hash.cmp(&b.hash)));
    unique.sort();
    unreadable.sort();
    let compared = groups.iter().map(|g| g.paths.len()).sum::<usize>() + unique.len();
    ExactCheck {
        groups,
        unique,
        unreadable,
        compared,
        bytes_hashed,
        // Every real cancellation returns above this line. Reaching here means
        // the comparison finished, so the answer stands even if Stop was pressed
        // in the moment after the last hash landed.
        cancelled: false,
    }
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

    fn check(paths: &[PathBuf]) -> ExactCheck {
        verify_exact(
            paths,
            HashAlgo::Blake3,
            ScanMode::Sequential,
            &AtomicBool::new(false),
        )
    }

    #[test]
    fn verifies_an_identical_pair() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("invoice.pdf");
        let b = dir.path().join("invoice (1).pdf");
        fs::write(&a, b"same bytes on both sides").unwrap();
        fs::write(&b, b"same bytes on both sides").unwrap();
        let out = check(&[a.clone(), b.clone()]);
        assert_eq!(out.groups.len(), 1);
        assert_eq!(out.groups[0].paths, vec![b, a]);
        assert_eq!(out.groups[0].size, 24);
        assert!(out.unique.is_empty());
        assert!(out.unreadable.is_empty());
        assert_eq!(out.compared, 2);
        // both were read twice: 24 bytes each at the partial stage, then in full
        assert_eq!(out.bytes_hashed, 96);
        assert!(!out.cancelled);
    }

    #[test]
    fn a_set_can_split_into_a_pair_and_a_loner() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("report.txt");
        let b = dir.path().join("report (1).txt");
        let c = dir.path().join("report (2).txt");
        fs::write(&a, b"matching contents here").unwrap();
        fs::write(&b, b"matching contents here").unwrap();
        fs::write(&c, b"a different file entirely, longer too").unwrap();
        let out = check(&[a.clone(), b.clone(), c.clone()]);
        assert_eq!(out.groups.len(), 1, "the pair matches, the loner does not");
        assert_eq!(out.groups[0].paths.len(), 2);
        assert_eq!(out.unique, vec![c]);
        assert_eq!(out.compared, 3);
        // the loner drops out at the size stage, so only the pair is ever opened
        assert_eq!(out.bytes_hashed, 88);
    }

    #[test]
    fn same_size_different_bytes_survives_to_the_full_hash() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("clip.bin");
        let b = dir.path().join("clip (1).bin");
        // identical ends, one byte apart in the middle: the size stage and the
        // first+last 8 KiB partial both pass, only the full hash separates them
        let left = vec![7u8; 40_000];
        let mut right = left.clone();
        right[20_000] = 9;
        fs::write(&a, &left).unwrap();
        fs::write(&b, &right).unwrap();
        assert_eq!(
            hash_partial(&a, HashAlgo::Blake3, PARTIAL_BYTES).unwrap(),
            hash_partial(&b, HashAlgo::Blake3, PARTIAL_BYTES).unwrap(),
            "the test file pair must be indistinguishable before the full hash"
        );
        let out = check(&[a.clone(), b.clone()]);
        assert!(
            out.groups.is_empty(),
            "same name and same size is not the same file"
        );
        assert_eq!(out.unique, vec![b, a]);
        assert_eq!(out.compared, 2);
        // 16 KiB of each at the partial stage, then both files end to end
        assert_eq!(out.bytes_hashed, 112_768, "both were read all the way");
    }

    #[test]
    fn a_deleted_file_lands_in_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("photo.jpg");
        let b = dir.path().join("photo (1).jpg");
        let gone = dir.path().join("photo (2).jpg");
        fs::write(&a, b"picture bytes right here").unwrap();
        fs::write(&b, b"picture bytes right here").unwrap();
        fs::write(&gone, b"picture bytes right here").unwrap();
        // stand in for an unplugged drive: the name group still lists it
        fs::remove_file(&gone).unwrap();
        let out = check(&[a.clone(), b.clone(), gone.clone()]);
        assert_eq!(out.unreadable, vec![gone]);
        assert_eq!(out.groups.len(), 1);
        assert_eq!(out.groups[0].paths.len(), 2);
        assert_eq!(out.compared, 2, "the missing file was never compared");
    }

    #[test]
    fn a_file_ruled_out_by_the_partial_hash_still_counts_as_read() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.bin");
        let b = dir.path().join("b.bin");
        // same size, different first byte: the partial stage settles both, so
        // neither is ever read in full
        let left = vec![7u8; 40_000];
        let mut right = left.clone();
        right[0] = 9;
        fs::write(&a, &left).unwrap();
        fs::write(&b, &right).unwrap();
        let out = check(&[a.clone(), b.clone()]);
        assert!(out.groups.is_empty());
        assert_eq!(out.unique, vec![a, b]);
        assert_eq!(out.compared, 2);
        assert_eq!(
            out.bytes_hashed, 32_768,
            "16 KiB came off the disk for each of them"
        );
    }

    #[test]
    fn files_settled_by_size_alone_are_never_opened() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        fs::write(&a, b"short").unwrap();
        fs::write(&b, b"a good deal longer than the other one").unwrap();
        let out = check(&[a, b]);
        assert_eq!(out.compared, 2);
        assert_eq!(out.bytes_hashed, 0);
    }

    #[test]
    fn an_empty_set_reads_nothing_and_is_not_a_cancellation() {
        let out = check(&[]);
        assert!(out.groups.is_empty());
        assert!(out.unique.is_empty());
        assert!(out.unreadable.is_empty());
        assert_eq!(out.compared, 0);
        assert_eq!(out.bytes_hashed, 0);
        assert!(!out.cancelled, "nothing asked for is not a stopped run");
    }

    #[test]
    fn a_cancelled_check_does_not_look_finished() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        fs::write(&a, b"same bytes on both sides").unwrap();
        fs::write(&b, b"same bytes on both sides").unwrap();
        let out = verify_exact(
            &[a, b],
            HashAlgo::Blake3,
            ScanMode::Sequential,
            &AtomicBool::new(true),
        );
        assert!(out.cancelled);
        assert!(out.groups.is_empty());
        assert_eq!(out.compared, 0);
    }
}
