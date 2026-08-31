use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// A chat as it appears in the sidebar: everything but the transcript itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub created_ns: i64,
    pub updated_ns: i64,
    pub message_count: i64,
}

/// A saved conversation. `messages` is the OpenAI-format transcript verbatim,
/// stored as one JSON blob because it is always read and written whole.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Chat {
    pub id: String,
    pub title: String,
    pub created_ns: i64,
    pub updated_ns: i64,
    pub messages: Value,
}

/// Chat store backed by its own SQLite DB, kept apart from the index, trash and rules DBs.
pub struct Chats {
    conn: Connection,
}

impl Chats {
    pub fn open(data_dir: &Path) -> Result<Chats> {
        let conn = Connection::open(data_dir.join("chats.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_ns INTEGER NOT NULL,
                updated_ns INTEGER NOT NULL,
                messages_json TEXT NOT NULL
            );",
        )?;
        Ok(Chats { conn })
    }

    pub fn create(&self, title: &str, messages: &Value) -> Result<Chat> {
        let now = now_ns();
        let chat = Chat {
            id: nanoid::nanoid!(20),
            title: title.to_string(),
            created_ns: now,
            updated_ns: now,
            messages: messages.clone(),
        };
        self.conn.execute(
            "INSERT INTO chats (id, title, created_ns, updated_ns, messages_json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                chat.id,
                chat.title,
                chat.created_ns,
                chat.updated_ns,
                serde_json::to_string(&chat.messages)?
            ],
        )?;
        Ok(chat)
    }

    /// Overwrite a chat's transcript (and title, when given), bumping `updated_ns`.
    /// An id that is not stored yet is inserted rather than dropped.
    pub fn save(&self, id: &str, title: Option<&str>, messages: &Value) -> Result<()> {
        let now = now_ns();
        let json = serde_json::to_string(messages)?;
        let n = match title {
            Some(t) => self.conn.execute(
                "UPDATE chats SET title = ?2, updated_ns = ?3, messages_json = ?4 WHERE id = ?1",
                rusqlite::params![id, t, now, json],
            )?,
            None => self.conn.execute(
                "UPDATE chats SET updated_ns = ?2, messages_json = ?3 WHERE id = ?1",
                rusqlite::params![id, now, json],
            )?,
        };
        if n == 0 {
            let derived = derive_title(messages);
            self.conn.execute(
                "INSERT INTO chats (id, title, created_ns, updated_ns, messages_json)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, title.unwrap_or(&derived), now, now, json],
            )?;
        }
        Ok(())
    }

    pub fn list(&self, limit: i64) -> Result<Vec<ChatSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, created_ns, updated_ns, messages_json
             FROM chats ORDER BY updated_ns DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |r| {
            Ok(ChatSummary {
                id: r.get(0)?,
                title: r.get(1)?,
                created_ns: r.get(2)?,
                updated_ns: r.get(3)?,
                message_count: message_count(&r.get::<_, String>(4)?),
            })
        })?;
        let mut chats = Vec::new();
        for row in rows {
            chats.push(row?);
        }
        Ok(chats)
    }

    pub fn get(&self, id: &str) -> Result<Option<Chat>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, created_ns, updated_ns, messages_json FROM chats WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        match rows.next() {
            Some(row) => {
                let (id, title, created_ns, updated_ns, json) = row?;
                Ok(Some(Chat {
                    id,
                    title,
                    created_ns,
                    updated_ns,
                    messages: serde_json::from_str(&json)?,
                }))
            }
            None => Ok(None),
        }
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE chats SET title = ?2 WHERE id = ?1",
            rusqlite::params![id, title],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM chats WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn delete_all(&self) -> Result<()> {
        self.conn.execute("DELETE FROM chats", [])?;
        Ok(())
    }
}

