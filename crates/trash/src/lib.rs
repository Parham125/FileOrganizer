use anyhow::{anyhow, Result};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Walking a directory to size it stops here, so a pathological tree cannot
/// stall an operation. The sum is then a floor, not an exact total.
const WALK_LIMIT: usize = 100_000;

/// Per-volume quarantine directory, sitting on the root of the drive the file
/// already lives on, exactly as macOS (`.Trashes`) and Windows (`$Recycle.Bin`)
/// do. Trashing is then a rename on that drive instead of a copy across to the
/// system disk, which is both instant and free of system-disk space.
const VOLUME_TRASH_DIR: &str = ".FileOrganizer-Trash";

/// A quarantined file or folder that can be restored or purged.
#[derive(Debug, Clone, Serialize)]
pub struct TrashItem {
    pub id: String,
    pub op_id: String,
    pub original_path: String,
    #[serde(skip_serializing)]
    pub stored_path: String,
    pub size: i64,
    pub deleted_ns: i64,
    pub reason: Option<String>,
    pub restored: bool,
    pub is_dir: bool,
}

/// Something the operation deliberately did not touch, and why.
#[derive(Debug, Clone, Serialize)]
pub struct SkippedItem {
    pub path: String,
    pub reason: String,
}

/// One batch operation (delete or move) grouping many items.
#[derive(Debug, Clone, Serialize)]
pub struct TrashOp {
    pub id: String,
    pub items: Vec<TrashItem>,
    pub skipped: Vec<SkippedItem>,
}

/// Quarantine store + undo journal backed by its own SQLite DB.
pub struct Trash {
    conn: Connection,
    trash_root: PathBuf,
}

