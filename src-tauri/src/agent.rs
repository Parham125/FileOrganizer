use crate::{stat_entries, AppState};
use anyhow::{anyhow, Result};
use fo_ai::OpenRouter;
use fo_archive::list_archive;
use fo_dedup::{find_duplicates, ScanMode};
use fo_hasher::HashAlgo;
use fo_indexer::{FileSource, WalkdirSource};
use fo_rules::{match_rule, RuleAction, RuleFilter, Rules};
use fo_search::{Index, SearchOpts};
use fo_trash::Trash;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use tauri::{AppHandle, Emitter, State};

const MAX_STEPS: usize = 8;
const DUP_PAGE_DEFAULT: u64 = 20;
const DUP_PAGE_MAX: u64 = 50;
const QUESTION_MAX_CHARS: usize = 500;
const OPTION_LABEL_MAX_CHARS: usize = 120;
const OPTION_DESC_MAX_CHARS: usize = 200;
const MAX_OPTIONS: usize = 6;
const DISMISSED: &str = "The user dismissed the question.";
const SEARCH_PAGE_DEFAULT: i64 = 50;
const SEARCH_PAGE_MAX: i64 = 200;
const FOLDER_PAGE_DEFAULT: u64 = 50;
const FOLDER_PAGE_MAX: u64 = 200;
const ARCHIVE_PAGE_DEFAULT: u64 = 50;
const ARCHIVE_PAGE_MAX: u64 = 200;
const RULES_CAP: usize = 100;
/// Hard ceiling on one tool result's serialized size, so no single call can
/// swallow the model's context window.
const MAX_TOOL_RESULT_BYTES: usize = 24 * 1024;

const SYSTEM: &str = "You are the FileOrganizer assistant. You help the user understand and tidy the files on their own machine.\n\n\
Investigating: use the read-only tools freely before you answer. search_files finds files by name, list_folder reads a directory, find_duplicates finds byte-identical copies, index_stats reports how many files are indexed, storage_stats gives the disk picture (total size, biggest files, size by type), list_rules shows the user's saved rules, and preview_rule counts what a candidate rule would match. Look before you conclude; do not guess at file names, sizes, or counts you have not checked.\n\n\
Asking: when the answer genuinely changes what you do next and no tool can tell you, use ask_user. It puts a real question on screen and stops until the user answers. One question at a time, short mutually exclusive options, and never for approval of an action the user already approves separately.\n\n\
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

/// One answer the user can pick for a `PendingQuestion`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

/// A question the model asked via `ask_user`, surfaced to the UI. Nothing runs
/// until the answer comes back through `ai_agent_continue`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PendingQuestion {
    pub id: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
    pub allow_text: bool,
}

