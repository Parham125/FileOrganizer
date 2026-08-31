use fo_ai::organize::{self, Move};
use fo_ai::{OpenRouter, ReasoningEffort};
use fo_archive::ArchiveListing;
use fo_chats::{derive_title, Chat, ChatSummary, Chats};
use fo_dedup::{find_duplicates, find_similar_images, DupGroup, SimilarGroup};
use fo_hasher::HashAlgo;
use fo_indexer::{ChangeEvent, FileEntry, FileSource, WalkdirSource, Watcher};
use fo_rules::{match_rule, Rule, RuleAction, RuleFilter, Rules};
use fo_search::{ContentHit, ExtStat, Index, SearchHit, SearchOpts};
use fo_trash::{SkippedItem, Trash, TrashItem};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

mod agent;

struct AppState {
    index: Mutex<Index>,
    trash: Mutex<Trash>,
    rules: Mutex<Rules>,
    chats: Mutex<Chats>,
    watchers: Mutex<Vec<Watcher>>,
}

const KEYRING_SERVICE: &str = "com.parham.fileorganizer";
const KEYRING_ACCOUNT: &str = "openrouter";

/// `settings.json` in the app data dir, filled in during setup. Non-secret
/// preferences only; the API key lives in the keychain or `credentials.json`.
static SETTINGS_PATH: OnceLock<PathBuf> = OnceLock::new();

/// `credentials.json` beside it, used only when key storage is set to "file".
/// Kept separate from settings so it is obvious what the file holds.
static CREDENTIALS_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Where the API key is kept. The keychain is safe but, on an unsigned build,
/// macOS re-prompts every launch; the file avoids prompts entirely at the cost
/// of storing the key in cleartext (owner-only permissions, but cleartext).
fn key_storage_is_file() -> bool {
    SETTINGS_PATH
        .get()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .map(|v| v["key_storage"].as_str() == Some("file"))
        .unwrap_or(false)
}

fn read_file_key() -> Option<String> {
    let raw = fs::read_to_string(CREDENTIALS_PATH.get()?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let key = v["openrouter"].as_str()?.to_string();
    (!key.is_empty()).then_some(key)
}

fn write_file_key(key: Option<&str>) -> Result<(), String> {
    let path = CREDENTIALS_PATH
        .get()
        .ok_or_else(|| "credentials path unavailable".to_string())?;
    match key {
        None => match fs::remove_file(path) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        },
        Some(k) => {
            let body = serde_json::json!({ "openrouter": k }).to_string();
            fs::write(path, body).map_err(|e| e.to_string())?;
            // cleartext on disk is the tradeoff the user chose; at least keep
            // it unreadable to other accounts on the machine
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
            }
            Ok(())
        }
    }
}

/// The stored reasoning effort, falling back to the default when the file is
/// missing, unreadable or malformed. Never fails a request over settings.
fn reasoning_effort() -> ReasoningEffort {
    SETTINGS_PATH
        .get()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["reasoning_effort"].as_str()?.parse().ok())
        .unwrap_or_default()
}

/// The key, held in memory after the first successful read. Every keychain read
/// can raise an OS unlock prompt, and an unsigned build is re-prompted because
/// macOS sees a new code identity each launch, so reading it once per launch
/// instead of once per request is the difference between one prompt and one for
/// every message. `None` means "not read yet", `Some(None)` means "no key set".
static KEY_CACHE: Mutex<Option<Option<String>>> = Mutex::new(None);

fn set_keychain_key(key: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| e.to_string())?
        .set_password(key)
        .map_err(|e| e.to_string())
}

fn clear_keychain_key() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn set_key(key: &str) -> Result<(), String> {
    if key_storage_is_file() {
        write_file_key(Some(key))?;
    } else {
        set_keychain_key(key)?;
    }
    *KEY_CACHE.lock().unwrap() = Some(Some(key.to_string()));
    Ok(())
}

fn get_key() -> Option<String> {
    let mut cache = KEY_CACHE.lock().unwrap();
    if let Some(cached) = cache.as_ref() {
        return cached.clone();
    }
    let key = if key_storage_is_file() {
        read_file_key()
    } else {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .ok()
            .and_then(|e| e.get_password().ok())
    };
    *cache = Some(key.clone());
    key
}

