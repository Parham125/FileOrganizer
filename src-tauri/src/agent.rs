use crate::{stat_entries, AppState};
use anyhow::{anyhow, Result};
use fo_ai::OpenRouter;
use fo_dedup::find_duplicates;
use fo_hasher::HashAlgo;
use fo_indexer::{FileSource, WalkdirSource};
use fo_search::{Index, SearchOpts};
use fo_trash::Trash;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

const MAX_STEPS: usize = 8;
const DUP_GROUP_CAP: usize = 100;

const SYSTEM: &str = "You are the FileOrganizer assistant, a careful helper that acts on the user's local files. \
Use the read-only tools (search_files, list_folder, find_duplicates, index_stats) freely to investigate before answering. \
The trash_files and move_files tools are destructive: they are NOT run automatically. When you call one, it is shown to the user as a proposed action they must approve, and only runs after approval. \
Never claim you have trashed, moved, deleted, or organized anything before the user has approved it. Always explain your intent clearly and keep proposals small and specific. \
Trashing a file can be restored from the Trash view at any time. Moves and organizing are not shown in Trash; they can only be reversed with \"Undo last\" right after the operation.";

/// A destructive tool the model requested; surfaced to the UI for approval.
#[derive(Debug, Clone, Serialize)]
pub struct PendingAction {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub args: Value,
}

/// One turn of the agent loop: updated transcript plus either a final answer or
/// a set of destructive actions awaiting approval.
#[derive(Debug, Clone, Serialize)]
pub struct AgentResult {
    pub messages: Value,
    pub pending: Vec<PendingAction>,
    pub final_text: Option<String>,
    pub done: bool,
}

/// Index-side follow-up work for a destructive filesystem change, produced by the
/// trash phase so the two locks never overlap.
enum IndexFollowup {
    Remove(Vec<PathBuf>),
    Moved {
        remove: Vec<PathBuf>,
        upsert: Vec<PathBuf>,
    },
}

fn tools() -> Value {
    json!([
        {"type": "function", "function": {
            "name": "search_files",
            "description": "Substring filename search over the index. Returns matching files with path, name and size.",
            "parameters": {"type": "object", "properties": {
                "query": {"type": "string", "description": "Substring to match in filenames."},
                "limit": {"type": "integer", "description": "Max results (default 50)."}
            }, "required": ["query"]}
        }},
        {"type": "function", "function": {
            "name": "list_folder",
            "description": "List the direct children of a folder: name, size and whether each is a directory.",
            "parameters": {"type": "object", "properties": {
                "path": {"type": "string", "description": "Absolute folder path."}
            }, "required": ["path"]}
        }},
        {"type": "function", "function": {
            "name": "find_duplicates",
            "description": "Find groups of identical files under a folder. Returns hash, size, wasted bytes and paths per group.",
            "parameters": {"type": "object", "properties": {
                "root": {"type": "string", "description": "Absolute folder path to scan."}
            }, "required": ["root"]}
        }},
        {"type": "function", "function": {
            "name": "index_stats",
            "description": "Report how many files are currently indexed.",
            "parameters": {"type": "object", "properties": {}}
        }},
        {"type": "function", "function": {
            "name": "trash_files",
            "description": "Move files to Trash (reversible). Requires user approval before it runs; explain why first.",
            "parameters": {"type": "object", "properties": {
                "paths": {"type": "array", "items": {"type": "string"}, "description": "Absolute file paths to trash."}
            }, "required": ["paths"]}
        }},
        {"type": "function", "function": {
            "name": "move_files",
            "description": "Move or rename files (reversible). Requires user approval before it runs; explain why first.",
            "parameters": {"type": "object", "properties": {
                "moves": {"type": "array", "items": {"type": "object", "properties": {
                    "from": {"type": "string"}, "to": {"type": "string"}
                }, "required": ["from", "to"]}, "description": "From/to absolute path pairs."}
            }, "required": ["moves"]}
        }}
    ])
}

fn is_destructive(name: &str) -> bool {
    matches!(name, "trash_files" | "move_files")
}

