use crate::{stat_entries, AppState};
use anyhow::{anyhow, Result};
use fo_ai::OpenRouter;
use fo_dedup::find_duplicates;
use fo_hasher::HashAlgo;
use fo_indexer::{FileSource, WalkdirSource};
use fo_rules::{match_rule, RuleAction, RuleFilter, Rules};
use fo_search::{Index, SearchOpts};
use fo_trash::Trash;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

const MAX_STEPS: usize = 8;
const DUP_GROUP_CAP: usize = 100;

const SYSTEM: &str = "You are the FileOrganizer assistant. You help the user understand and tidy the files on their own machine.\n\n\
Investigating: use the read-only tools freely before you answer. search_files finds files by name, list_folder reads a directory, find_duplicates finds byte-identical copies, index_stats reports how many files are indexed, storage_stats gives the disk picture (total size, biggest files, size by type), list_rules shows the user's saved rules, and preview_rule counts what a candidate rule would match. Look before you conclude; do not guess at file names, sizes, or counts you have not checked.\n\n\
Acting: trash_files, move_files and create_rule are never run automatically. When you call one, the user sees it as a proposed action with the exact files listed, and it only happens if they approve. So never say you have trashed, moved, organized, or saved anything before approval comes back. Say what you intend to do, and keep each proposal small and specific.\n\n\
How Trash works, because it is the safety net worth explaining when it matters: trashing never deletes. The file is moved into the app's own quarantine folder and journaled with its original path, so the user can restore it from the Trash view at any time, or undo the whole batch with Undo last. Moves and organizing are reversible too, but only through Undo last right after the operation, since they are not listed in Trash. You have no way to delete anything permanently; only the user can do that, from the Trash view.\n\n\
Rules are saved filters the user can re-run: a filter (name, extension, size, age, folder) plus one action (move to Trash, or move to a folder). When a cleanup looks like it will recur, offer to save it as a rule, and use preview_rule first so you can say exactly how many files it would catch. Sizes in filters are bytes, and older_than_days counts days since a file was last modified.\n\n\
For questions about space, prefer storage_stats over guessing or listing folders one by one.\n\n\
Writing: your replies are rendered as markdown. Use short paragraphs, bulleted lists for more than two items, and `inline code` for file names and paths. Keep it brief and concrete: numbers, sizes and real paths beat adjectives. Do not pad answers by restating the question.";

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
    /// (from, to, is_dir) per moved item. A moved folder repoints every indexed
    /// path beneath it; a moved file is just removed and re-added.
    Moved {
        moved: Vec<(PathBuf, PathBuf, bool)>,
    },
}

/// JSON schema for a `RuleFilter`, shared by `preview_rule` and `create_rule`.
fn rule_filter_schema() -> Value {
    json!({
        "type": "object",
        "description": "Filter selecting files from the index. Every field is optional; populated fields are ANDed together, an empty filter matches everything.",
        "properties": {
            "name_contains": {"type": "string", "description": "Substring that must appear in the filename."},
            "ext": {"type": "string", "description": "File extension without the dot, e.g. \"pdf\"."},
            "min_size": {"type": "integer", "description": "Minimum file size in BYTES."},
            "max_size": {"type": "integer", "description": "Maximum file size in BYTES."},
            "older_than_days": {"type": "integer", "description": "Only files whose last modification is at least this many days ago."},
            "in_folder": {"type": "string", "description": "Absolute folder path; matches files anywhere beneath it."}
        }
    })
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
            "name": "storage_stats",
            "description": "Storage overview of the indexed files: total count, total bytes, the largest files, and bytes grouped by extension. Use this to answer what is taking up space.",
            "parameters": {"type": "object", "properties": {}}
        }},
        {"type": "function", "function": {
            "name": "list_rules",
            "description": "List the user's saved cleanup rules, with each rule's filter, action and last run stats.",
            "parameters": {"type": "object", "properties": {}}
        }},
        {"type": "function", "function": {
            "name": "preview_rule",
            "description": "Count the files a candidate rule filter would match right now. Saves nothing and touches no files; use it to check a filter before proposing create_rule.",
            "parameters": {"type": "object", "properties": {
                "filter": rule_filter_schema()
            }, "required": ["filter"]}
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
        }},
        {"type": "function", "function": {
            "name": "create_rule",
            "description": "Save a reusable cleanup rule. It stores configuration only and never touches files by itself, but it requires user approval before it is saved; preview the filter first and explain what the rule would do.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "Short human name for the rule."},
                "filter": rule_filter_schema(),
                "action": {"type": "object", "description": "What the rule does with matched files.", "properties": {
                    "type": {"type": "string", "enum": ["Trash", "MoveTo"], "description": "\"Trash\" moves matches to Trash; \"MoveTo\" moves them into a folder."},
                    "folder": {"type": "string", "description": "Absolute destination folder. Required when type is \"MoveTo\"."}
                }, "required": ["type"]}
            }, "required": ["name", "filter", "action"]}
        }}
    ])
}

