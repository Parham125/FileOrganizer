//! Saving scan results to a file and reading them back. A duplicate scan over a
//! large drive can take hours, so the UI can park a result set on disk and
//! reopen it later instead of re-scanning.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Marker in every export, so an unrelated JSON file is rejected with a plain
/// sentence instead of a serde error dump.
pub const SNAPSHOT_FORMAT: &str = "fileorganizer.results";
/// Highest snapshot version this build can read.
pub const SNAPSHOT_VERSION: u32 = 1;
const KINDS: [&str; 4] = ["duplicates", "similar_images", "similar_names", "search"];
/// Payloads past this are refused rather than written, since a file that big is
/// painful to load back.
const MAX_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
/// Never read more than this from a file the user picked, so a wrong pick (a
/// disk image, a video) cannot hang the app.
const MAX_IMPORT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_VERIFY_PATHS: usize = 50_000;

/// A saved result set. `payload` stays opaque so a result shape can gain fields
/// without a format bump; the UI interprets it per `kind`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ResultSnapshot {
    pub format: String,
    pub version: u32,
    pub kind: String,
    pub created_ns: i64,
    pub app_version: String,
    /// The folder scanned, or null for "everything indexed".
    pub scope: Option<String>,
    /// Free text the UI may attach.
    pub note: Option<String>,
    pub payload: serde_json::Value,
}

/// One path from a snapshot checked against the disk as it is now.
#[derive(Serialize, Debug)]
pub struct PathStatus {
    pub path: String,
    pub exists: bool,
    pub size: Option<u64>,
    /// `Some` only when the caller supplied `expected_size` and the file is
    /// still there; `None` means "cannot tell".
    pub size_changed: Option<bool>,
}

/// A path to check, with the size it had when the snapshot was written.
#[derive(Deserialize, Debug)]
pub struct PathCheck {
    pub path: String,
    #[serde(default)]
    pub expected_size: Option<u64>,
}

/// Write a result set to `path` as pretty JSON, creating parent directories and
/// overwriting whatever is there (the UI picks the destination through a save
/// dialog, which already confirms).
///
/// `payload` is passed in verbatim by the UI and lands in the file unchanged, so
/// the UI must hand over results only: file paths, sizes and hashes. Never put
/// settings, credentials or an API key in it.
#[tauri::command]
pub fn export_results(
    path: String,
    kind: String,
    scope: Option<String>,
    note: Option<String>,
    payload: serde_json::Value,
) -> Result<(), String> {
    if !KINDS.contains(&kind.as_str()) {
        return Err(format!(
            "Cannot export \"{kind}\" results. Expected one of: {}",
            KINDS.join(", ")
        ));
    }
    let payload_bytes = serde_json::to_vec(&payload)
        .map_err(|e| format!("Could not serialize the results: {e}"))?
        .len();
    if payload_bytes > MAX_PAYLOAD_BYTES {
        return Err(format!("These results are too large to export ({} MB, limit {} MB). Narrow the scan scope and try again.", payload_bytes/(1024*1024), MAX_PAYLOAD_BYTES/(1024*1024)));
    }
    let snap = ResultSnapshot {
        format: SNAPSHOT_FORMAT.to_string(),
        version: SNAPSHOT_VERSION,
        kind,
        created_ns: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as i64)
            .unwrap_or(0),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        scope,
        note,
        payload,
    };
    let text = serde_json::to_string_pretty(&snap)
        .map_err(|e| format!("Could not serialize the results: {e}"))?;
    let out = Path::new(&path);
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
        }
    }
    fs::write(out, text).map_err(|e| format!("Could not write {path}: {e}"))
}

/// Read a snapshot back. Anything that is not one of ours comes back as a
/// sentence the UI can show as-is.
#[tauri::command]
pub fn import_results(path: String) -> Result<ResultSnapshot, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Could not open {path}: {e}"))?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(format!(
            "That file is too large to open ({} MB, limit {} MB).",
            meta.len() / (1024 * 1024),
            MAX_IMPORT_BYTES / (1024 * 1024)
        ));
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    parse_snapshot(&text)
}

/// Split out from the command so the error paths can be tested without a file.
fn parse_snapshot(text: &str) -> Result<ResultSnapshot, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| {
        "That file is not valid JSON, so it cannot be a FileOrganizer results export.".to_string()
    })?;
    if value.get("format").and_then(|v| v.as_str()) != Some(SNAPSHOT_FORMAT) {
        return Err("That file is not a FileOrganizer results export.".to_string());
    }
    // Read the version before the full parse: a newer snapshot may hold shapes
    // this build cannot deserialize, and "wrong version" beats a serde dump.
    match value.get("version").and_then(|v| v.as_u64()) {
        Some(v) if v>SNAPSHOT_VERSION as u64 => return Err(format!("That export was saved by a newer version of FileOrganizer (format version {v}; this build understands up to {SNAPSHOT_VERSION}). Update FileOrganizer to open it.")),
        Some(_) => {}
        None => return Err("That file is not a FileOrganizer results export.".to_string()),
    }
    serde_json::from_value(value)
        .map_err(|e| format!("That export is damaged and could not be read: {e}"))
}