/// Human one-liner for a pending destructive action card.
fn summarize(name: &str, args: &Value) -> String {
    match name {
        "trash_files" => {
            let paths = args["paths"].as_array().cloned().unwrap_or_default();
            let names: Vec<String> = paths
                .iter()
                .filter_map(|p| p.as_str())
                .take(3)
                .map(|p| {
                    Path::new(p)
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| p.to_string())
                })
                .collect();
            let more = if paths.len() > 3 {
                format!(", +{} more", paths.len() - 3)
            } else {
                String::new()
            };
            let plural = if paths.len() == 1 { "" } else { "s" };
            format!(
                "Move {} file{} to Trash: {}{}",
                paths.len(),
                plural,
                names.join(", "),
                more
            )
        }
        "move_files" => {
            let moves = args["moves"].as_array().cloned().unwrap_or_default();
            let plural = if moves.len() == 1 { "" } else { "s" };
            let dest = moves
                .first()
                .and_then(|m| m["to"].as_str())
                .and_then(|t| {
                    Path::new(t)
                        .parent()
                        .and_then(|p| p.file_name())
                        .map(|s| s.to_string_lossy().to_string())
                })
                .unwrap_or_default();
            if dest.is_empty() {
                format!("Move {} file{}", moves.len(), plural)
            } else {
                format!("Move {} file{} into {}/", moves.len(), plural, dest)
            }
        }
        _ => name.to_string(),
    }
}

/// Run a read-only tool and return its JSON result. Never mutates anything.
fn execute_read_tool(name: &str, args: &Value, index: &Index) -> Result<Value> {
    match name {
        "search_files" => {
            let query = args["query"].as_str().unwrap_or("");
            let limit = args["limit"].as_i64().unwrap_or(50);
            let opts = SearchOpts {
                limit: Some(limit),
                ..Default::default()
            };
            let hits = index.search(query, &opts)?;
            let out: Vec<Value> = hits
                .iter()
                .map(|h| json!({"path": h.path, "name": h.name, "size": h.size}))
                .collect();
            Ok(json!({"count": out.len(), "results": out}))
        }
        "list_folder" => {
            let path = args["path"]
                .as_str()
                .ok_or_else(|| anyhow!("missing path"))?;
            let mut children = Vec::new();
            for entry in fs::read_dir(path)?.flatten() {
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                children.push(json!({
                    "name": entry.file_name().to_string_lossy().to_string(),
                    "size": meta.len(),
                    "is_dir": meta.is_dir()
                }));
            }
            Ok(json!({"count": children.len(), "children": children}))
        }
        "find_duplicates" => {
            let root = args["root"]
                .as_str()
                .ok_or_else(|| anyhow!("missing root"))?;
            let entries = WalkdirSource.enumerate(Path::new(root))?;
            let groups = find_duplicates(&entries, HashAlgo::Blake3, |_, _| {});
            let out: Vec<Value> = groups
                .iter()
                .take(DUP_GROUP_CAP)
                .map(|g| {
                    json!({
                        "hash": g.hash,
                        "size": g.size,
                        "wasted": g.size * (g.paths.len() as u64 - 1),
                        "paths": g.paths.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>()
                    })
                })
                .collect();
            Ok(json!({"group_count": groups.len(), "groups": out}))
        }
        "index_stats" => Ok(json!({"indexed": index.count()?})),
        _ => Err(anyhow!("unknown read tool: {}", name)),
    }
}