/// A chat's display name, taken from the first thing the user said. Tool and
/// system plumbing is skipped, and anything long is cut on a char boundary.
pub fn derive_title(messages: &Value) -> String {
    let first = messages.as_array().and_then(|msgs| {
        msgs.iter()
            .find(|m| m.get("role").and_then(Value::as_str) == Some("user"))
            .and_then(|m| m.get("content"))
            .and_then(Value::as_str)
    });
    let collapsed = match first {
        Some(text) => text.split_whitespace().collect::<Vec<_>>().join(" "),
        None => String::new(),
    };
    if collapsed.is_empty() {
        return "New chat".to_string();
    }
    if collapsed.chars().count() <= 60 {
        return collapsed;
    }
    let cut: String = collapsed.chars().take(60).collect();
    format!("{}…", cut.trim_end())
}

/// Only what a person would call a message: tool results and the assistant's
/// tool plumbing would otherwise inflate the sidebar counts.
fn message_count(json: &str) -> i64 {
    serde_json::from_str::<Value>(json)
        .ok()
        .and_then(|v| {
            v.as_array().map(|msgs| {
                msgs.iter()
                    .filter(|m| {
                        matches!(
                            m.get("role").and_then(Value::as_str),
                            Some("user") | Some("assistant")
                        ) && m
                            .get("content")
                            .and_then(Value::as_str)
                            .is_some_and(|c| !c.trim().is_empty())
                    })
                    .count() as i64
            })
        })
        .unwrap_or(0)
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
    use serde_json::json;

    fn transcript(user: &str, assistant: &str) -> Value {
        json!([
            {"role": "user", "content": user},
            {"role": "assistant", "content": assistant}
        ])
    }

    #[test]
    fn crud_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let chats = Chats::open(dir.path()).unwrap();
        assert!(chats.list(100).unwrap().is_empty());
        let msgs = transcript("find my big pdfs", "here are three");
        let created = chats.create("Big PDFs", &msgs).unwrap();
        assert_eq!(created.id.len(), 20);
        assert_eq!(created.created_ns, created.updated_ns);
        let fetched = chats.get(&created.id).unwrap().unwrap();
        assert_eq!(fetched, created);
        let listed = chats.list(100).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);
        assert_eq!(listed[0].title, "Big PDFs");
        assert_eq!(listed[0].message_count, 2);
        chats.rename(&created.id, "Renamed").unwrap();
        assert_eq!(chats.get(&created.id).unwrap().unwrap().title, "Renamed");
        chats.delete(&created.id).unwrap();
        assert!(chats.get(&created.id).unwrap().is_none());
        assert!(chats.list(100).unwrap().is_empty());
        chats.create("a", &msgs).unwrap();
        chats.create("b", &msgs).unwrap();
        chats.delete_all().unwrap();
        assert!(chats.list(100).unwrap().is_empty());
    }

    #[test]
    fn save_updates_messages_and_upserts_unknown_id() {
        let dir = tempfile::tempdir().unwrap();
        let chats = Chats::open(dir.path()).unwrap();
        let created = chats
            .create("New chat", &transcript("hello", "hi"))
            .unwrap();
        let longer = json!([
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
            {"role": "user", "content": "and now clean my Downloads"}
        ]);
        chats.save(&created.id, Some("Cleanup"), &longer).unwrap();
        let after = chats.get(&created.id).unwrap().unwrap();
        assert_eq!(after.title, "Cleanup");
        assert_eq!(after.messages, longer);
        assert_eq!(after.created_ns, created.created_ns);
        assert!(after.updated_ns >= created.updated_ns);
        // no title given, so the existing one survives
        chats
            .save(&created.id, None, &transcript("x", "y"))
            .unwrap();
        assert_eq!(chats.get(&created.id).unwrap().unwrap().title, "Cleanup");
        // an id the store has never seen is inserted, with a derived title
        chats
            .save(
                "unknownid0123456789",
                None,
                &transcript("where is my tax pdf", "found it"),
            )
            .unwrap();
        let inserted = chats.get("unknownid0123456789").unwrap().unwrap();
        assert_eq!(inserted.title, "where is my tax pdf");
        assert_eq!(inserted.created_ns, inserted.updated_ns);
        assert_eq!(chats.list(100).unwrap().len(), 2);
    }

    #[test]
    fn list_orders_by_updated_desc() {
        let dir = tempfile::tempdir().unwrap();
        let chats = Chats::open(dir.path()).unwrap();
        let a = chats.create("a", &transcript("a", "a")).unwrap();
        let b = chats.create("b", &transcript("b", "b")).unwrap();
        let c = chats.create("c", &transcript("c", "c")).unwrap();
        let ids: Vec<String> = chats.list(100).unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec![c.id.clone(), b.id.clone(), a.id.clone()]);
        chats.save(&a.id, None, &transcript("a", "a2")).unwrap();
        let ids: Vec<String> = chats.list(100).unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec![a.id, c.id, b.id]);
        assert_eq!(chats.list(2).unwrap().len(), 2);
    }

    #[test]
    fn message_count_ignores_tool_plumbing() {
        let dir = tempfile::tempdir().unwrap();
        let chats = Chats::open(dir.path()).unwrap();
        let msgs = json!([
            {"role": "system", "content": "you are a file assistant"},
            {"role": "user", "content": "how many pdfs do I have"},
            {"role": "assistant", "content": null, "tool_calls": [
                {"id": "call_1", "type": "function", "function": {"name": "search", "arguments": "{}"}}
            ]},
            {"role": "tool", "tool_call_id": "call_1", "content": "42"},
            {"role": "assistant", "content": "42 pdfs"}
        ]);
        let chat = chats.create("Counts", &msgs).unwrap();
        let summary = chats.list(100).unwrap();
        assert_eq!(summary[0].id, chat.id);
        // system and tool never count, and neither does the assistant turn that
        // only carried tool_calls: the reader never saw it as a message
        assert_eq!(summary[0].message_count, 2);
        chats.save(&chat.id, None, &json!([])).unwrap();
        assert_eq!(chats.list(100).unwrap()[0].message_count, 0);
    }

    #[test]
    fn derive_title_cases() {
        assert_eq!(
            derive_title(&transcript("find duplicate photos", "sure")),
            "find duplicate photos"
        );
        // a leading system message must not become the title
        assert_eq!(
            derive_title(&json!([
                {"role": "system", "content": "you are a file assistant"},
                {"role": "user", "content": "  clean   my\n Downloads\tfolder  "}
            ])),
            "clean my Downloads folder"
        );
        let long = "a".repeat(200);
        let titled = derive_title(&transcript(&long, "ok"));
        assert_eq!(titled.chars().count(), 61);
        assert!(titled.ends_with('…'));
        assert!(titled.starts_with(&"a".repeat(60)));
        // exactly 60 chars is left alone
        let exact = "b".repeat(60);
        assert_eq!(derive_title(&transcript(&exact, "ok")), exact);
        // the ellipsis never sits behind a stray space
        let spaced = format!("{} {}", "c".repeat(59), "tail words here");
        let cut = derive_title(&transcript(&spaced, "ok"));
        assert_eq!(cut, format!("{}…", "c".repeat(59)));
        // multibyte text is cut on a char boundary, not a byte one
        let farsi = "س".repeat(100);
        assert_eq!(
            derive_title(&transcript(&farsi, "ok")),
            format!("{}…", "س".repeat(60))
        );
        assert_eq!(derive_title(&json!([])), "New chat");
        assert_eq!(derive_title(&Value::Null), "New chat");
        assert_eq!(
            derive_title(&json!([{"role": "assistant", "content": "hi"}])),
            "New chat"
        );
        assert_eq!(
            derive_title(&json!([{"role": "user", "content": "   "}])),
            "New chat"
        );
    }
}
