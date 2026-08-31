use anyhow::Result;
use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;
use walkdir::WalkDir;

#[derive(Debug, Clone)]
pub struct FileEntry {
    pub path: PathBuf,
    pub size: u64,
    pub modified: Option<SystemTime>,
}

/// A source that enumerates files under a root directory.
pub trait FileSource {
    fn enumerate(&self, root: &Path) -> Result<Vec<FileEntry>>;
}

/// The app's own per-volume quarantine. Walking into it would re-discover every
/// file the user has trashed: they would come back in search results, and a
/// duplicate scan would pair a surviving file with its own trashed copy and
/// report it as a duplicate all over again.
pub const QUARANTINE_DIR: &str = ".FileOrganizer-Trash";

/// Extra directories to skip, set once at startup (the app data dir, which holds
/// the fallback quarantine and the databases).
static EXCLUDED: OnceLock<Vec<PathBuf>> = OnceLock::new();

/// Register directories that enumeration must never descend into. Call once,
/// before any indexing; later calls are ignored.
pub fn set_excluded_roots(roots: Vec<PathBuf>) {
    let _ = EXCLUDED.set(roots);
}

fn is_excluded(path: &Path) -> bool {
    if path
        .file_name()
        .is_some_and(|n| n == std::ffi::OsStr::new(QUARANTINE_DIR))
    {
        return true;
    }
    EXCLUDED
        .get()
        .is_some_and(|roots| roots.iter().any(|r| path.starts_with(r)))
}

/// Cross-platform recursive walker backed by the `walkdir` crate.
pub struct WalkdirSource;

impl FileSource for WalkdirSource {
    fn enumerate(&self, root: &Path) -> Result<Vec<FileEntry>> {
        let mut entries = Vec::new();
        let walk = WalkDir::new(root)
            .into_iter()
            .filter_entry(|e| !(e.file_type().is_dir() && is_excluded(e.path())));
        for entry in walk.filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            entries.push(FileEntry {
                path: entry.into_path(),
                size: meta.len(),
                modified: meta.modified().ok(),
            });
        }
        Ok(entries)
    }
}

#[cfg(target_os = "windows")]
mod mft;
#[cfg(target_os = "windows")]
pub use mft::MftSource;

/// Enumerate `root` with the fastest available source.
///
/// On Windows this tries the NTFS MFT fast path and falls back to `WalkdirSource`
/// on any error (non-NTFS volume, no admin, unsupported path). Every other OS uses
/// `WalkdirSource` directly.
pub fn enumerate_best(root: &Path) -> Result<Vec<FileEntry>> {
    #[cfg(target_os = "windows")]
    {
        match MftSource.enumerate(root) {
            Ok(entries) => return Ok(entries),
            Err(e) => eprintln!("MFT enumeration failed, falling back to walkdir: {e}"),
        }
    }
    WalkdirSource.enumerate(root)
}

/// A simplified filesystem change, flattened from the backend's raw events.
#[derive(Debug, Clone)]
pub enum ChangeEvent {
    Created(PathBuf),
    Modified(PathBuf),
    Removed(PathBuf),
    Renamed { from: PathBuf, to: PathBuf },
}

/// Filesystem change watcher backed by the `notify` crate (FSEvents on macOS).
pub struct Watcher {
    #[allow(dead_code)]
    inner: RecommendedWatcher,
}

impl Watcher {
    /// Start watching `path` recursively, invoking `callback` for each change.
    pub fn watch<F>(path: &Path, callback: F) -> Result<Watcher>
    where
        F: Fn(ChangeEvent) + Send + 'static,
    {
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                let event = match res {
                    Ok(e) => e,
                    Err(_) => return,
                };
                match event.kind {
                    EventKind::Create(_) => {
                        for p in event.paths {
                            callback(ChangeEvent::Created(p));
                        }
                    }
                    EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
                        if event.paths.len() == 2 {
                            callback(ChangeEvent::Renamed {
                                from: event.paths[0].clone(),
                                to: event.paths[1].clone(),
                            });
                        }
                    }
                    EventKind::Modify(_) => {
                        for p in event.paths {
                            callback(ChangeEvent::Modified(p));
                        }
                    }
                    EventKind::Remove(_) => {
                        for p in event.paths {
                            callback(ChangeEvent::Removed(p));
                        }
                    }
                    _ => {}
                }
            })?;
        watcher.watch(path, RecursiveMode::Recursive)?;
        Ok(Watcher { inner: watcher })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn walking_skips_the_apps_own_quarantine() {
        let dir = tempfile::tempdir().unwrap();
        let keep = dir.path().join("photo.jpg");
        fs::write(&keep, b"same bytes").unwrap();
        // a trashed copy, exactly where the per-volume quarantine puts it
        let quarantine = dir.path().join(QUARANTINE_DIR).join("op1");
        fs::create_dir_all(&quarantine).unwrap();
        fs::write(quarantine.join("abc_photo.jpg"), b"same bytes").unwrap();
        let entries = WalkdirSource.enumerate(dir.path()).unwrap();
        // without the skip these two identical files pair up and the file the
        // user already trashed is offered to them as a duplicate again
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert_eq!(entries[0].path, keep);
    }
}