/// Perform the filesystem/journal side of a destructive tool and describe the
/// index follow-up. Locks only the trash; the caller applies the follow-up under
/// the index lock so the two locks never overlap.
fn destructive_trash_phase(
    name: &str,
    args: &Value,
    trash: &Trash,
) -> Result<(Value, IndexFollowup)> {
    match name {
        "trash_files" => {
            let paths: Vec<PathBuf> = args["paths"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|p| p.as_str())
                        .map(PathBuf::from)
                        .collect()
                })
                .unwrap_or_default();
            let op = trash.trash_files(&paths, "ai", None)?;
            let removed: Vec<PathBuf> = op
                .items
                .iter()
                .map(|i| PathBuf::from(&i.original_path))
                .collect();
            Ok((
                json!({"trashed": op.items.len(), "op_id": op.id}),
                IndexFollowup::Remove(removed),
            ))
        }
        "move_files" => {
            let pairs: Vec<(PathBuf, PathBuf)> = args["moves"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|m| {
                            Some((
                                PathBuf::from(m["from"].as_str()?),
                                PathBuf::from(m["to"].as_str()?),
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let op = trash.apply_moves(&pairs, "ai-move")?;
            let remove: Vec<PathBuf> = op
                .items
                .iter()
                .map(|i| PathBuf::from(&i.original_path))
                .collect();
            let upsert: Vec<PathBuf> = op
                .items
                .iter()
                .map(|i| PathBuf::from(&i.stored_path))
                .collect();
            Ok((
                json!({"moved": op.items.len(), "op_id": op.id}),
                IndexFollowup::Moved { remove, upsert },
            ))
        }
        _ => Err(anyhow!("unknown destructive tool: {}", name)),
    }
}

fn apply_followup(index: &mut Index, followup: IndexFollowup) {
    match followup {
        IndexFollowup::Remove(paths) => {
            for p in &paths {
                let _ = index.remove_path(p);
            }
        }
        IndexFollowup::Moved { remove, upsert } => {
            for p in &remove {
                let _ = index.remove_path(p);
            }
            let entries = stat_entries(&upsert);
            if !entries.is_empty() {
                let _ = index.upsert_batch(&entries);
            }
        }
    }
}

/// Run a destructive tool end to end against borrowed stores. Used by the command
/// layer (via `dispatch_destructive`, which supplies non-overlapping locks) and by
/// tests. Trash phase runs first, then the index follow-up.
#[cfg_attr(not(test), allow(dead_code))]
pub fn execute_destructive_tool(
    name: &str,
    args: &Value,
    index: &mut Index,
    trash: &Trash,
) -> Result<Value> {
    let (result, followup) = destructive_trash_phase(name, args, trash)?;
    apply_followup(index, followup);
    Ok(result)
}

/// Command-layer destructive dispatch: trash lock then index lock, non-overlapping.
fn dispatch_destructive(state: &AppState, name: &str, args: &Value) -> Result<Value> {
    let (result, followup) = {
        let trash = state.trash.lock().unwrap();
        destructive_trash_phase(name, args, &trash)?
    };
    {
        let mut index = state.index.lock().unwrap();
        apply_followup(&mut index, followup);
    }
    Ok(result)
}

/// Parse `function.arguments` (a JSON *string*) into a value, tolerating junk.
fn parse_args(tc: &Value) -> Value {
    tc["function"]["arguments"]
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}))
}

fn push_message(messages: &mut Value, msg: Value) {
    if let Some(arr) = messages.as_array_mut() {
        arr.push(msg);
    }
}

async fn run_loop(
    client: &OpenRouter,
    mut messages: Value,
    state: &AppState,
    app: &AppHandle,
) -> Result<AgentResult> {
    for _ in 0..MAX_STEPS {
        let _ = app.emit("ai:step", json!({"kind": "thinking"}));
        let msg = client
            .chat_raw_stream(messages.clone(), Some(tools()), |delta| {
                let _ = app.emit("ai:delta", delta);
            })
            .await?;
        push_message(&mut messages, msg.clone());
        let tool_calls: Vec<Value> = msg["tool_calls"].as_array().cloned().unwrap_or_default();
        if tool_calls.is_empty() {
            let final_text = msg["content"].as_str().map(|s| s.to_string());
            let _ = app.emit("ai:done", ());
            return Ok(AgentResult {
                messages,
                pending: Vec::new(),
                final_text,
                done: true,
            });
        }
        let (destructive, reads): (Vec<Value>, Vec<Value>) = tool_calls
            .into_iter()
            .partition(|tc| is_destructive(tc["function"]["name"].as_str().unwrap_or("")));
        // Always answer the read calls first, even when destructive calls are also
        // present in this turn: every tool_call must get a tool response before the
        // next model request, or the API rejects the transcript.
        let mut tool_msgs = Vec::new();
        {
            let index = state.index.lock().unwrap();
            for tc in &reads {
                let id = tc["id"].as_str().unwrap_or("");
                let name = tc["function"]["name"].as_str().unwrap_or("");
                let args = parse_args(tc);
                let _ = app.emit("ai:step", json!({"kind": "tool", "name": name}));
                let content = match execute_read_tool(name, &args, &index) {
                    Ok(v) => v.to_string(),
                    Err(e) => format!("Error: {}", e),
                };
                let _ = app.emit("ai:step", json!({"kind": "tool_done", "name": name}));
                tool_msgs.push(json!({"role": "tool", "tool_call_id": id, "content": content}));
            }
        }
        for m in tool_msgs {
            push_message(&mut messages, m);
        }
        if !destructive.is_empty() {
            let pending = destructive
                .iter()
                .map(|tc| {
                    let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                    let args = parse_args(tc);
                    PendingAction {
                        id: tc["id"].as_str().unwrap_or("").to_string(),
                        summary: summarize(&name, &args),
                        name,
                        args,
                    }
                })
                .collect();
            let final_text = msg["content"].as_str().map(|s| s.to_string());
            let _ = app.emit("ai:step", json!({"kind": "awaiting_approval"}));
            let _ = app.emit("ai:done", ());
            return Ok(AgentResult {
                messages,
                pending,
                final_text,
                done: false,
            });
        }
    }
    let _ = app.emit("ai:done", ());
    Ok(AgentResult {
        messages,
        pending: Vec::new(),
        final_text: Some("Stopped after too many steps.".to_string()),
        done: true,
    })
}