fn is_destructive(name: &str) -> bool {
    matches!(name, "trash_files" | "move_files" | "create_rule")
}

/// Human one-liner for a pending destructive action card.
fn summarize(name: &str, args: &Value) -> String {
    match name {
        "trash_files" => {
            let paths = args["paths"].as_array().cloned().unwrap_or_default();
            let dirs = paths
                .iter()
                .filter_map(|p| p.as_str())
                .filter(|p| Path::new(p).is_dir())
                .count();
            let names: Vec<String> = paths
                .iter()
                .filter_map(|p| p.as_str())
                .take(3)
                .map(|p| {
                    let name = Path::new(p)
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| p.to_string());
                    // a folder must never read as a file in a proposal card
                    if dirs > 0 && dirs < paths.len() && Path::new(p).is_dir() {
                        format!("{} (folder)", name)
                    } else {
                        name
                    }
                })
                .collect();
            let more = if paths.len() > 3 {
                format!(", +{} more", paths.len() - 3)
            } else {
                String::new()
            };
            let noun = if dirs == 0 {
                "file"
            } else if dirs == paths.len() {
                "folder"
            } else {
                "item"
            };
            let plural = if paths.len() == 1 { "" } else { "s" };
            format!(
                "Move {} {}{} to Trash: {}{}",
                paths.len(),
                noun,
                plural,
                names.join(", "),
                more
            )
        }
        "move_files" => {
            let moves = args["moves"].as_array().cloned().unwrap_or_default();
            let dirs = moves
                .iter()
                .filter_map(|m| m["from"].as_str())
                .filter(|p| Path::new(p).is_dir())
                .count();
            let noun = if dirs == 0 {
                "file"
            } else if dirs == moves.len() {
                "folder"
            } else {
                "item"
            };
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
                format!("Move {} {}{}", moves.len(), noun, plural)
            } else {
                format!("Move {} {}{} into {}/", moves.len(), noun, plural, dest)
            }
        }
        "create_rule" => {
            let rule = args["name"].as_str().unwrap_or("untitled");
            let dest = match args["action"]["type"].as_str() {
                Some("MoveTo") => args["action"]["folder"].as_str().unwrap_or("a folder"),
                _ => "Trash",
            };
            format!(
                "Save a rule \"{}\" that moves matching files to {}",
                rule, dest
            )
        }
        _ => name.to_string(),
    }
}

