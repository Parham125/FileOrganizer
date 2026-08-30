use anyhow::{anyhow, Result};
use rusqlite::Connection;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A quarantined file that can be restored or purged.
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
}

/// One batch operation (delete or move) grouping many items.
#[derive(Debug, Clone, Serialize)]
pub struct TrashOp {
    pub id: String,
    pub items: Vec<TrashItem>,
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
                restored INTEGER NOT NULL DEFAULT 0
            );",
        )?;
        Ok(Trash { conn, trash_root })
    }

    /// True only if `p` lives inside the quarantine root. Stored paths for
    /// delete ops are built from `trash_root`; move/organize stored paths point
    /// at real user files and never match this, so purge must never touch them.
    fn is_in_quarantine(&self, p: &Path) -> bool {
        p.starts_with(&self.trash_root)
    }

    pub fn trash_files(
        &self,
        paths: &[PathBuf],
        reason: &str,
        note: Option<&str>,
    ) -> Result<TrashOp> {
        let op_id = nanoid::nanoid!(20);
        let now = now_ns();
        let op_dir = self.trash_root.join(&op_id);
        fs::create_dir_all(&op_dir)?;
        self.conn.execute(
            "INSERT INTO operations (id, kind, created_ns, note) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![op_id, "delete", now, note],
        )?;
        let mut items = Vec::new();
        for path in paths {
            if !fs::metadata(path).map(|m| m.is_file()).unwrap_or(false) {
                continue;
            }
            let filename = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_string());
            let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0) as i64;
            let stored_name = format!("{}_{}", nanoid::nanoid!(20), filename);
            let stored_path = op_dir.join(&stored_name);
            if move_file(path, &stored_path).is_err() {
                continue;
            }
            let id = nanoid::nanoid!(20);
            let original = path.to_string_lossy().to_string();
            if self
                .conn
                .execute(
                    "INSERT INTO trash_items
                 (id, op_id, original_path, stored_path, size, deleted_ns, reason, restored)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
                    rusqlite::params![
                        id,
                        op_id,
                        original,
                        stored_path.to_string_lossy().to_string(),
                        size,
                        now,
                        reason
                    ],
                )
                .is_err()
            {
                if move_file(&stored_path, path).is_err() {
                    return Err(anyhow!(
                        "journal insert failed and file could not be restored, stranded at {}",
                        stored_path.display()
                    ));
                }
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
            });
        }
        Ok(TrashOp { id: op_id, items })
    }

    /// Apply a batch of moves as one reversible operation. Never overwrites; a
    /// mid-move failure skips that file and keeps going. Undo puts each file back.
    pub fn apply_moves(&self, moves: &[(PathBuf, PathBuf)], kind: &str) -> Result<TrashOp> {
        let op_id = nanoid::nanoid!(20);
        let now = now_ns();
        self.conn.execute(
            "INSERT INTO operations (id, kind, created_ns, note) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![op_id, kind, now, Option::<String>::None],
        )?;
        let mut items = Vec::new();
        for (from, to) in moves {
            if from == to {
                continue;
            }
            if !fs::metadata(from).map(|m| m.is_file()).unwrap_or(false) {
                continue;
            }
            if let Some(parent) = to.parent() {
                if fs::create_dir_all(parent).is_err() {
                    continue;
                }
            }
            let actual_to = if to.exists() {
                unique_path(to)
            } else {
                to.clone()
            };
            let size = fs::metadata(from).map(|m| m.len()).unwrap_or(0) as i64;
            if move_file(from, &actual_to).is_err() {
                continue;
            }
            let id = nanoid::nanoid!(20);
            let original = from.to_string_lossy().to_string();
            let stored = actual_to.to_string_lossy().to_string();
            if self
                .conn
                .execute(
                    "INSERT INTO trash_items
                 (id, op_id, original_path, stored_path, size, deleted_ns, reason, restored)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
                    rusqlite::params![id, op_id, original, stored, size, now, kind],
                )
                .is_err()
            {
                if move_file(&actual_to, from).is_err() {
                    return Err(anyhow!(
                        "journal insert failed and move could not be reverted, stranded at {}",
                        actual_to.display()
                    ));
                }
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
            });
        }
        Ok(TrashOp { id: op_id, items })
    }

    /// Restore one item, returning (target where it now is, previous stored path).
    pub fn restore_item(&self, item_id: &str) -> Result<(PathBuf, PathBuf)> {
        let (original, stored): (String, String) = self.conn.query_row(
            "SELECT original_path, stored_path FROM trash_items WHERE id = ?1 AND restored = 0",
            [item_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let target = self.restore_move(&PathBuf::from(&stored), &PathBuf::from(&original))?;
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
            })
        };
        let base = "SELECT t.id, t.op_id, t.original_path, t.stored_path, t.size, t.deleted_ns, t.reason, t.restored
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
            let _ = fs::remove_file(&stored);
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
        for path in &stored {
            if self.is_in_quarantine(Path::new(path)) {
                let _ = fs::remove_file(path);
            }
        }
        self.conn
            .execute("DELETE FROM trash_items WHERE op_id = ?1", [op_id])?;
        self.conn
            .execute("DELETE FROM operations WHERE id = ?1", [op_id])?;
        let op_dir = self.trash_root.join(op_id);
        if op_dir.exists() {
            let _ = fs::remove_dir_all(&op_dir);
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
                let _ = fs::remove_file(&stored);
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
                let _ = fs::remove_file(&stored);
            }
            self.conn
                .execute("DELETE FROM trash_items WHERE id = ?1", [&id])?;
            freed += size;
        }
        Ok(())
    }

    pub fn empty(&self) -> Result<()> {
        self.conn
            .execute_batch("DELETE FROM trash_items; DELETE FROM operations;")?;
        if self.trash_root.exists() {
            for entry in fs::read_dir(&self.trash_root)?.flatten() {
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

    fn restore_move(&self, stored: &Path, original: &Path) -> Result<PathBuf> {
        if let Some(parent) = original.parent() {
            fs::create_dir_all(parent)?;
        }
        let target = if original.exists() {
            unique_restored_path(original)
        } else {
            original.to_path_buf()
        };
        move_file(stored, &target)?;
        Ok(target)
    }
}

fn now_ns() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
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

/// Build a free "name (2).ext" path next to `target`, never overwriting.
fn unique_path(target: &Path) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let ext = target.extension().map(|s| s.to_string_lossy().to_string());
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

/// Build a free "name (restored).ext" path next to `original`, never overwriting.
fn unique_restored_path(original: &Path) -> PathBuf {
    let parent = original.parent().unwrap_or_else(|| Path::new("."));
    let stem = original
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let ext = original
        .extension()
        .map(|s| s.to_string_lossy().to_string());
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
    fn destructive_ops_skip_directories() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        let tree = src.join("tree");
        fs::create_dir_all(&tree).unwrap();
        fs::write(tree.join("inner.txt"), b"inner").unwrap();
        let file = src.join("file.txt");
        fs::write(&file, b"file").unwrap();
        let trash = Trash::open(&data).unwrap();
        let op = trash
            .trash_files(&[tree.clone(), file.clone()], "manual", None)
            .unwrap();
        // directory skipped: not moved, no row; sibling file still trashed
        assert_eq!(op.items.len(), 1);
        assert!(tree.exists());
        assert!(!file.exists());
        // apply_moves also skips a directory source
        let dest = dir.path().join("Docs");
        let op2 = trash
            .apply_moves(&[(tree.clone(), dest.join("tree"))], "organize")
            .unwrap();
        assert!(op2.items.is_empty());
        assert!(tree.exists());
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
