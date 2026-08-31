use anyhow::{anyhow, Result};
use fo_search::{Index, SearchHit};
use rusqlite::{params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, MAIN_SEPARATOR};
use std::time::{SystemTime, UNIX_EPOCH};

/// What a rule does with the files it matches. Both outcomes go through the
/// trash journal, so neither one ever deletes permanently.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RuleAction {
    Trash,
    MoveTo { folder: String },
}

/// The saved filter a rule re-applies to the index on every run. Every populated
/// field narrows the match; empty fields are ignored.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RuleFilter {
    pub name_contains: Option<String>,
    pub ext: Option<String>,
    pub min_size: Option<i64>,
    pub max_size: Option<i64>,
    pub older_than_days: Option<i64>,
    pub in_folder: Option<String>,
}

/// A saved, re-runnable cleanup: a filter plus an action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub filter: RuleFilter,
    pub action: RuleAction,
    pub created_ns: i64,
    pub last_run_ns: Option<i64>,
    pub last_run_count: i64,
}

/// Rule store backed by its own SQLite DB, kept apart from the index and trash DBs.
pub struct Rules {
    conn: Connection,
}

impl Rules {
    pub fn open(data_dir: &Path) -> Result<Rules> {
        let conn = Connection::open(data_dir.join("rules.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS rules (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                filter_json TEXT NOT NULL,
                action_json TEXT NOT NULL,
                created_ns INTEGER NOT NULL,
                last_run_ns INTEGER,
                last_run_count INTEGER NOT NULL DEFAULT 0
            );",
        )?;
        Ok(Rules { conn })
    }

    pub fn create(&self, name: &str, filter: RuleFilter, action: RuleAction) -> Result<Rule> {
        let rule = Rule {
            id: nanoid::nanoid!(20),
            name: name.to_string(),
            filter,
            action,
            created_ns: now_ns(),
            last_run_ns: None,
            last_run_count: 0,
        };
        self.conn.execute(
            "INSERT INTO rules (id, name, filter_json, action_json, created_ns, last_run_ns, last_run_count)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0)",
            rusqlite::params![
                rule.id,
                rule.name,
                serde_json::to_string(&rule.filter)?,
                serde_json::to_string(&rule.action)?,
                rule.created_ns
            ],
        )?;
        Ok(rule)
    }

    /// Overwrite the editable fields of an existing rule. Run stats are owned by
    /// `mark_run` and are not touched here.
    pub fn update(&self, rule: &Rule) -> Result<()> {
        let n = self.conn.execute(
            "UPDATE rules SET name = ?2, filter_json = ?3, action_json = ?4 WHERE id = ?1",
            rusqlite::params![
                rule.id,
                rule.name,
                serde_json::to_string(&rule.filter)?,
                serde_json::to_string(&rule.action)?
            ],
        )?;
        if n == 0 {
            return Err(anyhow!("no rule with id {}", rule.id));
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM rules WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Rule>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, filter_json, action_json, created_ns, last_run_ns, last_run_count
             FROM rules ORDER BY created_ns DESC",
        )?;
        let rows = stmt.query_map([], row_to_rule)?;
        let mut rules = Vec::new();
        for row in rows {
            rules.push(row??);
        }
        Ok(rules)
    }

    pub fn get(&self, id: &str) -> Result<Option<Rule>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, filter_json, action_json, created_ns, last_run_ns, last_run_count
             FROM rules WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map([id], row_to_rule)?;
        match rows.next() {
            Some(row) => Ok(Some(row??)),
            None => Ok(None),
        }
    }

    pub fn mark_run(&self, id: &str, count: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE rules SET last_run_ns = ?2, last_run_count = ?3 WHERE id = ?1",
            rusqlite::params![id, now_ns(), count],
        )?;
        Ok(())
    }
}