impl Trash {
    pub fn open(data_dir: &Path) -> Result<Trash> {
        let trash_root = data_dir.join("trash");
        fs::create_dir_all(&trash_root)?;
        let conn = Connection::open(data_dir.join("trash.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS operations (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                created_ns INTEGER NOT NULL,
                note TEXT
            );
            CREATE TABLE IF NOT EXISTS trash_items (
                id TEXT PRIMARY KEY,
                op_id TEXT NOT NULL REFERENCES operations(id),
                original_path TEXT NOT NULL,
                stored_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                deleted_ns INTEGER NOT NULL,
                reason TEXT,
                restored INTEGER NOT NULL DEFAULT 0,
                is_dir INTEGER NOT NULL DEFAULT 0
            );",
        )?;
        // DBs created before folder support lack is_dir; add it once, in place.
        let has_is_dir = conn
            .prepare("SELECT 1 FROM pragma_table_info('trash_items') WHERE name = 'is_dir'")?
            .exists([])?;
        if !has_is_dir {
            conn.execute(
                "ALTER TABLE trash_items ADD COLUMN is_dir INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        Ok(Trash { conn, trash_root })
    }

    /// True only if `p` sits inside a quarantine this app owns: the app-data
    /// trash, or a `.FileOrganizer-Trash` on the root of the volume that still
    /// holds `p`. An arbitrary path is never accepted, so a folder a user
    /// happened to name `.FileOrganizer-Trash` halfway down a tree is refused
    /// along with everything else. Stored paths for move/organize ops point at
    /// real user files and match neither, so purge must never touch them.
    fn is_in_quarantine(&self, p: &Path) -> bool {
        // `ancestors()` reads a path literally, so ".." would let a crafted
        // journal row point back out of a quarantine directory and have us
        // delete something outside it. Paths we write never contain "..".
        if p.components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return false;
        }
        if p != self.trash_root && p.starts_with(&self.trash_root) {
            return true;
        }
        match volume_quarantine(p).and_then(|q| q.parent()) {
            Some(vr) => volume_root(p).is_some_and(|v| v == vr),
            None => false,
        }
    }

    pub fn trash_files(
        &self,
        paths: &[PathBuf],
        reason: &str,
        note: Option<&str>,
    ) -> Result<TrashOp> {
        let op_id = nanoid::nanoid!(20);
        let now = now_ns();
        let app_op_dir = self.trash_root.join(&op_id);
        fs::create_dir_all(&app_op_dir)?;
        let trash_vol = volume_root(&self.trash_root);
        self.conn.execute(
            "INSERT INTO operations (id, kind, created_ns, note) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![op_id, "delete", now, note],
        )?;
        let mut items = Vec::new();
        let mut skipped = Vec::new();
        for path in paths {
            let meta = match fs::metadata(path) {
                Ok(m) => m,
                Err(_) => {
                    skipped.push(skip(path, "source no longer exists"));
                    continue;
                }
            };
            let is_dir = meta.is_dir();
            if !is_dir && !meta.is_file() {
                skipped.push(skip(path, "not a file or folder"));
                continue;
            }
            let filename = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_string());
            let size = if is_dir {
                dir_size(path)
            } else {
                meta.len() as i64
            };
            // Quarantine on the file's own drive when that is not the app-data
            // one: the move stays a rename instead of copying the whole file
            // across to the system disk.
            let vol = volume_root(path);
            let mut op_dir = app_op_dir.clone();
            let mut cross_volume = false;
            match &vol {
                Some(v) if trash_vol.as_ref() != Some(v) => {
                    let per_volume = v.join(VOLUME_TRASH_DIR).join(&op_id);
                    // read-only media or a permission wall lands here, and the
                    // app-data trash takes over
                    if fs::create_dir_all(&per_volume).is_ok() {
                        op_dir = per_volume;
                    } else {
                        cross_volume = true;
                    }
                }
                None => cross_volume = trash_vol.is_some(),
                _ => {}
            }
            // The fallback copies rather than renames, so refuse up front when
            // the system disk cannot hold the file instead of failing mid-copy.
            // A check that cannot run at all is simply not run.
            if cross_volume && !is_dir {
                if let Some(free) = free_space(&self.trash_root) {
                    if size as u64 > free {
                        skipped.push(skip(
                            path,
                            &format!(
                                "needs {}, only {} free on the app's disk",
                                human_bytes(size as u64),
                                human_bytes(free)
                            ),
                        ));
                        continue;
                    }
                }
            }
            let stored_name = format!("{}_{}", nanoid::nanoid!(20), filename);
            let stored_path = op_dir.join(&stored_name);
            if move_path(path, &stored_path, is_dir).is_err() {
                skipped.push(skip(
                    path,
                    if is_dir {
                        "could not move across volumes"
                    } else {
                        "could not be moved"
                    },
                ));
                continue;
            }
            let id = nanoid::nanoid!(20);
            let original = path.to_string_lossy().to_string();
            if self
                .conn
                .execute(
                    "INSERT INTO trash_items
                 (id, op_id, original_path, stored_path, size, deleted_ns, reason, restored, is_dir)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)",
                    rusqlite::params![
                        id,
                        op_id,
                        original,
                        stored_path.to_string_lossy().to_string(),
                        size,
                        now,
                        reason,
                        is_dir as i64
                    ],
                )
                .is_err()
            {
                if move_path(&stored_path, path, is_dir).is_err() {
                    return Err(anyhow!(
                        "journal insert failed and file could not be restored, stranded at {}",
                        stored_path.display()
                    ));
                }
                skipped.push(skip(path, "journal write failed"));
                continue;
            }
            items.push(TrashItem {
                id,
                op_id: op_id.clone(),
                original_path: original,
                stored_path: stored_path.to_string_lossy().to_string(),
                size,
                deleted_ns: now,
                reason: Some(reason.to_string()),
                restored: false,
                is_dir,
            });
        }
        Ok(TrashOp {
            id: op_id,
            items,
            skipped,
        })
    }

    /// Apply a batch of moves as one reversible operation. Never overwrites; a
    /// mid-move failure skips that entry, records why in `skipped`, and keeps
    /// going. Undo puts each item back. Folders move whole or not at all.
    pub fn apply_moves(&self, moves: &[(PathBuf, PathBuf)], kind: &str) -> Result<TrashOp> {
        let op_id = nanoid::nanoid!(20);
        let now = now_ns();
        self.conn.execute(
            "INSERT INTO operations (id, kind, created_ns, note) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![op_id, kind, now, Option::<String>::None],
        )?;
        let mut items = Vec::new();
        let mut skipped = Vec::new();
        for (from, to) in moves {
            if from == to {
                continue;
            }
            let meta = match fs::metadata(from) {
                Ok(m) => m,
                Err(_) => {
                    skipped.push(skip(from, "source no longer exists"));
                    continue;
                }
            };
            let is_dir = meta.is_dir();
            if !is_dir && !meta.is_file() {
                skipped.push(skip(from, "not a file or folder"));
                continue;
            }
            if let Some(parent) = to.parent() {
                if fs::create_dir_all(parent).is_err() {
                    skipped.push(skip(from, "destination could not be created"));
                    continue;
                }
            }
            let actual_to = if to.exists() {
                unique_path(to, is_dir)
            } else {
                to.clone()
            };
            let size = if is_dir {
                dir_size(from)
            } else {
                meta.len() as i64
            };
            if move_path(from, &actual_to, is_dir).is_err() {
                skipped.push(skip(
                    from,
                    if is_dir {
                        "could not move across volumes"
                    } else {
                        "could not be moved"
                    },
                ));
                continue;
            }
            let id = nanoid::nanoid!(20);
            let original = from.to_string_lossy().to_string();
            let stored = actual_to.to_string_lossy().to_string();
            if self
                .conn
                .execute(
                    "INSERT INTO trash_items
                 (id, op_id, original_path, stored_path, size, deleted_ns, reason, restored, is_dir)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)",
                    rusqlite::params![id, op_id, original, stored, size, now, kind, is_dir as i64],
                )
                .is_err()
            {
                if move_path(&actual_to, from, is_dir).is_err() {
                    return Err(anyhow!(
                        "journal insert failed and move could not be reverted, stranded at {}",
                        actual_to.display()
                    ));
                }
                skipped.push(skip(from, "journal write failed"));
                continue;
            }
            items.push(TrashItem {
                id,
                op_id: op_id.clone(),
                original_path: original,
                stored_path: stored,
                size,
                deleted_ns: now,
                reason: Some(kind.to_string()),
                restored: false,
                is_dir,
            });
        }
        Ok(TrashOp {
            id: op_id,
            items,
            skipped,
        })
    }

    /// Restore one item, returning (target where it now is, previous stored path).
    pub fn restore_item(&self, item_id: &str) -> Result<(PathBuf, PathBuf)> {
        let (original, stored, is_dir): (String, String, bool) = self.conn.query_row(
            "SELECT original_path, stored_path, is_dir FROM trash_items WHERE id = ?1 AND restored = 0",
            [item_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
        )?;
        let target =
            self.restore_move(&PathBuf::from(&stored), &PathBuf::from(&original), is_dir)?;
        self.conn.execute(
            "UPDATE trash_items SET restored = 1 WHERE id = ?1",
            [item_id],
        )?;
        Ok((target, PathBuf::from(stored)))
    }

    pub fn restore_op(&self, op_id: &str) -> Result<Vec<(PathBuf, PathBuf)>> {
        let ids: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare("SELECT id FROM trash_items WHERE op_id = ?1 AND restored = 0")?;
            let rows = stmt.query_map([op_id], |r| r.get(0))?;
            rows.collect::<Result<Vec<String>, _>>()?
        };
        let mut restored = Vec::new();
        for id in ids {
            restored.push(self.restore_item(&id)?);
        }
        Ok(restored)
    }

    pub fn undo_last(&self) -> Result<Vec<(PathBuf, PathBuf)>> {
        let op_id: String = self
            .conn
            .query_row(
                "SELECT o.id FROM operations o
                 JOIN trash_items t ON t.op_id = o.id
                 WHERE t.restored = 0
                 ORDER BY o.created_ns DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .map_err(|_| anyhow!("nothing to undo"))?;
        self.restore_op(&op_id)
    }

    /// List journal items, newest first. `kind` filters by operation kind
    /// ("delete", "organize", ...); `None` returns every kind.
    pub fn list(&self, kind: Option<&str>, limit: i64) -> Result<Vec<TrashItem>> {
        let map = |r: &rusqlite::Row| -> rusqlite::Result<TrashItem> {
            Ok(TrashItem {
                id: r.get(0)?,
                op_id: r.get(1)?,
                original_path: r.get(2)?,
                stored_path: r.get(3)?,
                size: r.get(4)?,
                deleted_ns: r.get(5)?,
                reason: r.get(6)?,
                restored: r.get::<_, i64>(7)? != 0,
                is_dir: r.get::<_, i64>(8)? != 0,
            })
        };
        let base = "SELECT t.id, t.op_id, t.original_path, t.stored_path, t.size, t.deleted_ns, t.reason, t.restored, t.is_dir
             FROM trash_items t JOIN operations o ON o.id = t.op_id";
        if let Some(k) = kind {
            let mut stmt = self.conn.prepare(&format!(
                "{base} WHERE o.kind = ?1 ORDER BY t.deleted_ns DESC LIMIT ?2"
            ))?;
            let rows = stmt.query_map(rusqlite::params![k, limit], map)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        } else {
            let mut stmt = self
                .conn
                .prepare(&format!("{base} ORDER BY t.deleted_ns DESC LIMIT ?1"))?;
            let rows = stmt.query_map([limit], map)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        }
    }

    /// Permanently delete one quarantined item: remove its stored file from disk
    /// (ignoring if already gone) and drop its row. Irreversible.
    pub fn purge_item(&self, item_id: &str) -> Result<()> {
        let stored: String = self.conn.query_row(
            "SELECT stored_path FROM trash_items WHERE id = ?1",
            [item_id],
            |r| r.get(0),
        )?;
        if self.is_in_quarantine(Path::new(&stored)) {
            remove_stored(Path::new(&stored));
        }
        self.conn
            .execute("DELETE FROM trash_items WHERE id = ?1", [item_id])?;
        Ok(())
    }

    /// Permanently delete a whole operation: remove every item's stored file,
    /// drop the item rows and the operation row, and clean up its trash dir.
    pub fn purge_op(&self, op_id: &str) -> Result<()> {
        let stored: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare("SELECT stored_path FROM trash_items WHERE op_id = ?1")?;
            let rows = stmt.query_map([op_id], |r| r.get(0))?;
            rows.collect::<Result<Vec<String>, _>>()?
        };
        // One op can span several drives, so collect every quarantine it landed
        // in rather than assuming the app-data one.
        let mut op_dirs: HashSet<PathBuf> = HashSet::new();
        op_dirs.insert(self.trash_root.join(op_id));
        for path in &stored {
            let p = Path::new(path);
            if self.is_in_quarantine(p) {
                remove_stored(p);
                if let Some(q) = volume_quarantine(p) {
                    op_dirs.insert(q.join(op_id));
                }
            }
        }
        self.conn
            .execute("DELETE FROM trash_items WHERE op_id = ?1", [op_id])?;
        self.conn
            .execute("DELETE FROM operations WHERE id = ?1", [op_id])?;
        for op_dir in op_dirs {
            if op_dir.exists() {
                let _ = fs::remove_dir_all(&op_dir);
            }
        }
        Ok(())
    }

    pub fn purge_before(&self, age_ns_cutoff: i64) -> Result<()> {
        let rows: Vec<(String, String)> = {
            let mut stmt = self.conn.prepare(
                "SELECT t.id, t.stored_path FROM trash_items t JOIN operations o ON o.id = t.op_id
                 WHERE t.deleted_ns < ?1 AND o.kind = 'delete' ORDER BY t.deleted_ns ASC",
            )?;
            let out = stmt
                .query_map([age_ns_cutoff], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            out
        };
        for (id, stored) in rows {
            if self.is_in_quarantine(Path::new(&stored)) {
                remove_stored(Path::new(&stored));
            }
            self.conn
                .execute("DELETE FROM trash_items WHERE id = ?1", [&id])?;
        }
        Ok(())
    }

    pub fn purge_to_cap(&self, max_bytes: i64) -> Result<()> {
        let total: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(t.size), 0) FROM trash_items t JOIN operations o ON o.id = t.op_id
             WHERE t.restored = 0 AND o.kind = 'delete'",
            [],
            |r| r.get(0),
        )?;
        let mut freed = 0i64;
        if total <= max_bytes {
            return Ok(());
        }
        let rows: Vec<(String, String, i64)> = {
            let mut stmt = self.conn.prepare(
                "SELECT t.id, t.stored_path, t.size FROM trash_items t JOIN operations o ON o.id = t.op_id
                 WHERE t.restored = 0 AND o.kind = 'delete' ORDER BY t.deleted_ns ASC",
            )?;
            let out = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            out
        };
        for (id, stored, size) in rows {
            if total - freed <= max_bytes {
                break;
            }
            if self.is_in_quarantine(Path::new(&stored)) {
                remove_stored(Path::new(&stored));
            }
            self.conn
                .execute("DELETE FROM trash_items WHERE id = ?1", [&id])?;
            freed += size;
        }
        Ok(())
    }

    pub fn empty(&self) -> Result<()> {
        let stored: Vec<String> = {
            let mut stmt = self.conn.prepare("SELECT stored_path FROM trash_items")?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<Result<Vec<String>, _>>()?
        };
        // Sweep every quarantine that has rows, not only the app-data one; a
        // drive that is not mounted right now simply has nothing to remove.
        let mut roots: HashSet<PathBuf> = HashSet::new();
        roots.insert(self.trash_root.clone());
        for s in &stored {
            let p = Path::new(s);
            if self.is_in_quarantine(p) {
                remove_stored(p);
                if let Some(q) = volume_quarantine(p) {
                    roots.insert(q.to_path_buf());
                }
            }
        }
        self.conn
            .execute_batch("DELETE FROM trash_items; DELETE FROM operations;")?;
        for root in roots {
            let Ok(entries) = fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let _ = fs::remove_dir_all(&p);
                } else {
                    let _ = fs::remove_file(&p);
                }
            }
        }
        Ok(())
    }

    fn restore_move(&self, stored: &Path, original: &Path, is_dir: bool) -> Result<PathBuf> {
        // A quarantine on another volume is gone the moment that drive is
        // unplugged. Say which drive instead of dropping the entry, which would
        // lose the only copy of the file for good.
        if !stored.exists() {
            if let Some(q) = volume_quarantine(stored) {
                if !q.exists() {
                    return Err(anyhow!(
                        "the drive holding this file is not connected ({}), reconnect it and try again",
                        q.parent().unwrap_or(q).display()
                    ));
                }
            }
            return Err(anyhow!(
                "the quarantined copy is no longer at {}",
                stored.display()
            ));
        }
        if let Some(parent) = original.parent() {
            fs::create_dir_all(parent)?;
        }
        let target = if original.exists() {
            unique_restored_path(original, is_dir)
        } else {
            original.to_path_buf()
        };
        move_path(stored, &target, is_dir)?;
        Ok(target)
    }
}

