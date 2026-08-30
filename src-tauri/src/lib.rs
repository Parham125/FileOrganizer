use fo_ai::organize::{self, Move};
use fo_ai::OpenRouter;
use fo_dedup::{find_duplicates, find_similar_images, DupGroup, SimilarGroup};
use fo_hasher::HashAlgo;
use fo_indexer::{ChangeEvent, FileEntry, FileSource, WalkdirSource, Watcher};
use fo_search::{ContentHit, Index, SearchHit, SearchOpts};
use fo_trash::{Trash, TrashItem};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

mod agent;

struct AppState {
    index: Mutex<Index>,
    trash: Mutex<Trash>,
    watchers: Mutex<Vec<Watcher>>,
}

const KEYRING_SERVICE: &str = "com.parham.fileorganizer";
const KEYRING_ACCOUNT: &str = "openrouter";

fn set_key(key: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| e.to_string())?
        .set_password(key)
        .map_err(|e| e.to_string())
}

fn get_key() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .ok()?
        .get_password()
        .ok()
}

fn clear_key() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
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
    let client = OpenRouter::new(key, model);
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
fn ai_apply_organization(moves: Vec<Move>, state: State<AppState>) -> Result<String, String> {
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
    for it in &op.items {
        let _ = idx.remove_path(&PathBuf::from(&it.original_path));
    }
    let new_paths: Vec<PathBuf> = op
        .items
        .iter()
        .map(|i| PathBuf::from(&i.stored_path))
        .collect();
    let entries = stat_entries(&new_paths);
    if !entries.is_empty() {
        let _ = idx.upsert_batch(&entries);
    }
    Ok(op.id)
}

#[tauri::command]
async fn ai_chat(prompt: String, model: String) -> Result<String, String> {
    let key = get_key().ok_or_else(|| "No API key set".to_string())?;
    let client = OpenRouter::new(key, model);
    client.chat(None, &prompt).await.map_err(|e| e.to_string())
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
            let index = Index::open(&dir.join("index.db"))?;
            let trash = Trash::open(&dir)?;
            app.manage(AppState {
                index: Mutex::new(index),
                trash: Mutex::new(trash),
                watchers: Mutex::new(Vec::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            index_stats,
            search,
            index_folder,
            index_content,
            search_content,
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
            open_file,
            reveal_file,
            set_api_key,
            has_api_key,
            clear_api_key,
            ai_propose_organization,
            ai_apply_organization,
            ai_chat,
            agent::ai_agent,
            agent::ai_agent_continue
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
