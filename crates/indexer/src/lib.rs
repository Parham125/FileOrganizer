use anyhow::Result;
use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher};
use std::path::{Path, PathBuf};
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

/// Cross-platform recursive walker backed by the `walkdir` crate.
pub struct WalkdirSource;

impl FileSource for WalkdirSource {
    fn enumerate(&self, root: &Path) -> Result<Vec<FileEntry>> {
        let mut entries = Vec::new();
        for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
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

// TODO(v2, windows): MftSource fast path

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