fn now_ns() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
}

/// The `.FileOrganizer-Trash` directory a per-volume stored path sits inside,
/// or `None` for anything else. `p` itself is never the answer, so the
/// quarantine directory is not treated as being inside itself.
fn volume_quarantine(p: &Path) -> Option<&Path> {
    p.ancestors()
        .skip(1)
        .find(|a| a.file_name().is_some_and(|n| n == VOLUME_TRASH_DIR))
}

/// The mount point `path` lives on. Walks up while the device id matches, which
/// needs no extra dependency and stops exactly at the mount boundary.
#[cfg(unix)]
fn volume_root(path: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    // a path that does not exist yet has no device of its own, so start from
    // the nearest ancestor that does
    let mut current = path;
    let dev = loop {
        match fs::metadata(current) {
            Ok(m) => break m.dev(),
            Err(_) => current = current.parent()?,
        }
    };
    let mut root = current.to_path_buf();
    while let Some(parent) = root.parent() {
        match fs::metadata(parent) {
            Ok(m) if m.dev() == dev => root = parent.to_path_buf(),
            _ => break,
        }
    }
    Some(root)
}

#[cfg(windows)]
fn volume_root(path: &Path) -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetVolumePathNameW;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    // MAX_PATH + 1, what GetVolumePathNameW documents as always sufficient
    let mut buf = [0u16; 261];
    unsafe { GetVolumePathNameW(PCWSTR(wide.as_ptr()), &mut buf).ok()? };
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    if len == 0 {
        return None;
    }
    Some(PathBuf::from(OsString::from_wide(&buf[..len])))
}