/// Files in `index` matching `filter`, biggest first. A negative `limit` means
/// no limit (SQLite semantics). Every filter value is bound, never interpolated.
pub fn match_rule(index: &Index, filter: &RuleFilter, limit: i64) -> Result<Vec<SearchHit>> {
    let mut wheres: Vec<&str> = Vec::new();
    let mut binds: Vec<Value> = Vec::new();
    if let Some(name) = filter.name_contains.as_deref().map(str::trim) {
        if !name.is_empty() {
            wheres.push("name LIKE ? ESCAPE '\\'");
            binds.push(Value::Text(format!("%{}%", like_escape(name))));
        }
    }
    if let Some(ext) = filter.ext.as_deref().map(str::trim) {
        if !ext.is_empty() {
            wheres.push("ext = ?");
            binds.push(Value::Text(ext.trim_start_matches('.').to_lowercase()));
        }
    }
    if let Some(min) = filter.min_size {
        wheres.push("size >= ?");
        binds.push(Value::Integer(min));
    }
    if let Some(max) = filter.max_size {
        wheres.push("size <= ?");
        binds.push(Value::Integer(max));
    }
    if let Some(days) = filter.older_than_days {
        wheres.push("modified_ns IS NOT NULL AND modified_ns < ?");
        binds.push(Value::Integer(
            now_ns().saturating_sub(days.saturating_mul(86_400_000_000_000)),
        ));
    }
    if let Some(folder) = filter.in_folder.as_deref().map(str::trim) {
        if !folder.is_empty() {
            // Anchor on the separator so /Users/me/Down does not match /Users/me/Downloads.
            let prefix = format!(
                "{}{}",
                folder.trim_end_matches(MAIN_SEPARATOR),
                MAIN_SEPARATOR
            );
            wheres.push("path LIKE ? ESCAPE '\\'");
            binds.push(Value::Text(format!("{}%", like_escape(&prefix))));
        }
    }
    let mut sql = String::from("SELECT path, name, size, modified_ns FROM files");
    if !wheres.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&wheres.join(" AND "));
    }
    sql.push_str(" ORDER BY size DESC LIMIT ?");
    binds.push(Value::Integer(limit));
    let mut stmt = index.conn().prepare(&sql)?;
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