/// Run a read-only tool and return its JSON result. Never mutates anything.
fn execute_read_tool(name: &str, args: &Value, index: &Index, rules: &Rules) -> Result<Value> {
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
        "storage_stats" => {
            let largest: Vec<Value> = index
                .largest_files(15)?
                .iter()
                .map(|h| json!({"path": h.path, "name": h.name, "size": h.size}))
                .collect();
            let by_ext: Vec<Value> = index
                .size_by_ext(10)?
                .iter()
                .map(|e| json!({"ext": e.ext, "count": e.count, "total_size": e.total_size}))
                .collect();
            Ok(json!({
                "files": index.count()?,
                "total_size": index.total_size()?,
                "largest": largest,
                "by_ext": by_ext
            }))
        }
        "list_rules" => {
            let out: Vec<Value> = rules
                .list()?
                .iter()
                .map(|r| {
                    json!({
                        "id": r.id,
                        "name": r.name,
                        "filter": r.filter,
                        "action": r.action,
                        "last_run_count": r.last_run_count,
                        "last_run_ns": r.last_run_ns
                    })
                })
                .collect();
            Ok(json!({"count": out.len(), "rules": out}))
        }
        "preview_rule" => {
            let filter: RuleFilter = serde_json::from_value(args["filter"].clone())
                .map_err(|e| anyhow!("invalid filter: {}", e))?;
            let hits = match_rule(index, &filter, 200)?;
            let sample: Vec<Value> = hits
                .iter()
                .take(20)
                .map(|h| json!({"path": h.path, "name": h.name, "size": h.size}))
                .collect();
            Ok(json!({"count": hits.len(), "sample": sample}))
        }
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
                json!({"trashed": op.items.len(), "op_id": op.id, "skipped": op.skipped}),
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
            let moved: Vec<(PathBuf, PathBuf, bool)> = op
                .items
                .iter()
                .map(|i| {
                    (
                        PathBuf::from(&i.original_path),
                        PathBuf::from(&i.stored_path),
                        i.is_dir,
                    )
                })
                .collect();
            Ok((
                json!({"moved": op.items.len(), "op_id": op.id, "skipped": op.skipped}),
                IndexFollowup::Moved { moved },
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
        IndexFollowup::Moved { moved } => {
            let mut upsert = Vec::new();
            for (from, to, is_dir) in &moved {
                let _ = index.remove_path(from);
                if *is_dir {
                    let _ = index.reparent(from, to);
                } else {
                    upsert.push(to.clone());
                }
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

/// Approval-gated but not a filesystem change: stores a reusable rule. Needs only
/// the rules store, so it never touches the trash or index locks.
fn create_rule_tool(args: &Value, rules: &Rules) -> Result<Value> {
    let name = args["name"]
        .as_str()
        .ok_or_else(|| anyhow!("missing rule name"))?;
    let filter: RuleFilter = serde_json::from_value(args["filter"].clone())
        .map_err(|e| anyhow!("invalid filter: {}", e))?;
    let action: RuleAction = serde_json::from_value(args["action"].clone())
        .map_err(|e| anyhow!("invalid action (expected {{\"type\":\"Trash\"}} or {{\"type\":\"MoveTo\",\"folder\":\"/abs/dir\"}}): {}", e))?;
    let rule = rules.create(name, filter, action)?;
    Ok(json!({"created": true, "id": rule.id, "name": rule.name}))
}

/// Command-layer destructive dispatch: each tool runs under exactly the locks it
/// needs, in non-overlapping scopes.
fn dispatch_destructive(state: &AppState, name: &str, args: &Value) -> Result<Value> {
    if name == "create_rule" {
        let rules = state.rules.lock().unwrap();
        return create_rule_tool(args, &rules);
    }
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
            let rules = state.rules.lock().unwrap();
            for tc in &reads {
                let id = tc["id"].as_str().unwrap_or("");
                let name = tc["function"]["name"].as_str().unwrap_or("");
                let args = parse_args(tc);
                let _ = app.emit("ai:step", json!({"kind": "tool", "name": name}));
                let content = match execute_read_tool(name, &args, &index, &rules) {
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

    #[test]
    fn summarize_labels_directories_as_folders() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("Photos");
        std::fs::create_dir_all(&folder).unwrap();
        let file = dir.path().join("report.pdf");
        std::fs::write(&file, b"pdf").unwrap();
        let s = summarize("trash_files", &json!({"paths": [folder.to_str().unwrap()]}));
        assert_eq!(s, "Move 1 folder to Trash: Photos");
        // mixed batch: neutral noun, and the folder is marked as one
        let s = summarize(
            "trash_files",
            &json!({"paths": [file.to_str().unwrap(), folder.to_str().unwrap()]}),
        );
        assert_eq!(s, "Move 2 items to Trash: report.pdf, Photos (folder)");
        let s = summarize(
            "move_files",
            &json!({"moves": [{"from": folder.to_str().unwrap(), "to": "/x/Sorted/Photos"}]}),
        );
        assert_eq!(s, "Move 1 folder into Sorted/");
    }

    #[test]
    fn summarize_create_rule_shapes() {
        let s = summarize(
            "create_rule",
            &json!({"name": "Old invoices", "filter": {"ext": "pdf"}, "action": {"type": "MoveTo", "folder": "/Users/x/Documents/Invoices"}}),
        );
        assert_eq!(
            s,
            "Save a rule \"Old invoices\" that moves matching files to /Users/x/Documents/Invoices"
        );
        let s = summarize(
            "create_rule",
            &json!({"name": "Big downloads", "filter": {"min_size": 1000}, "action": {"type": "Trash"}}),
        );
        assert_eq!(
            s,
            "Save a rule \"Big downloads\" that moves matching files to Trash"
        );
    }

    #[test]
    fn create_rule_is_approval_gated_and_reads_are_not() {
        assert!(is_destructive("create_rule"));
        assert!(is_destructive("trash_files"));
        assert!(is_destructive("move_files"));
        for name in [
            "search_files",
            "list_folder",
            "find_duplicates",
            "index_stats",
            "storage_stats",
            "list_rules",
            "preview_rule",
        ] {
            assert!(!is_destructive(name), "{} must auto-run", name);
        }
        // the model must never be handed a way to delete permanently
        let names: Vec<String> = tools()
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap().to_string())
            .collect();
        assert!(!names.iter().any(|n| n.contains("purge")
            || n.contains("delete")
            || n.contains("empty")
            || n.contains("clear")));
    }

    #[test]
    fn preview_rule_counts_and_samples_without_saving() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.pdf"), vec![0u8; 300]).unwrap();
        fs::write(src.join("b.pdf"), vec![0u8; 100]).unwrap();
        fs::write(src.join("c.txt"), vec![0u8; 200]).unwrap();
        let entries = WalkdirSource.enumerate(&src).unwrap();
        let mut index = Index::open(&dir.path().join("index.db")).unwrap();
        index.upsert_batch(&entries).unwrap();
        let rules = Rules::open(dir.path()).unwrap();
        let out = execute_read_tool(
            "preview_rule",
            &json!({"filter": {"ext": "pdf"}}),
            &index,
            &rules,
        )
        .unwrap();
        assert_eq!(out["count"].as_u64(), Some(2));
        assert_eq!(out["sample"][0]["name"].as_str(), Some("a.pdf"));
        assert!(rules.list().unwrap().is_empty());
        // a malformed filter is reported, not panicked on
        assert!(execute_read_tool(
            "preview_rule",
            &json!({"filter": {"ext": 12}}),
            &index,
            &rules
        )
        .is_err());
    }

    #[test]
    fn create_rule_persists_and_is_listed() {
        let dir = tempfile::tempdir().unwrap();
        let rules = Rules::open(dir.path()).unwrap();
        let index = Index::open(&dir.path().join("index.db")).unwrap();
        let args = json!({
            "name": "Old invoices",
            "filter": {"ext": "pdf", "older_than_days": 90},
            "action": {"type": "MoveTo", "folder": "/Users/x/Documents/Invoices"}
        });
        let out = create_rule_tool(&args, &rules).unwrap();
        assert_eq!(out["created"].as_bool(), Some(true));
        let id = out["id"].as_str().unwrap();
        let saved = rules.get(id).unwrap().unwrap();
        assert_eq!(saved.name, "Old invoices");
        assert_eq!(saved.filter.older_than_days, Some(90));
        assert_eq!(
            saved.action,
            RuleAction::MoveTo {
                folder: "/Users/x/Documents/Invoices".to_string()
            }
        );
        let listed = execute_read_tool("list_rules", &json!({}), &index, &rules).unwrap();
        assert_eq!(listed["count"].as_u64(), Some(1));
        assert_eq!(listed["rules"][0]["id"].as_str(), Some(id));
        assert_eq!(
            listed["rules"][0]["action"]["type"].as_str(),
            Some("MoveTo")
        );
        assert!(create_rule_tool(
            &json!({"name": "bad", "filter": {}, "action": {"type": "Nope"}}),
            &rules
        )
        .is_err());
    }

    #[test]
    fn storage_stats_reports_totals() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("big.zip"), vec![0u8; 500]).unwrap();
        fs::write(src.join("small.txt"), vec![0u8; 50]).unwrap();
        let entries = WalkdirSource.enumerate(&src).unwrap();
        let mut index = Index::open(&dir.path().join("index.db")).unwrap();
        index.upsert_batch(&entries).unwrap();
        let rules = Rules::open(dir.path()).unwrap();
        let out = execute_read_tool("storage_stats", &json!({}), &index, &rules).unwrap();
        assert_eq!(out["files"].as_u64(), Some(2));
        assert_eq!(out["total_size"].as_u64(), Some(550));
        assert_eq!(out["largest"][0]["name"].as_str(), Some("big.zip"));
        assert_eq!(out["by_ext"][0]["ext"].as_str(), Some("zip"));
    }
}