fn clear_key() -> Result<(), String> {
    // clear both stores, so removing the key never leaves a copy behind in the
    // one that is not currently selected
    let file = write_file_key(None);
    let chain = clear_keychain_key();
    *KEY_CACHE.lock().unwrap() = Some(None);
    file.and(chain)
}

fn stat_entries(paths: &[PathBuf]) -> Vec<FileEntry> {
    paths
        .iter()
        .filter_map(|p| {
            let meta = fs::metadata(p).ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(FileEntry {
                path: p.clone(),
                size: meta.len(),
                modified: meta.modified().ok(),
            })
        })
        .collect()
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn index_stats(state: State<AppState>) -> Result<i64, String> {
    state
        .index
        .lock()
        .unwrap()
        .count()
        .map_err(|e| e.to_string())
}

/// Disk-usage overview built from the index: totals, biggest files, size by type.
#[derive(serde::Serialize)]
struct StorageStats {
    files: i64,
    total_size: i64,
    largest: Vec<SearchHit>,
    by_ext: Vec<ExtStat>,
}

#[tauri::command]
fn storage_stats(state: State<AppState>) -> Result<StorageStats, String> {
    let idx = state.index.lock().unwrap();
    Ok(StorageStats {
        files: idx.count().map_err(|e| e.to_string())?,
        total_size: idx.total_size().map_err(|e| e.to_string())?,
        largest: idx.largest_files(25).map_err(|e| e.to_string())?,
        by_ext: idx.size_by_ext(12).map_err(|e| e.to_string())?,
    })
}

#[tauri::command]
fn search(
    query: String,
    opts: SearchOpts,
    state: State<AppState>,
) -> Result<Vec<SearchHit>, String> {
    state
        .index
        .lock()
        .unwrap()
        .search(&query, &opts)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn index_folder(path: String, app: AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        let entries = fo_indexer::enumerate_best(&root).map_err(|e| e.to_string())?;
        let total = entries.len();
        let state = app.state::<AppState>();
        let mut done = 0usize;
        for chunk in entries.chunks(2000) {
            {
                let mut idx = state.index.lock().unwrap();
                idx.upsert_batch(chunk).map_err(|e| e.to_string())?;
            }
            done += chunk.len();
            let _ = app.emit(
                "index:progress",
                serde_json::json!({ "done": done, "total": total }),
            );
        }
        Ok(total)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn index_content(root: String, app: AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entries = WalkdirSource
            .enumerate(&PathBuf::from(&root))
            .map_err(|e| e.to_string())?;
        let total = entries.len();
        let state = app.state::<AppState>();
        let mut indexed = 0usize;
        for (done, e) in entries.iter().enumerate() {
            if let Ok(Some(body)) = fo_extract::extract_text(&e.path) {
                let mut idx = state.index.lock().unwrap();
                if idx.index_content(&e.path, &body).is_ok() {
                    indexed += 1;
                }
            }
            if done % 50 == 0 || done + 1 == total {
                let _ = app.emit(
                    "content:progress",
                    serde_json::json!({ "done": done + 1, "total": total }),
                );
            }
        }
        Ok(indexed)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn search_content(
    query: String,
    limit: Option<i64>,
    state: State<AppState>,
) -> Result<Vec<ContentHit>, String> {
    state
        .index
        .lock()
        .unwrap()
        .search_content(&query, limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

/// Read an archive's table of contents without extracting anything.
#[tauri::command]
fn list_archive(path: String, limit: Option<usize>) -> Result<ArchiveListing, String> {
    fo_archive::list_archive(&PathBuf::from(path), limit.unwrap_or(200).clamp(1, 1000))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn start_watch(path: String, app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let root = PathBuf::from(&path);
    let handle = app.clone();
    let watcher = Watcher::watch(&root, move |ev| {
        apply_change(&handle, ev);
        let _ = handle.emit("index:changed", ());
    })
    .map_err(|e| e.to_string())?;
    state.watchers.lock().unwrap().push(watcher);
    Ok(())
}

fn apply_change(app: &AppHandle, ev: ChangeEvent) {
    let state = app.state::<AppState>();
    let mut idx = state.index.lock().unwrap();
    match ev {
        ChangeEvent::Created(p) | ChangeEvent::Modified(p) => upsert_one(&mut idx, p),
        ChangeEvent::Removed(p) => {
            let _ = idx.remove_path(&p);
        }
        ChangeEvent::Renamed { from, to } => {
            let _ = idx.remove_path(&from);
            upsert_one(&mut idx, to);
        }
    }
}

fn upsert_one(idx: &mut Index, p: PathBuf) {
    let meta = match fs::metadata(&p) {
        Ok(m) if m.is_file() => m,
        _ => return,
    };
    let entry = FileEntry {
        path: p,
        size: meta.len(),
        modified: meta.modified().ok(),
    };
    let _ = idx.upsert_batch(std::slice::from_ref(&entry));
}

#[tauri::command]
async fn scan_duplicates(
    root: String,
    algo: String,
    app: AppHandle,
) -> Result<Vec<DupGroup>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let algo = match algo.as_str() {
            "sha256" => HashAlgo::Sha256,
            _ => HashAlgo::Blake3,
        };
        let entries = WalkdirSource
            .enumerate(&PathBuf::from(&root))
            .map_err(|e| e.to_string())?;
        let groups = find_duplicates(&entries, algo, |done, total| {
            let _ = app.emit(
                "dedup:progress",
                serde_json::json!({ "done": done, "total": total }),
            );
        });
        Ok(groups)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scan_similar_images(
    root: String,
    max_distance: Option<u32>,
    app: AppHandle,
) -> Result<Vec<SimilarGroup>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entries = WalkdirSource
            .enumerate(&PathBuf::from(&root))
            .map_err(|e| e.to_string())?;
        let groups = find_similar_images(&entries, max_distance.unwrap_or(10), |done, total| {
            let _ = app.emit(
                "similar:progress",
                serde_json::json!({ "done": done, "total": total }),
            );
        });
        Ok(groups)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn trash_files(
    paths: Vec<String>,
    reason: String,
    state: State<AppState>,
) -> Result<String, String> {
    let bufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let op = {
        let trash = state.trash.lock().unwrap();
        trash
            .trash_files(&bufs, &reason, None)
            .map_err(|e| e.to_string())?
    };
    let idx = state.index.lock().unwrap();
    for p in &bufs {
        let _ = idx.remove_path(p);
    }
    Ok(op.id)
}

#[tauri::command]
fn list_trash(limit: Option<i64>, state: State<AppState>) -> Result<Vec<TrashItem>, String> {
    state
        .trash
        .lock()
        .unwrap()
        .list(Some("delete"), limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

/// Restore/undo returns (target now holding the file, previous stored path).
/// Keep the index correct: drop the now-empty stored path, upsert the target.
/// Point the index at where a batch of moved items now live. A moved folder
/// repoints every indexed path beneath it; a moved file is re-stated.
fn reindex_after_move(idx: &mut Index, items: &[TrashItem]) {
    let mut upsert = Vec::new();
    for it in items {
        let from = PathBuf::from(&it.original_path);
        let to = PathBuf::from(&it.stored_path);
        let _ = idx.remove_path(&from);
        if it.is_dir {
            let _ = idx.reparent(&from, &to);
        } else {
            upsert.push(to);
        }
    }
    let entries = stat_entries(&upsert);
    if !entries.is_empty() {
        let _ = idx.upsert_batch(&entries);
    }
}

fn reindex_moved(state: &State<AppState>, restored: &[(PathBuf, PathBuf)]) {
    let mut idx = state.index.lock().unwrap();
    for (_, stored) in restored {
        let _ = idx.remove_path(stored);
    }
    let targets: Vec<PathBuf> = restored.iter().map(|(t, _)| t.clone()).collect();
    let entries = stat_entries(&targets);
    if !entries.is_empty() {
        let _ = idx.upsert_batch(&entries);
    }
}

#[tauri::command]
fn restore_op(op_id: String, state: State<AppState>) -> Result<Vec<String>, String> {
    let restored = {
        let trash = state.trash.lock().unwrap();
        trash.restore_op(&op_id).map_err(|e| e.to_string())?
    };
    reindex_moved(&state, &restored);
    Ok(restored
        .iter()
        .map(|(t, _)| t.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
fn restore_item(item_id: String, state: State<AppState>) -> Result<String, String> {
    let restored = {
        let trash = state.trash.lock().unwrap();
        trash.restore_item(&item_id).map_err(|e| e.to_string())?
    };
    reindex_moved(&state, std::slice::from_ref(&restored));
    Ok(restored.0.to_string_lossy().to_string())
}

#[tauri::command]
fn undo_last(state: State<AppState>) -> Result<Vec<String>, String> {
    let restored = {
        let trash = state.trash.lock().unwrap();
        trash.undo_last().map_err(|e| e.to_string())?
    };
    reindex_moved(&state, &restored);
    Ok(restored
        .iter()
        .map(|(t, _)| t.to_string_lossy().to_string())
        .collect())
}

/// Upper bound on files one rule run touches, so a broad filter cannot pull the
/// whole index into memory at once.
const RULE_RUN_LIMIT: i64 = 50_000;

/// Outcome of a rule run. `op_id` is the journal entry to undo; it is empty when
/// nothing matched and no operation was recorded.
#[derive(serde::Serialize)]
struct RuleRun {
    op_id: String,
    count: usize,
    skipped: Vec<SkippedItem>,
}

/// Result of applying an AI organize proposal. `skipped` names every move that
/// did not happen and why, so the UI never reports a silent partial success.
#[derive(serde::Serialize)]
struct ApplyOrganization {
    op_id: String,
    moved: usize,
    skipped: Vec<SkippedItem>,
}

#[tauri::command]
fn list_rules(state: State<AppState>) -> Result<Vec<Rule>, String> {
    state
        .rules
        .lock()
        .unwrap()
        .list()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_rule(
    name: String,
    filter: RuleFilter,
    action: RuleAction,
    state: State<AppState>,
) -> Result<Rule, String> {
    state
        .rules
        .lock()
        .unwrap()
        .create(&name, filter, action)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_rule(rule: Rule, state: State<AppState>) -> Result<(), String> {
    state
        .rules
        .lock()
        .unwrap()
        .update(&rule)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_rule(id: String, state: State<AppState>) -> Result<(), String> {
    state
        .rules
        .lock()
        .unwrap()
        .delete(&id)
        .map_err(|e| e.to_string())
}

/// Files a filter would match, without acting on any of them.
#[tauri::command]
fn preview_rule(
    filter: RuleFilter,
    limit: Option<i64>,
    state: State<AppState>,
) -> Result<Vec<SearchHit>, String> {
    let idx = state.index.lock().unwrap();
    match_rule(&idx, &filter, limit.unwrap_or(500)).map_err(|e| e.to_string())
}

/// Apply a rule to everything it matches. Both actions go through the trash
/// journal, so the returned op id can be undone and nothing is deleted outright.
#[tauri::command]
fn run_rule(id: String, state: State<AppState>) -> Result<RuleRun, String> {
    let rule = {
        let rules = state.rules.lock().unwrap();
        rules
            .get(&id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no rule with id {}", id))?
    };
    let paths: Vec<PathBuf> = {
        let idx = state.index.lock().unwrap();
        match_rule(&idx, &rule.filter, RULE_RUN_LIMIT)
            .map_err(|e| e.to_string())?
            .iter()
            .map(|h| PathBuf::from(&h.path))
            .collect()
    };
    if paths.is_empty() {
        let rules = state.rules.lock().unwrap();
        rules.mark_run(&id, 0).map_err(|e| e.to_string())?;
        return Ok(RuleRun {
            op_id: String::new(),
            count: 0,
            skipped: Vec::new(),
        });
    }
    let op = match &rule.action {
        RuleAction::Trash => {
            let trash = state.trash.lock().unwrap();
            trash
                .trash_files(&paths, "rule", Some(&rule.name))
                .map_err(|e| e.to_string())?
        }
        RuleAction::MoveTo { folder } => {
            let dest = PathBuf::from(folder);
            let pairs: Vec<(PathBuf, PathBuf)> = paths
                .iter()
                .filter_map(|p| Some((p.clone(), dest.join(p.file_name()?))))
                .collect();
            let trash = state.trash.lock().unwrap();
            trash
                .apply_moves(&pairs, "rule-move")
                .map_err(|e| e.to_string())?
        }
    };
    {
        let mut idx = state.index.lock().unwrap();
        if matches!(rule.action, RuleAction::MoveTo { .. }) {
            reindex_after_move(&mut idx, &op.items);
        } else {
            for it in &op.items {
                let _ = idx.remove_path(&PathBuf::from(&it.original_path));
            }
        }
    }
    let count = op.items.len();
    {
        let rules = state.rules.lock().unwrap();
        rules
            .mark_run(&id, count as i64)
            .map_err(|e| e.to_string())?;
    }
    Ok(RuleRun {
        op_id: op.id,
        count,
        skipped: op.skipped,
    })
}

#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
    set_key(&key)
}

#[tauri::command]
fn has_api_key() -> bool {
    get_key().is_some()
}

#[tauri::command]
fn clear_api_key() -> Result<(), String> {
    clear_key()
}

#[tauri::command]
fn get_reasoning_effort() -> String {
    reasoning_effort().as_effort().unwrap_or("off").to_string()
}

/// Merge one key into settings.json, so writing one preference never drops the
/// others.
fn write_setting(key: &str, value: serde_json::Value) -> Result<(), String> {
    let path = SETTINGS_PATH
        .get()
        .ok_or_else(|| "Settings are not ready yet".to_string())?;
    let mut doc = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !doc.is_object() {
        doc = serde_json::json!({});
    }
    doc[key] = value;
    fs::write(path, doc.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_reasoning_effort(effort: String) -> Result<(), String> {
    let parsed: ReasoningEffort = effort.parse().map_err(|e: anyhow::Error| e.to_string())?;
    write_setting("reasoning_effort", serde_json::json!(parsed))
}

#[tauri::command]
fn get_key_storage() -> String {
    if key_storage_is_file() {
        "file".to_string()
    } else {
        "keychain".to_string()
    }
}

/// Move the stored key to the other store and switch to it. Writing the key
/// before clearing the old copy means a failure mid-switch leaves the key
/// readable rather than lost.
#[tauri::command]
fn set_key_storage(storage: String) -> Result<(), String> {
    let to_file = match storage.as_str() {
        "file" => true,
        "keychain" => false,
        other => return Err(format!("unknown key storage \"{other}\"")),
    };
    if to_file == key_storage_is_file() {
        return Ok(());
    }
    let existing = get_key();
    write_setting("key_storage", serde_json::json!(storage))?;
    if let Some(key) = existing {
        if to_file {
            write_file_key(Some(&key))?;
            let _ = clear_keychain_key();
        } else {
            set_keychain_key(&key)?;
            let _ = write_file_key(None);
        }
        *KEY_CACHE.lock().unwrap() = Some(Some(key));
    }
    Ok(())
}

#[tauri::command]
async fn ai_propose_organization(
    root: String,
    model: String,
    app: AppHandle,
) -> Result<Vec<Move>, String> {
    let key = get_key().ok_or_else(|| "No API key set".to_string())?;
    let root_path = PathBuf::from(&root);
    let files = {
        let root_path = root_path.clone();
        tauri::async_runtime::spawn_blocking(move || WalkdirSource.enumerate(&root_path))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?
    };
    let _ = app.emit("ai:progress", format!("Analyzing {} files...", files.len()));
    let client = OpenRouter::new(key, model).with_reasoning(reasoning_effort());
    let _ = app.emit("ai:progress", "Building plan...");
    let plans = organize::propose_plan(&client, &root_path, &files)
        .await
        .map_err(|e| e.to_string())?;
    let moves = plans
        .into_iter()
        .filter_map(|p| {
            let from = root_path.join(&p.from);
            let filename = from.file_name()?.to_string_lossy().to_string();
            let to = root_path.join(&p.to_subfolder).join(&filename);
            Some(Move { from, to })
        })
        .collect();
    Ok(moves)
}

#[tauri::command]
fn ai_apply_organization(
    moves: Vec<Move>,
    state: State<AppState>,
) -> Result<ApplyOrganization, String> {
    let pairs: Vec<(PathBuf, PathBuf)> = moves
        .iter()
        .map(|m| (m.from.clone(), m.to.clone()))
        .collect();
    let op = {
        let trash = state.trash.lock().unwrap();
        trash
            .apply_moves(&pairs, "organize")
            .map_err(|e| e.to_string())?
    };
    let mut idx = state.index.lock().unwrap();
    reindex_after_move(&mut idx, &op.items);
    Ok(ApplyOrganization {
        op_id: op.id,
        moved: op.items.len(),
        skipped: op.skipped,
    })
}

#[tauri::command]
async fn ai_chat(prompt: String, model: String) -> Result<String, String> {
    let key = get_key().ok_or_else(|| "No API key set".to_string())?;
    let client = OpenRouter::new(key, model).with_reasoning(reasoning_effort());
    client.chat(None, &prompt).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn list_chats(limit: Option<i64>, state: State<AppState>) -> Result<Vec<ChatSummary>, String> {
    state
        .chats
        .lock()
        .unwrap()
        .list(limit.unwrap_or(100))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_chat(id: String, state: State<AppState>) -> Result<Option<Chat>, String> {
    state
        .chats
        .lock()
        .unwrap()
        .get(&id)
        .map_err(|e| e.to_string())
}

/// Persist a transcript, creating the chat on first save. The returned chat is
/// how the UI learns the id it should keep saving into, and the derived title.
#[tauri::command]
fn save_chat(
    id: Option<String>,
    messages: serde_json::Value,
    state: State<AppState>,
) -> Result<Chat, String> {
    let chats = state.chats.lock().unwrap();
    let existing = match id.as_deref() {
        Some(id) => chats.get(id).map_err(|e| e.to_string())?,
        None => None,
    };
    match existing {
        Some(chat) => {
            // a chat still on its placeholder name gets a real one once the user has spoken
            let title = (chat.title == "New chat").then(|| derive_title(&messages));
            chats
                .save(&chat.id, title.as_deref(), &messages)
                .map_err(|e| e.to_string())?;
            chats
                .get(&chat.id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("chat {} vanished while saving", chat.id))
        }
        None => chats
            .create(&derive_title(&messages), &messages)
            .map_err(|e| e.to_string()),
    }
}

#[tauri::command]
fn rename_chat(id: String, title: String, state: State<AppState>) -> Result<(), String> {
    state
        .chats
        .lock()
        .unwrap()
        .rename(&id, &title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_chat(id: String, state: State<AppState>) -> Result<(), String> {
    state
        .chats
        .lock()
        .unwrap()
        .delete(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_chats(state: State<AppState>) -> Result<(), String> {
    state
        .chats
        .lock()
        .unwrap()
        .delete_all()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn empty_trash(state: State<AppState>) -> Result<(), String> {
    state
        .trash
        .lock()
        .unwrap()
        .empty()
        .map_err(|e| e.to_string())
}

/// Permanently delete one quarantined item. Irreversible; the index was already
/// updated at trash time, so nothing to reindex.
#[tauri::command]
fn purge_trash_item(item_id: String, state: State<AppState>) -> Result<(), String> {
    state
        .trash
        .lock()
        .unwrap()
        .purge_item(&item_id)
        .map_err(|e| e.to_string())
}

/// Permanently delete a whole trash operation. Irreversible.
#[tauri::command]
fn purge_trash_op(op_id: String, state: State<AppState>) -> Result<(), String> {
    state
        .trash
        .lock()
        .unwrap()
        .purge_op(&op_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_file(path: String, app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_file(path: String, app: AppHandle) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            let _ = SETTINGS_PATH.set(dir.join("settings.json"));
            let _ = CREDENTIALS_PATH.set(dir.join("credentials.json"));
            let index = Index::open(&dir.join("index.db"))?;
            let trash = Trash::open(&dir)?;
            let rules = Rules::open(&dir)?;
            let chats = Chats::open(&dir)?;
            app.manage(AppState {
                index: Mutex::new(index),
                trash: Mutex::new(trash),
                rules: Mutex::new(rules),
                chats: Mutex::new(chats),
                watchers: Mutex::new(Vec::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            index_stats,
            storage_stats,
            search,
            index_folder,
            index_content,
            search_content,
            list_archive,
            start_watch,
            scan_duplicates,
            scan_similar_images,
            trash_files,
            list_trash,
            restore_op,
            restore_item,
            undo_last,
            empty_trash,
            purge_trash_item,
            purge_trash_op,
            list_rules,
            create_rule,
            update_rule,
            delete_rule,
            preview_rule,
            run_rule,
            open_file,
            reveal_file,
            set_api_key,
            has_api_key,
            clear_api_key,
            get_reasoning_effort,
            set_reasoning_effort,
            get_key_storage,
            set_key_storage,
            ai_propose_organization,
            ai_apply_organization,
            ai_chat,
            list_chats,
            get_chat,
            save_chat,
            rename_chat,
            delete_chat,
            clear_chats,
            agent::ai_agent,
            agent::ai_agent_continue
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