fn row_to_rule(r: &rusqlite::Row) -> rusqlite::Result<Result<Rule>> {
    let filter_json: String = r.get(2)?;
    let action_json: String = r.get(3)?;
    let rule = || -> Result<Rule> {
        Ok(Rule {
            id: r.get(0)?,
            name: r.get(1)?,
            filter: serde_json::from_str(&filter_json)?,
            action: serde_json::from_str(&action_json)?,
            created_ns: r.get(4)?,
            last_run_ns: r.get(5)?,
            last_run_count: r.get(6)?,
        })
    };
    Ok(rule())
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn now_ns() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fo_indexer::FileEntry;
    use fo_trash::Trash;
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    fn entry(path: &Path, size: u64, days_old: u64) -> FileEntry {
        FileEntry {
            path: path.to_path_buf(),
            size,
            modified: Some(SystemTime::now() - Duration::from_secs(days_old * 86_400)),
        }
    }

    fn names(hits: &[SearchHit]) -> Vec<String> {
        let mut v: Vec<String> = hits.iter().map(|h| h.name.clone()).collect();
        v.sort();
        v
    }

    /// Index of five synthetic files: two old PDFs in Downloads, a fresh PDF in
    /// Downloads, a big zip in Downloads, and a PDF outside Downloads.
    fn seeded_index(dir: &Path) -> Index {
        let downloads = dir.join("Downloads");
        let docs = dir.join("Documents");
        let entries = vec![
            entry(&downloads.join("old_report.pdf"), 1_000, 200),
            entry(&downloads.join("old_invoice.pdf"), 5_000, 120),
            entry(&downloads.join("fresh_notes.pdf"), 2_000, 1),
            entry(&downloads.join("archive.zip"), 900_000, 300),
            entry(&docs.join("old_manual.pdf"), 3_000, 400),
        ];
        let mut idx = Index::open(&dir.join("index.db")).unwrap();
        idx.upsert_batch(&entries).unwrap();
        idx
    }

    #[test]
    fn crud_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let rules = Rules::open(dir.path()).unwrap();
        assert!(rules.list().unwrap().is_empty());
        let filter = RuleFilter {
            ext: Some("pdf".into()),
            older_than_days: Some(90),
            ..Default::default()
        };
        let created = rules
            .create("Archive old PDFs", filter.clone(), RuleAction::Trash)
            .unwrap();
        assert_eq!(created.id.len(), 20);
        assert_eq!(created.last_run_count, 0);
        assert!(created.last_run_ns.is_none());
        let listed = rules.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], created);
        let fetched = rules.get(&created.id).unwrap().unwrap();
        assert_eq!(fetched.filter, filter);
        assert_eq!(fetched.action, RuleAction::Trash);
        let mut edited = fetched;
        edited.name = "Move old PDFs".into();
        edited.filter.min_size = Some(1024);
        edited.action = RuleAction::MoveTo {
            folder: "/tmp/archive".into(),
        };
        rules.update(&edited).unwrap();
        let reloaded = rules.get(&created.id).unwrap().unwrap();
        assert_eq!(reloaded.name, "Move old PDFs");
        assert_eq!(reloaded.filter.min_size, Some(1024));
        assert_eq!(
            reloaded.action,
            RuleAction::MoveTo {
                folder: "/tmp/archive".into()
            }
        );
        assert_eq!(reloaded.created_ns, created.created_ns);
        rules.delete(&created.id).unwrap();
        assert!(rules.get(&created.id).unwrap().is_none());
        assert!(rules.list().unwrap().is_empty());
        // updating a rule that no longer exists is an error, not a silent no-op
        assert!(rules.update(&edited).is_err());
    }

    #[test]
    fn mark_run_records_time_and_count() {
        let dir = tempfile::tempdir().unwrap();
        let rules = Rules::open(dir.path()).unwrap();
        let rule = rules
            .create("Trash junk", RuleFilter::default(), RuleAction::Trash)
            .unwrap();
        let before = now_ns();
        rules.mark_run(&rule.id, 7).unwrap();
        let after = rules.get(&rule.id).unwrap().unwrap();
        assert_eq!(after.last_run_count, 7);
        let ran_at = after.last_run_ns.unwrap();
        assert!(ran_at >= before && ran_at <= now_ns());
        rules.mark_run(&rule.id, 0).unwrap();
        let after = rules.get(&rule.id).unwrap().unwrap();
        assert_eq!(after.last_run_count, 0);
        assert!(after.last_run_ns.unwrap() >= ran_at);
    }

    #[test]
    fn each_filter_field_selects_its_subset() {
        let dir = tempfile::tempdir().unwrap();
        let idx = seeded_index(dir.path());
        let all = match_rule(&idx, &RuleFilter::default(), -1).unwrap();
        assert_eq!(all.len(), 5);
        // biggest first
        assert_eq!(all[0].name, "archive.zip");
        let by_ext = match_rule(
            &idx,
            &RuleFilter {
                ext: Some("pdf".into()),
                ..Default::default()
            },
            -1,
        )
        .unwrap();
        assert_eq!(
            names(&by_ext),
            [
                "fresh_notes.pdf",
                "old_invoice.pdf",
                "old_manual.pdf",
                "old_report.pdf"
            ]
        );
        let by_name = match_rule(
            &idx,
            &RuleFilter {
                name_contains: Some("invoice".into()),
                ..Default::default()
            },
            -1,
        )
        .unwrap();
        assert_eq!(names(&by_name), ["old_invoice.pdf"]);
        let by_size = match_rule(
            &idx,
            &RuleFilter {
                min_size: Some(2_000),
                max_size: Some(5_000),
                ..Default::default()
            },
            -1,
        )
        .unwrap();
        assert_eq!(
            names(&by_size),
            ["fresh_notes.pdf", "old_invoice.pdf", "old_manual.pdf"]
        );
        let by_age = match_rule(
            &idx,
            &RuleFilter {
                older_than_days: Some(90),
                ..Default::default()
            },
            -1,
        )
        .unwrap();
        assert_eq!(
            names(&by_age),
            [
                "archive.zip",
                "old_invoice.pdf",
                "old_manual.pdf",
                "old_report.pdf"
            ]
        );
        let by_folder = match_rule(
            &idx,
            &RuleFilter {
                in_folder: Some(dir.path().join("Downloads").to_string_lossy().to_string()),
                ..Default::default()
            },
            -1,
        )
        .unwrap();
        assert_eq!(
            names(&by_folder),
            [
                "archive.zip",
                "fresh_notes.pdf",
                "old_invoice.pdf",
                "old_report.pdf"
            ]
        );
        // a sibling folder sharing a name prefix must not leak in
        let sibling = match_rule(
            &idx,
            &RuleFilter {
                in_folder: Some(dir.path().join("Down").to_string_lossy().to_string()),
                ..Default::default()
            },
            -1,
        )
        .unwrap();
        assert!(sibling.is_empty());
        assert_eq!(
            match_rule(&idx, &RuleFilter::default(), 2).unwrap().len(),
            2
        );
    }

    #[test]
    fn combined_filters_and_together() {
        let dir = tempfile::tempdir().unwrap();
        let idx = seeded_index(dir.path());
        let filter = RuleFilter {
            name_contains: Some("old".into()),
            ext: Some("pdf".into()),
            min_size: Some(2_000),
            max_size: Some(10_000),
            older_than_days: Some(90),
            in_folder: Some(dir.path().join("Downloads").to_string_lossy().to_string()),
        };
        // old_manual.pdf loses on folder, old_report.pdf on size, fresh_notes.pdf on age and name
        assert_eq!(
            names(&match_rule(&idx, &filter, -1).unwrap()),
            ["old_invoice.pdf"]
        );
        // a LIKE metacharacter in the name is matched literally, not as a wildcard
        let wild = match_rule(
            &idx,
            &RuleFilter {
                name_contains: Some("old%pdf".into()),
                ..Default::default()
            },
            -1,
        )
        .unwrap();
        assert!(wild.is_empty());
    }

    #[test]
    fn trash_rule_run_quarantines_and_deindexes() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let downloads = dir.path().join("Downloads");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&downloads).unwrap();
        let stale = downloads.join("stale.pdf");
        let keep = downloads.join("keep.txt");
        fs::write(&stale, vec![0u8; 400]).unwrap();
        fs::write(&keep, vec![0u8; 400]).unwrap();
        let mut idx = Index::open(&data.join("index.db")).unwrap();
        idx.upsert_batch(&[entry(&stale, 400, 200), entry(&keep, 400, 200)])
            .unwrap();
        let trash = Trash::open(&data).unwrap();
        let rules = Rules::open(&data).unwrap();
        let rule = rules
            .create(
                "Old PDFs",
                RuleFilter {
                    ext: Some("pdf".into()),
                    older_than_days: Some(90),
                    in_folder: Some(downloads.to_string_lossy().to_string()),
                    ..Default::default()
                },
                RuleAction::Trash,
            )
            .unwrap();
        // mirrors run_rule in src-tauri: match, trash, de-index, mark_run
        let hits = match_rule(&idx, &rule.filter, -1).unwrap();
        assert_eq!(names(&hits), ["stale.pdf"]);
        let paths: Vec<PathBuf> = hits.iter().map(|h| PathBuf::from(&h.path)).collect();
        let op = trash.trash_files(&paths, "rule", Some(&rule.name)).unwrap();
        assert_eq!(op.items.len(), 1);
        for item in &op.items {
            idx.remove_path(&PathBuf::from(&item.original_path))
                .unwrap();
        }
        rules.mark_run(&rule.id, op.items.len() as i64).unwrap();
        assert!(!stale.exists());
        assert!(keep.exists());
        assert_eq!(idx.count().unwrap(), 1);
        assert!(match_rule(&idx, &rule.filter, -1).unwrap().is_empty());
        let journal = trash.list(Some("delete"), 10).unwrap();
        assert_eq!(journal.len(), 1);
        assert_eq!(journal[0].original_path, stale.to_string_lossy());
        assert_eq!(rules.get(&rule.id).unwrap().unwrap().last_run_count, 1);
        // the run is reversible: undo puts the file back
        let restored = trash.undo_last().unwrap();
        assert_eq!(restored.len(), 1);
        assert!(stale.exists());
    }
}
