use anyhow::Result;
use fo_indexer::FileEntry;
use rusqlite::{params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Filters applied on top of a filename search.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SearchOpts {
    pub min_size: Option<i64>,
    pub max_size: Option<i64>,
    pub ext: Option<String>,
    pub limit: Option<i64>,
}

/// A single search result row.
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub size: i64,
    pub modified_ns: Option<i64>,
}

/// Full-text search index backed by SQLite FTS5 (trigram tokenizer).
pub struct Index {
    conn: Connection,
}

impl Index {
    pub fn open(db_path: &Path) -> Result<Index> {
        let conn = Connection::open(db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY,
                path TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                ext TEXT,
                size INTEGER NOT NULL,
                modified_ns INTEGER
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
                name, path, content='files', content_rowid='id', tokenize='trigram'
            );
            CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
                INSERT INTO files_fts(rowid, name, path) VALUES (new.id, new.name, new.path);
            END;
            CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
                INSERT INTO files_fts(files_fts, rowid, name, path) VALUES ('delete', old.id, old.name, old.path);
            END;
            CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
                INSERT INTO files_fts(files_fts, rowid, name, path) VALUES ('delete', old.id, old.name, old.path);
                INSERT INTO files_fts(rowid, name, path) VALUES (new.id, new.name, new.path);
            END;",
        )?;
        Ok(Index { conn })
    }

    pub fn upsert_batch(&mut self, entries: &[FileEntry]) -> Result<usize> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO files (path, name, ext, size, modified_ns)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(path) DO UPDATE SET
                    name=excluded.name, ext=excluded.ext,
                    size=excluded.size, modified_ns=excluded.modified_ns",
            )?;
            for e in entries {
                let path = e.path.to_string_lossy().to_string();
                let name = e
                    .path
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let ext = e
                    .path
                    .extension()
                    .map(|s| s.to_string_lossy().to_lowercase());
                let modified_ns = e.modified.and_then(|m| {
                    m.duration_since(UNIX_EPOCH)
                        .ok()
                        .map(|d| d.as_nanos() as i64)
                });
                stmt.execute(rusqlite::params![
                    path,
                    name,
                    ext,
                    e.size as i64,
                    modified_ns
                ])?;
            }
        }
        tx.commit()?;
        Ok(entries.len())
    }

    pub fn remove_path(&self, path: &Path) -> Result<()> {
        self.conn.execute(
            "DELETE FROM files WHERE path = ?1",
            [path.to_string_lossy().to_string()],
        )?;
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        self.conn.execute_batch("DELETE FROM files;")?;
        Ok(())
    }

    pub fn count(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))?)
    }

    pub fn search(&self, query: &str, opts: &SearchOpts) -> Result<Vec<SearchHit>> {
        let limit = opts.limit.unwrap_or(500);
        let q = query.trim();
        let mut sql = String::from("SELECT f.path, f.name, f.size, f.modified_ns FROM files f");
        let mut binds: Vec<Value> = Vec::new();
        let mut wheres: Vec<String> = Vec::new();
        // Trigram MATCH needs at least 3 chars; shorter queries fall back to LIKE.
        if !q.is_empty() {
            if q.chars().count() >= 3 {
                sql.push_str(" JOIN files_fts ON files_fts.rowid = f.id");
                wheres.push("files_fts MATCH ?".to_string());
                binds.push(Value::Text(format!("\"{}\"", q.replace('"', "\"\""))));
            } else {
                wheres.push("f.name LIKE ? ESCAPE '\\'".to_string());
                let esc = q
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_");
                binds.push(Value::Text(format!("%{}%", esc)));
            }
        }
        if let Some(min) = opts.min_size {
            wheres.push("f.size >= ?".to_string());
            binds.push(Value::Integer(min));
        }
        if let Some(max) = opts.max_size {
            wheres.push("f.size <= ?".to_string());
            binds.push(Value::Integer(max));
        }
        if let Some(ext) = &opts.ext {
            wheres.push("f.ext = ?".to_string());
            binds.push(Value::Text(ext.trim_start_matches('.').to_lowercase()));
        }
        if !wheres.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&wheres.join(" AND "));
        }
        sql.push_str(" ORDER BY f.name LIMIT ?");
        binds.push(Value::Integer(limit));
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds.iter()), |r| {
            Ok(SearchHit {
                path: r.get(0)?,
                name: r.get(1)?,
                size: r.get(2)?,
                modified_ns: r.get(3)?,
            })
        })?;
        let mut hits = Vec::new();
        for row in rows {
            hits.push(row?);
        }
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fo_indexer::{FileSource, WalkdirSource};
    use std::fs;

    #[test]
    fn index_and_substring_search() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("report_final.pdf"), b"a").unwrap();
        fs::write(dir.path().join("holiday_photo.jpg"), b"bb").unwrap();
        fs::write(dir.path().join("notes.txt"), b"ccc").unwrap();
        let entries = WalkdirSource.enumerate(dir.path()).unwrap();
        let db = dir.path().join("index.db");
        let mut idx = Index::open(&db).unwrap();
        let n = idx.upsert_batch(&entries).unwrap();
        assert_eq!(n, 3);
        assert_eq!(idx.count().unwrap(), 3);
        // substring in the middle of a filename (trigram)
        let hits = idx.search("olida", &SearchOpts::default()).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "holiday_photo.jpg");
        // extension filter
        let opts = SearchOpts {
            ext: Some("pdf".into()),
            ..Default::default()
        };
        let hits = idx.search("", &opts).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "report_final.pdf");
        // re-index is idempotent on path
        idx.upsert_batch(&entries).unwrap();
        assert_eq!(idx.count().unwrap(), 3);
    }
}