/// Check how much of an old snapshot still matches the disk, so the UI can say
/// "3 of 40 files are gone since this was saved".
#[tauri::command]
pub fn verify_snapshot_paths(paths: Vec<PathCheck>) -> Result<Vec<PathStatus>, String> {
    if paths.len() > MAX_VERIFY_PATHS {
        return Err(format!(
            "Too many paths to verify at once ({}, limit {MAX_VERIFY_PATHS}).",
            paths.len()
        ));
    }
    Ok(paths
        .into_iter()
        .map(|c| {
            let size = fs::metadata(&c.path)
                .ok()
                .filter(|m| m.is_file())
                .map(|m| m.len());
            PathStatus {
                size_changed: match (size, c.expected_size) {
                    (Some(actual), Some(expected)) => Some(actual != expected),
                    _ => None,
                },
                exists: Path::new(&c.path).exists(),
                size,
                path: c.path,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn export_then_import_round_trips_every_field() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("nested").join("dupes.json");
        let payload = json!({"groups": [{"hash": "abc", "files": [{"path": "/a.txt", "size": 3}]}], "meta": {"nested": {"deep": [1, 2, 3]}}});
        export_results(
            out.to_string_lossy().to_string(),
            "duplicates".to_string(),
            Some("/Volumes/Drive".to_string()),
            Some("before the cleanup".to_string()),
            payload.clone(),
        )
        .unwrap();
        let snap = import_results(out.to_string_lossy().to_string()).unwrap();
        assert_eq!(snap.format, SNAPSHOT_FORMAT);
        assert_eq!(snap.version, SNAPSHOT_VERSION);
        assert_eq!(snap.kind, "duplicates");
        assert_eq!(snap.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(snap.scope.as_deref(), Some("/Volumes/Drive"));
        assert_eq!(snap.note.as_deref(), Some("before the cleanup"));
        assert_eq!(snap.payload, payload);
        assert!(snap.created_ns > 0);
    }

    #[test]
    fn export_rejects_an_unknown_kind() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("x.json");
        let err = export_results(
            out.to_string_lossy().to_string(),
            "everything".to_string(),
            None,
            None,
            json!([]),
        )
        .unwrap_err();
        assert!(
            err.starts_with("Cannot export \"everything\" results."),
            "{err}"
        );
        assert!(
            !out.exists(),
            "a rejected export must not leave a file behind"
        );
    }

    #[test]
    fn bad_files_each_get_their_own_message() {
        assert_eq!(
            parse_snapshot("not json at all {{").unwrap_err(),
            "That file is not valid JSON, so it cannot be a FileOrganizer results export."
        );
        assert_eq!(
            parse_snapshot(r#"{"some": "other json"}"#).unwrap_err(),
            "That file is not a FileOrganizer results export."
        );
        let newer = json!({"format": SNAPSHOT_FORMAT, "version": 999, "kind": "duplicates", "created_ns": 0, "app_version": "9.9.9", "scope": null, "note": null, "payload": {}});
        let err = parse_snapshot(&newer.to_string()).unwrap_err();
        assert!(
            err.contains("saved by a newer version of FileOrganizer"),
            "{err}"
        );
        assert!(err.contains("format version 999"), "{err}");
    }

    #[test]
    fn import_reports_a_missing_file() {
        let err = import_results("/definitely/not/here.json".to_string()).unwrap_err();
        assert!(
            err.starts_with("Could not open /definitely/not/here.json"),
            "{err}"
        );
    }

    #[test]
    fn verify_reports_missing_files_and_size_changes() {
        let dir = tempfile::tempdir().unwrap();
        let kept = dir.path().join("kept.txt");
        let grown = dir.path().join("grown.txt");
        let gone = dir.path().join("gone.txt");
        fs::write(&kept, b"abc").unwrap();
        fs::write(&grown, b"abcdef").unwrap();
        let out = verify_snapshot_paths(vec![
            PathCheck {
                path: kept.to_string_lossy().to_string(),
                expected_size: Some(3),
            },
            PathCheck {
                path: grown.to_string_lossy().to_string(),
                expected_size: Some(3),
            },
            PathCheck {
                path: gone.to_string_lossy().to_string(),
                expected_size: Some(10),
            },
            PathCheck {
                path: kept.to_string_lossy().to_string(),
                expected_size: None,
            },
        ])
        .unwrap();
        assert_eq!(out.len(), 4);
        assert!(out[0].exists && out[0].size == Some(3) && out[0].size_changed == Some(false));
        assert!(out[1].exists && out[1].size == Some(6) && out[1].size_changed == Some(true));
        assert!(!out[2].exists && out[2].size.is_none() && out[2].size_changed.is_none());
        assert!(out[3].exists && out[3].size_changed.is_none());
    }

    #[test]
    fn verify_caps_the_input() {
        let one = PathCheck {
            path: "/a".to_string(),
            expected_size: None,
        };
        let many: Vec<PathCheck> = (0..MAX_VERIFY_PATHS + 1)
            .map(|_| PathCheck {
                path: one.path.clone(),
                expected_size: None,
            })
            .collect();
        assert!(verify_snapshot_paths(many)
            .unwrap_err()
            .starts_with("Too many paths to verify at once"));
    }
}