#[cfg(not(any(unix, windows)))]
fn volume_root(_path: &Path) -> Option<PathBuf> {
    None
}

/// Bytes still writable on the volume holding `dir`, or `None` when the platform
/// cannot say. Callers treat `None` as "do not check", never as "no space".
#[cfg(unix)]
fn free_space(dir: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
}

#[cfg(windows)]
fn free_space(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut wide: Vec<u16> = dir.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None).ok()? };
    Some(free)
}

#[cfg(not(any(unix, windows)))]
fn free_space(_dir: &Path) -> Option<u64> {
    None
}

/// Byte count a user can read at a glance, for skip reasons naming real numbers.
fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut unit = 0;
    while v >= 1024.0 && unit < UNITS.len() - 1 {
        v /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} B", n)
    } else {
        format!("{:.1} {}", v, UNITS[unit])
    }
}

fn skip(path: &Path, reason: &str) -> SkippedItem {
    SkippedItem {
        path: path.to_string_lossy().to_string(),
        reason: reason.to_string(),
    }
}

/// Total bytes of the files under `dir`. `fs::metadata` on a directory reports
/// the directory entry itself, which tells a user nothing, so walk it. Stops
/// after WALK_LIMIT entries and returns what it has rather than running long.
fn dir_size(dir: &Path) -> i64 {
    let mut total = 0i64;
    let mut seen = 0usize;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let rd = match fs::read_dir(&current) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            seen += 1;
            if seen > WALK_LIMIT {
                return total;
            }
            // file_type does not follow symlinks, so a link loop cannot trap us
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => stack.push(entry.path()),
                Ok(ft) if ft.is_file() => {
                    total += entry.metadata().map(|m| m.len()).unwrap_or(0) as i64
                }
                _ => {}
            }
        }
    }
    total
}

