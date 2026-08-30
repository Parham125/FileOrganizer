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

/// A content (document body) search result with a highlighted snippet.
#[derive(Debug, Clone, Serialize)]
pub struct ContentHit {
    pub path: String,
    pub snippet: String,
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
            END;
            CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
                path, body, tokenize='porter unicode61'
            );",
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

    /// Insert or replace the searchable body text for `path`.
    pub fn index_content(&mut self, path: &Path, body: &str) -> Result<()> {
        let p = path.to_string_lossy().to_string();
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM content_fts WHERE path = ?1", [&p])?;
        tx.execute(
            "INSERT INTO content_fts (path, body) VALUES (?1, ?2)",
            rusqlite::params![p, body],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn remove_content(&self, path: &Path) -> Result<()> {
        self.conn.execute(
            "DELETE FROM content_fts WHERE path = ?1",
            [path.to_string_lossy().to_string()],
        )?;
        Ok(())
    }

    /// Full-text search over document bodies, returning an FTS5 snippet per hit.
    pub fn search_content(&self, query: &str, limit: i64) -> Result<Vec<ContentHit>> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT path, snippet(content_fts, 1, '[', ']', '...', 12)
             FROM content_fts WHERE content_fts MATCH ?1
             ORDER BY rank LIMIT ?2",
        )?;
        let match_expr = format!("body:\"{}\"", q.replace('"', "\"\""));
        let rows = stmt.query_map(rusqlite::params![match_expr, limit], |r| {
            Ok(ContentHit {
                path: r.get(0)?,
                snippet: r.get(1)?,
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

    #[test]
    fn content_search_finds_body_words() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("index.db");
        let mut idx = Index::open(&db).unwrap();
        let txt = dir.path().join("notes.txt");
        let md = dir.path().join("readme.md");
        fs::write(&txt, "the quick brown platypus jumps").unwrap();
        fs::write(&md, "# Title\nwombat colony report").unwrap();
        idx.index_content(&txt, "the quick brown platypus jumps")
            .unwrap();
        idx.index_content(&md, "# Title\nwombat colony report")
            .unwrap();
        let hits = idx.search_content("platypus", 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, txt.to_string_lossy());
        assert!(!hits[0].snippet.is_empty());
        assert!(hits[0].snippet.contains("platypus"));
        let hits = idx.search_content("wombat", 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, md.to_string_lossy());
        // a word present in neither body returns nothing
        assert!(idx.search_content("hippopotamus", 20).unwrap().is_empty());
        // upsert by path replaces prior body
        idx.index_content(&txt, "entirely different text").unwrap();
        assert!(idx.search_content("platypus", 20).unwrap().is_empty());
        assert_eq!(idx.search_content("different", 20).unwrap().len(), 1);
    }
}