/// One turn of the agent loop: updated transcript plus either a final answer, a
/// set of destructive actions awaiting approval, or a question for the user.
#[derive(Debug, Clone, Serialize)]
pub struct AgentResult {
    pub messages: Value,
    pub pending: Vec<PendingAction>,
    pub question: Option<PendingQuestion>,
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
            "description": "Substring filename search over the index, ordered by filename. Results are paged: one call returns at most `limit` files (default 50, max 200) starting at `offset`. If has_more is true, call again with offset raised by the number returned; do not retry with a larger limit.",
            "parameters": {"type": "object", "properties": {
                "query": {"type": "string", "description": "Substring to match in filenames."},
                "limit": {"type": "integer", "description": "Page size (default 50, max 200)."},
                "offset": {"type": "integer", "description": "How many results to skip (default 0). Use it to read the next page."}
            }, "required": ["query"]}
        }},
        {"type": "function", "function": {
            "name": "list_folder",
            "description": "List the direct children of a folder: name, size and whether each is a directory. Directories are listed first, then files, both by name. Results are paged: one call returns at most `limit` children (default 50, max 200) starting at `offset`, while `total` is always the true number of children. If has_more is true, call again with offset raised by the number returned.",
            "parameters": {"type": "object", "properties": {
                "path": {"type": "string", "description": "Absolute folder path."},
                "limit": {"type": "integer", "description": "Page size (default 50, max 200)."},
                "offset": {"type": "integer", "description": "How many children to skip (default 0). Use it to read the next page."}
            }, "required": ["path"]}
        }},
        {"type": "function", "function": {
            "name": "find_duplicates",
            "description": "Find groups of identical files under a folder. Returns hash, size, wasted bytes and paths per group, biggest waste first. Results are paged: one call returns at most `limit` groups (default 20, max 50) starting at `offset`, while `group_count` is always the true number of groups found. If has_more is true, call again with offset raised by the number returned; do not retry with a larger limit.",
            "parameters": {"type": "object", "properties": {
                "root": {"type": "string", "description": "Absolute folder path to scan."},
                "limit": {"type": "integer", "description": "Page size (default 20, max 50)."},
                "offset": {"type": "integer", "description": "How many groups to skip (default 0). Use it to read the next page."}
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
            "description": "List the user's saved cleanup rules, with each rule's filter, action and last run stats. At most 100 rules are returned; count is always the true total.",
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
            "name": "list_archive",
            "description": "List what is inside a .zip/.tar/.tar.gz/.7z archive without extracting it. Returns each member's name, uncompressed size and whether it is a folder, plus the archive's total entry count and uncompressed size. Entries are paged: one call returns at most `limit` of them (default 50, max 200) starting at `offset`, while entry_count is always the true total. If has_more is true, call again with offset raised by the number returned.",
            "parameters": {"type": "object", "properties": {
                "path": {"type": "string", "description": "Absolute path to the archive file."},
                "limit": {"type": "integer", "description": "Page size (default 50, max 200)."},
                "offset": {"type": "integer", "description": "How many entries to skip (default 0). Use it to read the next page."}
            }, "required": ["path"]}
        }},
        {"type": "function", "function": {
            "name": "ask_user",
            "description": "Ask the user one question and wait for their answer. It is shown in the chat as a real question with buttons, and nothing else happens until they respond. Use it when their answer genuinely changes what you do next: which folder to organize, which copy of a duplicate to keep, whether to sort by date or by type. Do not use it for anything a read-only tool can tell you, and do not use it to ask for approval of trash_files, move_files or create_rule, which the user already approves separately. Keep options short, concrete and mutually exclusive, and ask only one question at a time.",
            "parameters": {"type": "object", "properties": {
                "question": {"type": "string", "description": "The question to show the user. One sentence, plain language."},
                "options": {"type": "array", "description": "Up to 6 answers to offer as buttons. Leave it out when the answer is open ended.", "items": {"type": "object", "properties": {
                    "label": {"type": "string", "description": "Short answer text, a few words."},
                    "description": {"type": "string", "description": "Optional one-line clarification of what this choice means."}
                }, "required": ["label"]}},
                "multi_select": {"type": "boolean", "description": "Allow picking more than one option (default false)."},
                "allow_text": {"type": "boolean", "description": "Also let the user type a free-text answer (default false). Forced on when no options are given."}
            }, "required": ["question"]}
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

/// Changes nothing, but still cannot be auto-executed: the loop has to stop and
/// let the user answer. Kept separate from `is_destructive`, which means "real
/// file mutation" and gates the approval path.
fn is_interactive(name: &str) -> bool {
    matches!(name, "ask_user")
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// Build a `PendingQuestion` from an `ask_user` call, defending against whatever
/// the model actually emitted: options are capped and de-junked, strings are
/// clipped, and a question with no way to answer it is given a text box.
fn parse_question(id: &str, args: &Value) -> PendingQuestion {
    let options: Vec<QuestionOption> = args["options"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|o| {
                    let label = o["label"].as_str().unwrap_or("").trim();
                    if label.is_empty() {
                        return None;
                    }
                    Some(QuestionOption {
                        label: truncate_chars(label, OPTION_LABEL_MAX_CHARS),
                        description: o["description"]
                            .as_str()
                            .map(|d| d.trim())
                            .filter(|d| !d.is_empty())
                            .map(|d| truncate_chars(d, OPTION_DESC_MAX_CHARS)),
                    })
                })
                .take(MAX_OPTIONS)
                .collect()
        })
        .unwrap_or_default();
    let allow_text = args["allow_text"].as_bool().unwrap_or(false) || options.is_empty();
    PendingQuestion {
        id: id.to_string(),
        question: truncate_chars(
            args["question"].as_str().unwrap_or("").trim(),
            QUESTION_MAX_CHARS,
        ),
        multi_select: args["multi_select"].as_bool().unwrap_or(false) && !options.is_empty(),
        options,
        allow_text,
    }
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

/// Read-only tool result, before the size backstop is applied.
fn run_read_tool(name: &str, args: &Value, index: &Index, rules: &Rules) -> Result<Value> {
    match name {
        "search_files" => {
            let query = args["query"].as_str().unwrap_or("");
            let limit = args["limit"]
                .as_i64()
                .unwrap_or(SEARCH_PAGE_DEFAULT)
                .clamp(1, SEARCH_PAGE_MAX);
            let offset = args["offset"].as_i64().unwrap_or(0).max(0);
            // one row past the page tells us whether another page exists without
            // counting the whole match set
            let opts = SearchOpts {
                limit: Some(offset + limit + 1),
                ..Default::default()
            };
            let hits = index.search(query, &opts)?;
            let page: Vec<Value> = hits
                .iter()
                .skip(offset as usize)
                .take(limit as usize)
                .map(|h| json!({"path": h.path, "name": h.name, "size": h.size}))
                .collect();
            let has_more = hits.len() as i64 > offset + limit;
            Ok(json!({
                "query": query,
                "offset": offset,
                "total_returned": page.len(),
                "has_more": has_more,
                "results": page
            }))
        }
        "list_folder" => {
            let path = args["path"]
                .as_str()
                .ok_or_else(|| anyhow!("missing path"))?;
            let limit = args["limit"]
                .as_u64()
                .unwrap_or(FOLDER_PAGE_DEFAULT)
                .clamp(1, FOLDER_PAGE_MAX) as usize;
            let offset = args["offset"].as_u64().unwrap_or(0) as usize;
            // file_type() comes off the dirent, so the full listing is cheap; only
            // the page that is actually returned pays for a stat
            let mut names: Vec<(bool, String)> = Vec::new();
            for entry in fs::read_dir(path)?.flatten() {
                let is_dir = match entry.file_type() {
                    Ok(t) => t.is_dir(),
                    Err(_) => continue,
                };
                names.push((is_dir, entry.file_name().to_string_lossy().to_string()));
            }
            let total = names.len();
            names.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
            let children: Vec<Value> = names
                .iter()
                .skip(offset)
                .take(limit)
                .map(|(is_dir, name)| {
                    let size = fs::metadata(Path::new(path).join(name))
                        .map(|m| m.len())
                        .unwrap_or(0);
                    json!({"name": name, "size": size, "is_dir": is_dir})
                })
                .collect();
            Ok(json!({
                "path": path,
                "total": total,
                "offset": offset,
                "returned": children.len(),
                "has_more": offset + children.len() < total,
                "children": children
            }))
        }
        "find_duplicates" => {
            let root = args["root"]
                .as_str()
                .ok_or_else(|| anyhow!("missing root"))?;
            let limit = args["limit"]
                .as_u64()
                .unwrap_or(DUP_PAGE_DEFAULT)
                .clamp(1, DUP_PAGE_MAX) as usize;
            let offset = args["offset"].as_u64().unwrap_or(0) as usize;
            let entries = WalkdirSource.enumerate(Path::new(root))?;
            let mut groups = find_duplicates(
                &entries,
                HashAlgo::Blake3,
                ScanMode::Auto,
                &AtomicBool::new(false),
                |_, _| {},
            );
            // paging is only stable if the order is: biggest waste first, then by
            // first path so equal-waste groups never swap between calls
            groups.sort_by(|a, b| {
                let wasted = |g: &fo_dedup::DupGroup| g.size * (g.paths.len() as u64 - 1);
                wasted(b)
                    .cmp(&wasted(a))
                    .then_with(|| a.paths.first().cmp(&b.paths.first()))
            });
            let page: Vec<Value> = groups
                .iter()
                .skip(offset)
                .take(limit)
                .map(|g| {
                    json!({
                        "hash": g.hash,
                        "size": g.size,
                        "wasted": g.size * (g.paths.len() as u64 - 1),
                        "paths": g.paths.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>()
                    })
                })
                .collect();
            Ok(json!({
                "group_count": groups.len(),
                "offset": offset,
                "returned": page.len(),
                "has_more": offset + page.len() < groups.len(),
                "groups": page
            }))
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
            let all = rules.list()?;
            let out: Vec<Value> = all
                .iter()
                .take(RULES_CAP)
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
            Ok(
                json!({"count": all.len(), "returned": out.len(), "truncated": all.len() > out.len(), "rules": out}),
            )
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
        "list_archive" => {
            let path = args["path"]
                .as_str()
                .ok_or_else(|| anyhow!("missing path"))?;
            let limit = args["limit"]
                .as_u64()
                .unwrap_or(ARCHIVE_PAGE_DEFAULT)
                .clamp(1, ARCHIVE_PAGE_MAX) as usize;
            let offset = args["offset"].as_u64().unwrap_or(0) as usize;
            // header reads are cheap, so paging is just a slice of the first
            // offset+limit members; entry_count stays the true total
            let listing = list_archive(Path::new(path), offset + limit)?;
            let page: Vec<Value> = listing
                .entries
                .iter()
                .skip(offset)
                .map(|e| serde_json::to_value(e).unwrap_or(Value::Null))
                .collect();
            Ok(json!({
                "format": listing.format,
                "entry_count": listing.entry_count,
                "total_uncompressed": listing.total_uncompressed,
                "offset": offset,
                "returned": page.len(),
                "has_more": offset + page.len() < listing.entry_count,
                "truncated": offset + page.len() < listing.entry_count,
                "entries": page
            }))
        }
        _ => Err(anyhow!("unknown read tool: {}", name)),
    }
}

/// Backstop for every read tool: a result that would swallow the context window
/// is cut down to its scalar fields plus a head of its biggest list, and says so.
fn cap_tool_result(value: Value) -> Value {
    if value.to_string().len() <= MAX_TOOL_RESULT_BYTES {
        return value;
    }
    let mut out = serde_json::Map::new();
    out.insert("truncated".to_string(), json!(true));
    out.insert(
        "note".to_string(),
        json!("Result too large; narrow the query or use offset/limit."),
    );
    let obj = match value.as_object() {
        Some(o) => o,
        None => {
            out.insert("partial".to_string(), Value::Null);
            return Value::Object(out);
        }
    };
    let biggest = obj
        .iter()
        .filter_map(|(k, v)| v.as_array().map(|a| (k.clone(), a)))
        .max_by_key(|(_, a)| a.len());
    for (k, v) in obj {
        if !v.is_array() {
            out.insert(k.clone(), v.clone());
        }
    }
    match biggest {
        Some((key, arr)) => {
            let mut keep = arr.len();
            while keep > 0 {
                keep /= 2;
                if Value::Array(arr[..keep].to_vec()).to_string().len() <= MAX_TOOL_RESULT_BYTES / 2
                {
                    break;
                }
            }
            out.insert("partial_field".to_string(), json!(key));
            out.insert("partial".to_string(), Value::Array(arr[..keep].to_vec()));
        }
        None => {
            out.insert("partial".to_string(), Value::Null);
        }
    }
    Value::Object(out)
}

/// Run a read-only tool and return its JSON result. Never mutates anything.
fn execute_read_tool(name: &str, args: &Value, index: &Index, rules: &Rules) -> Result<Value> {
    run_read_tool(name, args, index, rules).map(cap_tool_result)
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
            .chat_raw_stream(
                messages.clone(),
                Some(tools()),
                |delta| {
                    let _ = app.emit("ai:delta", delta);
                },
                |reasoning| {
                    let _ = app.emit("ai:reasoning", reasoning);
                },
            )
            .await?;
        // One step's token spend. The UI sums these to show what a turn cost and
        // how much of it was served from cache.
        if let Some(usage) = msg.get("usage") {
            let _ = app.emit("ai:usage", usage.clone());
        }
        push_message(&mut messages, msg.clone());
        let tool_calls: Vec<Value> = msg["tool_calls"].as_array().cloned().unwrap_or_default();
        if tool_calls.is_empty() {
            let final_text = msg["content"].as_str().map(|s| s.to_string());
            let _ = app.emit("ai:done", ());
            return Ok(AgentResult {
                messages,
                pending: Vec::new(),
                question: None,
                final_text,
                done: true,
            });
        }
        let (interactive, rest): (Vec<Value>, Vec<Value>) = tool_calls
            .into_iter()
            .partition(|tc| is_interactive(tc["function"]["name"].as_str().unwrap_or("")));
        let (destructive, reads): (Vec<Value>, Vec<Value>) = rest
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
        // only one question can be on screen at a time; any extras still need a
        // tool response or the next request is rejected
        for tc in interactive.iter().skip(1) {
            let id = tc["id"].as_str().unwrap_or("");
            tool_msgs.push(json!({"role": "tool", "tool_call_id": id, "content": "Only one question is shown at a time. Ask this one again after the first is answered."}));
        }
        for m in tool_msgs {
            push_message(&mut messages, m);
        }
        if let Some(tc) = interactive.first() {
            let question = parse_question(tc["id"].as_str().unwrap_or(""), &parse_args(tc));
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
            let _ = app.emit("ai:step", json!({"kind": "question"}));
            let _ = app.emit("ai:done", ());
            return Ok(AgentResult {
                messages,
                pending,
                question: Some(question),
                final_text,
                done: false,
            });
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
                question: None,
                final_text,
                done: false,
            });
        }
    }
    let _ = app.emit("ai:done", ());
    Ok(AgentResult {
        messages,
        pending: Vec::new(),
        question: None,
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
    let client = OpenRouter::new(key, model).with_reasoning(crate::reasoning_effort());
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

/// The tool_calls of the last assistant message that are still waiting on the
/// user, split into the two kinds the UI answers separately.
fn awaiting_calls(messages: &Value) -> (Vec<Value>, Vec<Value>) {
    let calls: Vec<Value> = messages
        .as_array()
        .and_then(|a| {
            a.iter()
                .rev()
                .find(|m| m["role"].as_str() == Some("assistant"))
        })
        .and_then(|m| m["tool_calls"].as_array().cloned())
        .unwrap_or_default();
    let name = |tc: &Value| tc["function"]["name"].as_str().unwrap_or("").to_string();
    (
        calls
            .iter()
            .filter(|tc| is_destructive(&name(tc)))
            .cloned()
            .collect(),
        calls
            .iter()
            .filter(|tc| is_interactive(&name(tc)))
            .cloned()
            .collect(),
    )
}

/// Tool responses for the `ask_user` calls the transcript is waiting on. Every
/// such call gets one, answered or not: an unanswered question reads as
/// dismissed rather than leaving a tool_call the API will reject.
fn answer_messages(messages: &Value, answers: Option<&Value>) -> Vec<Value> {
    let (_, questions) = awaiting_calls(messages);
    questions
        .iter()
        .map(|tc| {
            let id = tc["id"].as_str().unwrap_or("");
            let value = answers
                .and_then(|a| a.as_array())
                .and_then(|a| a.iter().find(|x| x["id"].as_str() == Some(id)))
                .and_then(|x| x["value"].as_str())
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
                .unwrap_or(DISMISSED);
            json!({"role": "tool", "tool_call_id": id, "content": value})
        })
        .collect()
}

#[tauri::command]
pub async fn ai_agent_continue(
    messages: Value,
    approvals: Value,
    answers: Option<Value>,
    model: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AgentResult, String> {
    let key = crate::get_key().ok_or_else(|| "No API key set".to_string())?;
    let client = OpenRouter::new(key, model).with_reasoning(crate::reasoning_effort());
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
    let (pending_calls, _) = awaiting_calls(&messages);
    let mut tool_msgs = answer_messages(&messages, answers.as_ref());
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
            assert!(!is_interactive(name), "{} must auto-run", name);
        }
        // asking a question changes nothing, so it is not destructive, but it
        // still must not auto-run
        assert!(!is_destructive("ask_user"));
        assert!(is_interactive("ask_user"));
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

    #[test]
    fn ask_user_args_are_sanitized_into_a_question() {
        let long = "q".repeat(900);
        let args = json!({
            "question": long,
            "multi_select": true,
            "options": [
                {"label": "Keep newest", "description": "Trash every older copy"},
                {"label": "  "},
                {"label": "b"}, {"label": "c"}, {"label": "d"},
                {"label": "e"}, {"label": "f"}, {"label": "g"}
            ]
        });
        let q = parse_question("call_1", &args);
        assert_eq!(q.id, "call_1");
        assert_eq!(q.question.chars().count(), QUESTION_MAX_CHARS);
        assert_eq!(q.options.len(), MAX_OPTIONS);
        assert!(q.options.iter().all(|o| !o.label.trim().is_empty()));
        assert_eq!(q.options[0].label, "Keep newest");
        assert_eq!(
            q.options[0].description.as_deref(),
            Some("Trash every older copy")
        );
        assert_eq!(q.options[1].label, "b");
        assert!(q.multi_select);
        assert!(!q.allow_text);
        // an over-long label is clipped, not dropped
        let q = parse_question(
            "call_2",
            &json!({"question": "pick", "options": [{"label": "x".repeat(400)}]}),
        );
        assert_eq!(q.options[0].label.chars().count(), OPTION_LABEL_MAX_CHARS);
        // no options and no text box would be unanswerable, so text is forced on
        let q = parse_question("call_3", &json!({"question": "Which folder?"}));
        assert!(q.options.is_empty());
        assert!(q.allow_text);
        assert!(!q.multi_select);
        let q = parse_question(
            "call_4",
            &json!({"question": "Which folder?", "options": [], "allow_text": false}),
        );
        assert!(q.allow_text);
    }

    #[test]
    fn answers_become_tool_messages_and_dismissal_is_explicit() {
        let messages = json!([
            {"role": "user", "content": "tidy my downloads"},
            {"role": "assistant", "content": null, "tool_calls": [
                {"id": "q1", "type": "function", "function": {"name": "ask_user", "arguments": "{\"question\":\"By date or by type?\"}"}}
            ]}
        ]);
        let msgs = answer_messages(&messages, Some(&json!([{"id": "q1", "value": "By type"}])));
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"].as_str(), Some("tool"));
        assert_eq!(msgs[0]["tool_call_id"].as_str(), Some("q1"));
        assert_eq!(msgs[0]["content"].as_str(), Some("By type"));
        // an empty value is the UI saying the user closed the question
        let msgs = answer_messages(&messages, Some(&json!([{"id": "q1", "value": ""}])));
        assert_eq!(msgs[0]["content"].as_str(), Some(DISMISSED));
        // and a missing answer must still produce a tool response, or the next
        // request is rejected for an unanswered tool_call
        let msgs = answer_messages(&messages, None);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["content"].as_str(), Some(DISMISSED));
    }

    #[test]
    fn question_and_destructive_calls_are_split_but_both_answered() {
        let messages = json!([
            {"role": "assistant", "content": null, "tool_calls": [
                {"id": "q1", "type": "function", "function": {"name": "ask_user", "arguments": "{\"question\":\"Which?\"}"}},
                {"id": "t1", "type": "function", "function": {"name": "trash_files", "arguments": "{\"paths\":[\"/x/a.txt\"]}"}}
            ]}
        ]);
        let (destructive, questions) = awaiting_calls(&messages);
        assert_eq!(destructive.len(), 1);
        assert_eq!(destructive[0]["id"].as_str(), Some("t1"));
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0]["id"].as_str(), Some("q1"));
    }

    #[test]
    fn find_duplicates_pages_are_disjoint_and_stable() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        // 5 groups of 2 identical files, each group a different size so the
        // wasted-space ordering is unambiguous
        for i in 0..5u64 {
            let body = vec![b'a' + i as u8; (i as usize + 1) * 64];
            fs::write(src.join(format!("g{}_1.bin", i)), &body).unwrap();
            fs::write(src.join(format!("g{}_2.bin", i)), &body).unwrap();
        }
        let index = Index::open(&dir.path().join("index.db")).unwrap();
        let rules = Rules::open(dir.path()).unwrap();
        let page = |offset: u64, limit: u64| {
            execute_read_tool(
                "find_duplicates",
                &json!({"root": src.to_str().unwrap(), "offset": offset, "limit": limit}),
                &index,
                &rules,
            )
            .unwrap()
        };
        let p0 = page(0, 2);
        assert_eq!(p0["group_count"].as_u64(), Some(5));
        assert_eq!(p0["returned"].as_u64(), Some(2));
        assert_eq!(p0["has_more"].as_bool(), Some(true));
        let p1 = page(2, 2);
        assert_eq!(p1["offset"].as_u64(), Some(2));
        assert_eq!(p1["returned"].as_u64(), Some(2));
        assert_eq!(p1["has_more"].as_bool(), Some(true));
        let last = page(4, 2);
        assert_eq!(last["returned"].as_u64(), Some(1));
        assert_eq!(last["has_more"].as_bool(), Some(false));
        let hashes = |v: &Value| -> Vec<String> {
            v["groups"]
                .as_array()
                .unwrap()
                .iter()
                .map(|g| g["hash"].as_str().unwrap().to_string())
                .collect()
        };
        let (h0, h1, hl) = (hashes(&p0), hashes(&p1), hashes(&last));
        assert!(h0.iter().all(|h| !h1.contains(h) && !hl.contains(h)));
        assert!(h1.iter().all(|h| !hl.contains(h)));
        // biggest waste first, and the same call twice gives the same page
        let wasted: Vec<u64> = p0["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["wasted"].as_u64().unwrap())
            .collect();
        assert!(wasted[0] >= wasted[1]);
        assert_eq!(h0, hashes(&page(0, 2)));
        // the default page holds every group here, so has_more is false
        let all = execute_read_tool(
            "find_duplicates",
            &json!({"root": src.to_str().unwrap()}),
            &index,
            &rules,
        )
        .unwrap();
        assert_eq!(all["returned"].as_u64(), Some(5));
        assert_eq!(all["has_more"].as_bool(), Some(false));
    }

    #[test]
    fn list_folder_pages_and_reports_the_true_total() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("many");
        fs::create_dir_all(&src).unwrap();
        for i in 0..12 {
            fs::write(src.join(format!("f{:02}.txt", i)), vec![0u8; 10]).unwrap();
        }
        fs::create_dir_all(src.join("zsub")).unwrap();
        let index = Index::open(&dir.path().join("index.db")).unwrap();
        let rules = Rules::open(dir.path()).unwrap();
        let page = |offset: u64, limit: u64| {
            execute_read_tool(
                "list_folder",
                &json!({"path": src.to_str().unwrap(), "offset": offset, "limit": limit}),
                &index,
                &rules,
            )
            .unwrap()
        };
        let p0 = page(0, 5);
        assert_eq!(p0["total"].as_u64(), Some(13));
        assert_eq!(p0["returned"].as_u64(), Some(5));
        assert_eq!(p0["has_more"].as_bool(), Some(true));
        // directories sort ahead of files, then name order
        assert_eq!(p0["children"][0]["name"].as_str(), Some("zsub"));
        assert_eq!(p0["children"][0]["is_dir"].as_bool(), Some(true));
        assert_eq!(p0["children"][1]["name"].as_str(), Some("f00.txt"));
        assert_eq!(p0["children"][1]["size"].as_u64(), Some(10));
        let p1 = page(5, 5);
        assert_eq!(p1["total"].as_u64(), Some(13));
        assert_eq!(p1["has_more"].as_bool(), Some(true));
        let p2 = page(10, 5);
        assert_eq!(p2["returned"].as_u64(), Some(3));
        assert_eq!(p2["has_more"].as_bool(), Some(false));
        let names = |v: &Value| -> Vec<String> {
            v["children"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["name"].as_str().unwrap().to_string())
                .collect()
        };
        let (n0, n1, n2) = (names(&p0), names(&p1), names(&p2));
        assert!(n0.iter().all(|n| !n1.contains(n) && !n2.contains(n)));
        assert!(n1.iter().all(|n| !n2.contains(n)));
        let mut seen: Vec<String> = n0.iter().chain(&n1).chain(&n2).cloned().collect();
        assert_eq!(seen.len(), 13);
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 13);
        // the same page twice is the same slice
        assert_eq!(n1, names(&page(5, 5)));
    }

    #[test]
    fn search_files_pages_without_overpromising() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        for i in 0..7 {
            fs::write(src.join(format!("report{}.pdf", i)), vec![0u8; 8]).unwrap();
        }
        let entries = WalkdirSource.enumerate(&src).unwrap();
        let mut index = Index::open(&dir.path().join("index.db")).unwrap();
        index.upsert_batch(&entries).unwrap();
        let rules = Rules::open(dir.path()).unwrap();
        let page = |offset: i64, limit: i64| {
            execute_read_tool(
                "search_files",
                &json!({"query": "report", "offset": offset, "limit": limit}),
                &index,
                &rules,
            )
            .unwrap()
        };
        let p0 = page(0, 3);
        assert_eq!(p0["total_returned"].as_u64(), Some(3));
        assert_eq!(p0["has_more"].as_bool(), Some(true));
        let p2 = page(6, 3);
        assert_eq!(p2["total_returned"].as_u64(), Some(1));
        assert_eq!(p2["has_more"].as_bool(), Some(false));
        let names = |v: &Value| -> Vec<String> {
            v["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(|h| h["name"].as_str().unwrap().to_string())
                .collect()
        };
        assert!(names(&p0).iter().all(|n| !names(&p2).contains(n)));
    }

    #[test]
    fn oversized_results_are_truncated_and_say_so() {
        let small = json!({"count": 1, "results": [{"path": "/x/a.txt"}]});
        assert_eq!(cap_tool_result(small.clone()), small);
        let results: Vec<Value> = (0..4000)
            .map(|i| json!({"path": format!("/very/long/path/number/{}/file.txt", i), "size": i}))
            .collect();
        let big = json!({"total": 4000, "offset": 0, "results": results});
        let capped = cap_tool_result(big);
        assert_eq!(capped["truncated"].as_bool(), Some(true));
        assert!(capped["note"].as_str().unwrap().contains("offset/limit"));
        assert_eq!(capped["partial_field"].as_str(), Some("results"));
        // scalars survive so the model still knows the true total
        assert_eq!(capped["total"].as_u64(), Some(4000));
        let kept = capped["partial"].as_array().unwrap();
        assert!(!kept.is_empty() && kept.len() < 4000);
        assert_eq!(
            kept[0]["path"].as_str(),
            Some("/very/long/path/number/0/file.txt")
        );
        assert!(capped.to_string().len() <= MAX_TOOL_RESULT_BYTES);
    }
}