/// Move a file or a whole directory. Directories are rename-only: `fs::copy` is
/// files-only, so a cross-volume directory move fails outright rather than
/// leaving a half-copied tree behind.
fn move_path(src: &Path, dst: &Path, is_dir: bool) -> Result<()> {
    if is_dir {
        fs::rename(src, dst)?;
        return Ok(());
    }
    move_file(src, dst)
}

/// Delete a quarantined item from disk. Callers must have checked it is inside
/// the quarantine root first.
fn remove_stored(p: &Path) {
    if p.is_dir() {
        let _ = fs::remove_dir_all(p);
    } else {
        let _ = fs::remove_file(p);
    }
}

/// Move a file, falling back to copy+remove across filesystem boundaries.
fn move_file(src: &Path, dst: &Path) -> Result<()> {
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    let mut tmp = dst.as_os_str().to_owned();
    tmp.push(format!(".fo-tmp-{}", nanoid::nanoid!(20)));
    let tmp = PathBuf::from(tmp);
    if let Err(e) = fs::copy(src, &tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    if let Err(e) = fs::rename(&tmp, dst) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    fs::remove_file(src)?;
    Ok(())
}

/// Build a free "name (2).ext" path next to `target`, never overwriting. A
/// folder keeps its whole name, so "my.stuff" does not become "my (2).stuff".
fn unique_path(target: &Path, is_dir: bool) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let (stem, ext) = split_name(target, is_dir);
    for n in 2.. {
        let name = match &ext {
            Some(e) => format!("{} ({}).{}", stem, n, e),
            None => format!("{} ({})", stem, n),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// Split a path into the (stem, extension) used to build collision-free names.
/// Directories have no extension to preserve, so the whole name is the stem.
fn split_name(p: &Path, is_dir: bool) -> (String, Option<String>) {
    if is_dir {
        let name = p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "folder".to_string());
        return (name, None);
    }
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    (stem, p.extension().map(|s| s.to_string_lossy().to_string()))
}

/// Build a free "name (restored).ext" path next to `original`, never overwriting.
fn unique_restored_path(original: &Path, is_dir: bool) -> PathBuf {
    let parent = original.parent().unwrap_or_else(|| Path::new("."));
    let (stem, ext) = split_name(original, is_dir);
    for n in 0.. {
        let suffix = if n == 0 {
            " (restored)".to_string()
        } else {
            format!(" (restored {})", n + 1)
        };
        let name = match &ext {
            Some(e) => format!("{}{}.{}", stem, suffix, e),
            None => format!("{}{}", stem, suffix),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trash_restore_undo_and_collision() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        let a = src.join("a.txt");
        let b = src.join("b.txt");
        fs::write(&a, b"aaa").unwrap();
        fs::write(&b, b"bbb").unwrap();
        let trash = Trash::open(&data).unwrap();
        let op = trash
            .trash_files(&[a.clone(), b.clone()], "manual", None)
            .unwrap();
        assert_eq!(op.items.len(), 2);
        assert!(!a.exists() && !b.exists());
        assert_eq!(trash.list(None, 10).unwrap().len(), 2);
        // restore the whole op -> both back, restored=1
        let restored = trash.restore_op(&op.id).unwrap();
        assert_eq!(restored.len(), 2);
        assert!(a.exists() && b.exists());
        assert!(trash.list(None, 10).unwrap().iter().all(|i| i.restored));
        // trash b again, then undo_last brings it back
        let _ = trash.trash_files(&[b.clone()], "manual", None).unwrap();
        assert!(!b.exists());
        let undone = trash.undo_last().unwrap();
        assert_eq!(undone.len(), 1);
        assert!(b.exists());
        // original occupied -> restored as "(restored)"
        let op2 = trash.trash_files(&[a.clone()], "manual", None).unwrap();
        assert!(!a.exists());
        fs::write(&a, b"new content in place").unwrap();
        let restored = trash.restore_op(&op2.id).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(
            restored[0].0.file_name().unwrap().to_string_lossy(),
            "a (restored).txt"
        );
        assert!(a.exists());
    }

    #[test]
    fn apply_moves_undo_and_kind_filter() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        let a = src.join("a.txt");
        let b = src.join("b.txt");
        fs::write(&a, b"aaa").unwrap();
        fs::write(&b, b"bbb").unwrap();
        let dest = dir.path().join("Docs");
        let ta = dest.join("a.txt");
        let tb = dest.join("b.txt");
        let trash = Trash::open(&data).unwrap();
        let op = trash
            .apply_moves(
                &[(a.clone(), ta.clone()), (b.clone(), tb.clone())],
                "organize",
            )
            .unwrap();
        assert_eq!(op.items.len(), 2);
        assert!(!a.exists() && !b.exists());
        assert!(ta.exists() && tb.exists());
        // organize rows visible under "organize", excluded from "delete"
        assert_eq!(trash.list(Some("organize"), 10).unwrap().len(), 2);
        assert_eq!(trash.list(Some("delete"), 10).unwrap().len(), 0);
        // undo moves both files back to their original locations
        let undone = trash.undo_last().unwrap();
        assert_eq!(undone.len(), 2);
        assert!(a.exists() && b.exists());
        assert!(!ta.exists() && !tb.exists());
    }

    #[test]
    fn purge_op_removes_files_and_rows_without_restoring() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        let a = src.join("a.txt");
        let b = src.join("b.txt");
        fs::write(&a, b"aaa").unwrap();
        fs::write(&b, b"bbb").unwrap();
        let trash = Trash::open(&data).unwrap();
        let op = trash
            .trash_files(&[a.clone(), b.clone()], "manual", None)
            .unwrap();
        let stored: Vec<PathBuf> = op
            .items
            .iter()
            .map(|i| PathBuf::from(&i.stored_path))
            .collect();
        assert!(stored.iter().all(|p| p.exists()));
        trash.purge_op(&op.id).unwrap();
        assert!(stored.iter().all(|p| !p.exists()));
        assert!(trash.list(None, 10).unwrap().is_empty());
        assert!(!a.exists() && !b.exists());
    }

    #[test]
    fn purge_never_deletes_files_outside_quarantine() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        let del = src.join("del.txt");
        let mov = src.join("mov.txt");
        fs::write(&del, b"del").unwrap();
        fs::write(&mov, b"mov").unwrap();
        let dest = dir.path().join("Docs");
        let moved_to = dest.join("mov.txt");
        let trash = Trash::open(&data).unwrap();
        let del_op = trash.trash_files(&[del.clone()], "manual", None).unwrap();
        let quarantined = PathBuf::from(&del_op.items[0].stored_path);
        let org_op = trash
            .apply_moves(&[(mov.clone(), moved_to.clone())], "organize")
            .unwrap();
        assert!(moved_to.exists());
        // is_in_quarantine rejects a real path outside trash_root
        assert!(!trash.is_in_quarantine(&moved_to));
        assert!(trash.is_in_quarantine(&quarantined));
        // purging the organize op drops its row but leaves the real file on disk
        trash.purge_op(&org_op.id).unwrap();
        assert!(moved_to.exists());
        assert!(trash.list(Some("organize"), 10).unwrap().is_empty());
        // purging the delete op removes the quarantined file
        assert!(quarantined.exists());
        trash.purge_op(&del_op.id).unwrap();
        assert!(!quarantined.exists());
    }

    #[test]
    fn apply_moves_moves_whole_directory_and_undo_restores_it() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let src = dir.path().join("src");
        let tree = src.join("Photos");
        fs::create_dir_all(tree.join("nested")).unwrap();
        fs::write(tree.join("a.jpg"), b"aaaa").unwrap();
        fs::write(tree.join("nested/b.jpg"), b"bbbbbb").unwrap();
        let dest = dir.path().join("Sorted").join("Photos");
        let trash = Trash::open(&data).unwrap();
        let op = trash
            .apply_moves(&[(tree.clone(), dest.clone())], "organize")
            .unwrap();
        assert_eq!(op.items.len(), 1);
        assert!(op.skipped.is_empty());
        assert!(!tree.exists());
        assert!(dest.join("a.jpg").exists() && dest.join("nested/b.jpg").exists());
        assert_eq!(fs::read(dest.join("nested/b.jpg")).unwrap(), b"bbbbbb");
        // journal knows it is a folder and carries a real recursive size
        let rows = trash.list(Some("organize"), 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].is_dir);
        assert_eq!(rows[0].size, 10);
        // undo puts the whole tree back where it was
        let undone = trash.undo_last().unwrap();
        assert_eq!(undone.len(), 1);
        assert_eq!(undone[0].0, tree);
        assert!(tree.join("nested/b.jpg").exists());
        assert!(!dest.exists());
    }

    #[test]
    fn directory_move_onto_existing_name_does_not_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let tree = dir.path().join("src").join("Photos");
        fs::create_dir_all(&tree).unwrap();
        fs::write(tree.join("mine.jpg"), b"mine").unwrap();
        let dest_parent = dir.path().join("Sorted");
        let dest = dest_parent.join("Photos");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("theirs.jpg"), b"theirs").unwrap();
        let trash = Trash::open(&data).unwrap();
        let op = trash
            .apply_moves(&[(tree.clone(), dest.clone())], "organize")
            .unwrap();
        assert_eq!(op.items.len(), 1);
        let landed = PathBuf::from(&op.items[0].stored_path);
        assert_eq!(landed, dest_parent.join("Photos (2)"));
        // both trees intact, neither clobbered the other
        assert!(landed.join("mine.jpg").exists());
        assert!(dest.join("theirs.jpg").exists());
        assert!(!dest.join("mine.jpg").exists());
        assert!(!tree.exists());
    }

    #[test]
    fn apply_moves_reports_skips_and_still_processes_the_batch() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        let missing = src.join("ghost.txt");
        let real = src.join("real.txt");
        fs::write(&real, b"real").unwrap();
        let dest = dir.path().join("Docs");
        let trash = Trash::open(&data).unwrap();
        let op = trash
            .apply_moves(
                &[
                    (missing.clone(), dest.join("ghost.txt")),
                    (real.clone(), dest.join("real.txt")),
                ],
                "organize",
            )
            .unwrap();
        assert_eq!(op.skipped.len(), 1);
        assert_eq!(op.skipped[0].path, missing.to_string_lossy());
        assert_eq!(op.skipped[0].reason, "source no longer exists");
        // the rest of the batch still went through
        assert_eq!(op.items.len(), 1);
        assert!(dest.join("real.txt").exists());
    }

    #[test]
    fn trash_files_quarantines_and_restores_a_whole_directory() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let tree = dir.path().join("src").join("Old");
        fs::create_dir_all(tree.join("deep")).unwrap();
        fs::write(tree.join("deep/x.txt"), b"xxxxx").unwrap();
        let file = dir.path().join("src").join("file.txt");
        fs::write(&file, b"file").unwrap();
        let trash = Trash::open(&data).unwrap();
        let op = trash
            .trash_files(&[tree.clone(), file.clone()], "manual", None)
            .unwrap();
        assert_eq!(op.items.len(), 2);
        assert!(op.skipped.is_empty());
        assert!(!tree.exists() && !file.exists());
        let stored = PathBuf::from(&op.items[0].stored_path);
        assert!(stored.join("deep/x.txt").exists());
        assert!(op.items[0].is_dir && !op.items[1].is_dir);
        assert_eq!(op.items[0].size, 5);
        // restoring brings the whole tree back to its original path
        trash.restore_op(&op.id).unwrap();
        assert!(tree.join("deep/x.txt").exists());
        assert!(file.exists());
    }

    #[test]
    fn purge_removes_a_quarantined_directory() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let tree = dir.path().join("src").join("Old");
        fs::create_dir_all(&tree).unwrap();
        fs::write(tree.join("x.txt"), b"x").unwrap();
        let trash = Trash::open(&data).unwrap();
        let op = trash.trash_files(&[tree.clone()], "manual", None).unwrap();
        let stored = PathBuf::from(&op.items[0].stored_path);
        assert!(stored.is_dir());
        trash.purge_op(&op.id).unwrap();
        assert!(!stored.exists());
        assert!(trash.list(None, 10).unwrap().is_empty());
    }

    #[test]
    fn is_dir_column_is_added_to_a_pre_existing_db() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        fs::create_dir_all(data.join("trash")).unwrap();
        // schema as it shipped before folder support
        let conn = Connection::open(data.join("trash.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE operations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_ns INTEGER NOT NULL, note TEXT);
            CREATE TABLE trash_items (id TEXT PRIMARY KEY, op_id TEXT NOT NULL REFERENCES operations(id), original_path TEXT NOT NULL, stored_path TEXT NOT NULL, size INTEGER NOT NULL, deleted_ns INTEGER NOT NULL, reason TEXT, restored INTEGER NOT NULL DEFAULT 0);
            INSERT INTO operations VALUES ('op1', 'delete', 1, NULL);
            INSERT INTO trash_items VALUES ('it1', 'op1', '/x/a.txt', '/q/a.txt', 3, 1, 'manual', 0);",
        )
        .unwrap();
        drop(conn);
        // opening twice must both migrate and stay a no-op the second time
        let trash = Trash::open(data).unwrap();
        let rows = trash.list(None, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].is_dir);
        drop(trash);
        let trash = Trash::open(data).unwrap();
        assert_eq!(trash.list(None, 10).unwrap().len(), 1);
    }

    #[test]
    fn purge_refuses_a_crafted_stored_path_outside_every_quarantine() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let victim = dir.path().join("precious.txt");
        fs::write(&victim, b"precious").unwrap();
        let trash = Trash::open(&data).unwrap();
        assert!(!trash.is_in_quarantine(&victim));
        // a folder a user named like the quarantine, but not on a volume root
        let lookalike = dir
            .path()
            .join("anywhere")
            .join(VOLUME_TRASH_DIR)
            .join("op")
            .join("x.txt");
        assert!(!trash.is_in_quarantine(&lookalike));
        // climbing back out of a real quarantine with ".." must not be accepted
        let escape = data
            .join("trash")
            .join("op")
            .join("..")
            .join("..")
            .join("..")
            .join("precious.txt");
        assert!(!trash.is_in_quarantine(&escape));
        // rows pointing at a real user file, as a tampered journal would look
        let conn = Connection::open(data.join("trash.db")).unwrap();
        conn.execute(
            "INSERT INTO operations (id, kind, created_ns, note) VALUES ('op1', 'delete', 1, NULL)",
            [],
        )
        .unwrap();
        let stored = victim.to_string_lossy().to_string();
        let add = |id: &str| {
            conn.execute(
                "INSERT INTO trash_items (id, op_id, original_path, stored_path, size, deleted_ns, reason, restored, is_dir)
                 VALUES (?1, 'op1', '/x/precious.txt', ?2, 8, 1, 'manual', 0, 0)",
                rusqlite::params![id, stored],
            )
            .unwrap();
        };
        add("i1");
        trash.purge_item("i1").unwrap();
        assert!(victim.exists());
        add("i2");
        trash.purge_before(i64::MAX).unwrap();
        assert!(victim.exists());
        add("i3");
        trash.purge_to_cap(0).unwrap();
        assert!(victim.exists());
        add("i4");
        trash.purge_op("op1").unwrap();
        assert!(victim.exists());
        conn.execute(
            "INSERT INTO operations (id, kind, created_ns, note) VALUES ('op1', 'delete', 1, NULL)",
            [],
        )
        .unwrap();
        add("i5");
        trash.empty().unwrap();
        assert!(
            victim.exists(),
            "no purge path may delete a file outside the quarantine"
        );
        assert!(trash.list(None, 10).unwrap().is_empty());
    }

    #[test]
    fn restore_refuses_when_the_quarantine_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        let a = src.join("a.txt");
        fs::write(&a, b"aaa").unwrap();
        let trash = Trash::open(&data).unwrap();
        let op = trash.trash_files(&[a.clone()], "manual", None).unwrap();
        // the quarantine directory disappears out from under the journal
        fs::remove_dir_all(data.join("trash")).unwrap();
        let err = trash.restore_item(&op.items[0].id).unwrap_err().to_string();
        assert!(err.contains("no longer at"), "{err}");
        // the entry survives instead of being silently dropped or marked done
        let rows = trash.list(None, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].restored);
        assert!(!a.exists());
        // a quarantine on an unmounted drive names the drive
        let offline = dir
            .path()
            .join("Volumes-stub")
            .join(VOLUME_TRASH_DIR)
            .join("op")
            .join("a.txt");
        let err = trash
            .restore_move(&offline, &a, false)
            .unwrap_err()
            .to_string();
        assert!(err.contains("is not connected"), "{err}");
        assert!(err.contains("Volumes-stub"), "{err}");
    }

    #[test]
    fn human_bytes_reads_like_a_size() {
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(4_509_715_660), "4.2 GB");
        assert_eq!(human_bytes(1_181_116_006), "1.1 GB");
    }

    #[test]
    fn volume_root_is_an_ancestor_that_contains_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        fs::write(&file, b"a").unwrap();
        let root = volume_root(&file).expect("a real file must resolve to a volume");
        assert!(file.starts_with(&root), "{root:?}");
        // resolving works for a path that does not exist yet
        assert_eq!(volume_root(&dir.path().join("nope/deeper.txt")), Some(root));
    }

    #[test]
    fn apply_moves_skips_noop_self_move() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        let a = src.join("a.txt");
        fs::write(&a, b"aaa").unwrap();
        let trash = Trash::open(&data).unwrap();
        let op = trash
            .apply_moves(&[(a.clone(), a.clone())], "organize")
            .unwrap();
        assert!(op.items.is_empty());
        assert!(a.exists());
        assert_eq!(fs::read(&a).unwrap(), b"aaa");
    }
}
