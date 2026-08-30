use crate::OpenRouter;
use anyhow::{anyhow, Result};
use fo_indexer::FileEntry;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const MAX_FILES: usize = 300;

const SYSTEM: &str = "You are a file organizer. You are given a list of files, one per line as \
`relative_path<TAB>size_bytes<TAB>extension`. Group them into a small set of clear top-level \
category folders inferred from their names, types, topics, or projects. Prefer few broad \
categories over many tiny ones. Files that are already in a sensible place may be omitted. \
Reply with STRICT JSON only, no prose and no code fences, in exactly this shape: \
{\"moves\":[{\"from\":\"<relative path>\",\"to_subfolder\":\"<Category>\"}]}. \
`from` must be one of the given relative paths verbatim. `to_subfolder` is a single folder name.";

/// A proposed move, relative to the organize root.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MovePlan {
    pub from: String,
    pub to_subfolder: String,
}

/// A resolved, absolute move ready to apply.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Move {
    pub from: PathBuf,
    pub to: PathBuf,
}

#[derive(Debug, Deserialize)]
struct PlanResponse {
    moves: Vec<MovePlan>,
}

pub async fn propose_plan(
    client: &OpenRouter,
    root: &Path,
    files: &[FileEntry],
) -> Result<Vec<MovePlan>> {
    let mut listing = String::new();
    let mut allowed: HashSet<String> = HashSet::new();
    for e in files.iter().take(MAX_FILES) {
        let rel = e
            .path
            .strip_prefix(root)
            .unwrap_or(&e.path)
            .to_string_lossy()
            .to_string();
        let ext = e
            .path
            .extension()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        listing.push_str(&format!("{}\t{}\t{}\n", rel, e.size, ext));
        allowed.insert(rel);
    }
    if files.len() > MAX_FILES {
        listing.push_str(&format!("... and {} more files\n", files.len() - MAX_FILES));
    }
    let user = format!(
        "Organize these {} files:\n{}",
        allowed.len().min(files.len()),
        listing
    );
    let content = client.chat(Some(SYSTEM), &user).await?;
    let plans = parse_plan(&content)?;
    Ok(plans
        .into_iter()
        .filter(|p| allowed.contains(&p.from))
        .collect())
}

/// Extract the moves JSON from a model reply, tolerating fences and stray prose.
fn parse_plan(raw: &str) -> Result<Vec<MovePlan>> {
    let start = raw.find('{');
    let end = raw.rfind('}');
    let json = match (start, end) {
        (Some(a), Some(b)) if b > a => &raw[a..=b],
        _ => return Err(anyhow!("no JSON object in model response")),
    };
    let parsed: PlanResponse = serde_json::from_str(json)?;
    Ok(parsed.moves)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fenced_json() {
        let raw = "```json\n{\"moves\":[{\"from\":\"a.txt\",\"to_subfolder\":\"Docs\"},\
                   {\"from\":\"pic.jpg\",\"to_subfolder\":\"Images\"}]}\n```";
        let plans = parse_plan(raw).unwrap();
        assert_eq!(plans.len(), 2);
        assert_eq!(
            plans[0],
            MovePlan {
                from: "a.txt".into(),
                to_subfolder: "Docs".into()
            }
        );
        assert_eq!(plans[1].to_subfolder, "Images");
    }

    #[test]
    fn parses_with_surrounding_prose() {
        let raw = "Sure, here is the plan:\n{\"moves\":[{\"from\":\"x\",\"to_subfolder\":\"Y\"}]}\nHope that helps.";
        let plans = parse_plan(raw).unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].from, "x");
    }
}