fn starts_with_system(messages: &Value) -> bool {
    messages
        .as_array()
        .and_then(|a| a.first())
        .and_then(|m| m["role"].as_str())
        == Some("system")
}

#[tauri::command]
pub async fn ai_agent(
    messages: Value,
    model: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AgentResult, String> {
    let key = crate::get_key().ok_or_else(|| "No API key set".to_string())?;
    let client = OpenRouter::new(key, model);
    let mut messages = messages;
    if !starts_with_system(&messages) {
        if let Some(arr) = messages.as_array_mut() {
            arr.insert(0, json!({"role": "system", "content": SYSTEM}));
        }
    }
    run_loop(&client, messages, state.inner(), &app)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_agent_continue(
    messages: Value,
    approvals: Value,
    model: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AgentResult, String> {
    let key = crate::get_key().ok_or_else(|| "No API key set".to_string())?;
    let client = OpenRouter::new(key, model);
    let mut messages = messages;
    let approved = |id: &str| -> bool {
        approvals
            .as_array()
            .map(|a| {
                a.iter()
                    .any(|x| x["id"].as_str() == Some(id) && x["approved"].as_bool() == Some(true))
            })
            .unwrap_or(false)
    };
    let pending_calls: Vec<Value> = messages
        .as_array()
        .and_then(|a| {
            a.iter()
                .rev()
                .find(|m| m["role"].as_str() == Some("assistant"))
        })
        .and_then(|m| m["tool_calls"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|tc| is_destructive(tc["function"]["name"].as_str().unwrap_or("")))
        .collect();
    let mut tool_msgs = Vec::new();
    for tc in &pending_calls {
        let id = tc["id"].as_str().unwrap_or("");
        let name = tc["function"]["name"].as_str().unwrap_or("");
        let content = if approved(id) {
            let args = parse_args(tc);
            match dispatch_destructive(state.inner(), name, &args) {
                Ok(v) => v.to_string(),
                Err(e) => format!("Error: {}", e),
            }
        } else {
            "User declined this action.".to_string()
        };
        tool_msgs.push(json!({"role": "tool", "tool_call_id": id, "content": content}));
    }
    for m in tool_msgs {
        push_message(&mut messages, m);
    }
    run_loop(&client, messages, state.inner(), &app)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fo_indexer::WalkdirSource;

    #[test]
    fn trash_files_removes_from_disk_index_and_journal() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        let a = src.join("a.txt");
        let b = src.join("b.txt");
        fs::write(&a, b"aaa").unwrap();
        fs::write(&b, b"bbb").unwrap();
        let entries = WalkdirSource.enumerate(&src).unwrap();
        let mut index = Index::open(&dir.path().join("index.db")).unwrap();
        index.upsert_batch(&entries).unwrap();
        assert_eq!(index.count().unwrap(), 2);
        let trash = Trash::open(&dir.path().join("data")).unwrap();
        let args = json!({"paths": [a.to_string_lossy(), b.to_string_lossy()]});
        let out = execute_destructive_tool("trash_files", &args, &mut index, &trash).unwrap();
        assert_eq!(out["trashed"].as_u64(), Some(2));
        assert!(!a.exists() && !b.exists());
        assert_eq!(trash.list(None, 10).unwrap().len(), 2);
        assert_eq!(index.count().unwrap(), 0);
        assert!(index
            .search("a.txt", &SearchOpts::default())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn summarize_shapes() {
        let s = summarize(
            "trash_files",
            &json!({"paths": ["/x/a.pdf", "/x/b.pdf", "/x/c.pdf"]}),
        );
        assert_eq!(s, "Move 3 files to Trash: a.pdf, b.pdf, c.pdf");
        let s = summarize(
            "move_files",
            &json!({"moves": [{"from": "/x/a.jpg", "to": "/x/Photos/a.jpg"}]}),
        );
        assert_eq!(s, "Move 1 file into Photos/");
    }
}
