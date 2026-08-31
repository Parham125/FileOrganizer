use fo_indexer::FileEntry;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

/// Bound on how many entries one scan keys, so an index covering several drives
/// cannot blow up memory here.
const MAX_ENTRIES: usize = 100_000;

/// Which way two names were judged to belong together. The two strategies have
/// opposite rules (Copies strips trailing numbers, MediaTitle keeps them because
/// they are sequels) so their groups are never merged, only labelled.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NameStrategy {
    /// Copy markers, extension-sensitive: "invoice (1).pdf" next to "invoice.pdf".
    #[default]
    Copies,
    /// The same title held at several qualities: "Inception.2010.1080p.mkv" next
    /// to "inception 720p.mp4". Ignores the extension, within one media class.
    #[serde(rename = "media")]
    MediaTitle,
}

impl NameStrategy {
    /// "media" (or "media_title") picks the quality-variant path; anything else,
    /// including a missing label, is `Copies`.
    pub fn from_label(label: Option<&str>) -> NameStrategy {
        match label {
            Some("media") | Some("media_title") | Some("mediatitle") => NameStrategy::MediaTitle,
            _ => NameStrategy::Copies,
        }
    }
}

/// Files whose names collapse to the same stem. They share a NAME, not
/// necessarily contents: only `all_same_size` hints that they might really be
/// copies of each other, and under `MediaTitle` they are expected to differ.
#[derive(Debug, Clone, Serialize)]
pub struct NameGroup {
    pub strategy: NameStrategy,
    pub stem: String,
    /// Lowercase extension shared by the group, "" when none. Always "" for
    /// `MediaTitle`, which groups across containers on purpose.
    pub ext: String,
    /// Release year, when `MediaTitle` found one. It is part of the key, so two
    /// films sharing a title never merge.
    pub year: Option<u16>,
    pub files: Vec<NameMatch>,
    pub all_same_size: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct NameMatch {
    pub path: PathBuf,
    pub size: u64,
    pub modified_ns: Option<i64>,
    /// What made this file look like a copy: "(1)", "copy", "copy 2", "2" under
    /// `Copies`, the resolution under `MediaTitle`. `None` on the file that
    /// carries the bare stem.
    pub marker: Option<String>,
    /// Tokens `MediaTitle` removed to reach the shared title, so the UI can show
    /// why two differently named files were put together. Empty under `Copies`.
    pub stripped: Vec<String>,
}

/// Remove one trailing copy marker, case-insensitively. Returns the shortened
/// stem and the marker text, or `None` when the end of the stem does not look
/// like a copy suffix.
///
/// Deliberately not edit-distance based: "report-jan" and "report-feb" are three
/// edits apart and completely unrelated, so only known markers are stripped.
fn strip_marker(stem: &str) -> Option<(String, String)> {
    // to_ascii_lowercase keeps byte lengths, so indices into `lower` are valid
    // indices into `stem`.
    let lower = stem.to_ascii_lowercase();
    for suffix in [" - copy", " - kopie", " - kopia", " - copie"] {
        if let Some(rest) = lower.strip_suffix(suffix) {
            return Some((stem[..rest.len()].to_string(), "copy".to_string()));
        }
    }
    // "(N)" / " (N)", and " copy (N)" when "copy" sits in front of it
    if let Some(open) = lower.strip_suffix(')').and_then(|s| s.rfind('(')) {
        let digits = &lower[open + 1..lower.len() - 1];
        if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
            let head = lower[..open].trim_end();
            if let Some(rest) = head.strip_suffix("copy") {
                let rest = rest.trim_end_matches([' ', '-', '_']);
                if !rest.is_empty() {
                    return Some((stem[..rest.len()].to_string(), format!("copy {}", digits)));
                }
            }
            if !head.is_empty() {
                return Some((stem[..head.len()].to_string(), format!("({})", digits)));
            }
        }
    }
    let digit_start = lower.len()
        - lower
            .bytes()
            .rev()
            .take_while(|b| b.is_ascii_digit())
            .count();
    if digit_start < lower.len() {
        let digits = &lower[digit_start..];
        let head = lower[..digit_start].trim_end();
        // the number has to be separated from the name by whitespace, otherwise
        // it is part of the name ("IMG_1234", "v2")
        if head.len() < digit_start {
            if let Some(rest) = head.strip_suffix("copy") {
                let rest = rest.trim_end_matches([' ', '-', '_']);
                if !rest.is_empty() {
                    return Some((stem[..rest.len()].to_string(), format!("copy {}", digits)));
                }
            }
            // macOS duplicate style " 2".." 99". Anything bigger, zero padded, or
            // left with a one-char stem is part of the name proper: "Scan 2019"
            // and "Part 007" must survive untouched.
            if digits.len() <= 2 && !digits.starts_with('0') && head.len() >= 2 {
                if let Ok(n) = digits.parse::<u32>() {
                    if (2..=99).contains(&n) {
                        return Some((stem[..head.len()].to_string(), digits.to_string()));
                    }
                }
            }
        }
    }
    for sep in [" copy", "-copy", "_copy"] {
        if let Some(rest) = lower.strip_suffix(sep) {
            if !rest.is_empty() {
                return Some((stem[..rest.len()].to_string(), "copy".to_string()));
            }
        }
    }
    None
}

/// Strip every trailing copy marker ("file copy 2" happens) and report the
/// outermost one, which is the marker the user actually sees.
fn normalize_stem(stem: &str) -> (String, Option<String>) {
    let mut cur = stem.to_string();
    let mut marker = None;
    while let Some((rest, m)) = strip_marker(&cur) {
        let rest = rest.trim_end_matches([' ', '-', '_']).to_string();
        if rest.is_empty() {
            break;
        }
        if marker.is_none() {
            marker = Some(m);
        }
        cur = rest;
    }
    (cur, marker)
}

const VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "avi", "mov", "wmv", "m4v", "flv", "webm", "ts", "m2ts",
];
const AUDIO_EXTS: &[&str] = &["mp3", "flac", "m4a", "wav", "aac", "ogg", "opus"];

/// Resolution / source / codec / audio / edition tags. Stripped wherever they
/// appear, since none of them are ever part of a title.
const MEDIA_NOISE: &[&str] = &[
    "480p",
    "576p",
    "720p",
    "1080p",
    "1440p",
    "2160p",
    "4k",
    "8k",
    "uhd",
    "hd",
    "sd",
    "bluray",
    "blu-ray",
    "brrip",
    "bdrip",
    "bdremux",
    "webrip",
    "web-dl",
    "webdl",
    "hdtv",
    "dvdrip",
    "dvdscr",
    "hdrip",
    "camrip",
    "cam",
    "ts",
    "tc",
    "remux",
    "x264",
    "x265",
    "h264",
    "h265",
    "hevc",
    "avc",
    "xvid",
    "divx",
    "av1",
    "10bit",
    "8bit",
    "hdr",
    "hdr10",
    "dv",
    "dolbyvision",
    "aac",
    "ac3",
    "eac3",
    "dts",
    "dtshd",
    "truehd",
    "atmos",
    "mp3",
    "flac",
    "proper",
    "repack",
    "extended",
    "unrated",
    "directors",
    "remastered",
    "imax",
    "limited",
    "internal",
    "subbed",
    "dubbed",
];

/// Tags that survive separator normalization as two tokens. Matched as whole
/// phrases so bare digits never enter the noise list: "2" has to stay a title
/// word or "Iron Man 2" would merge with "Iron Man 3".
const MEDIA_PHRASES: &[&str] = &[
    "dual audio",
    "directors cut",
    "director s cut",
    "ddp5 1",
    "dd5 1",
    "5 1ch",
    "7 1ch",
    "2 0ch",
    "5 1",
    "7 1",
    "2 0",
];

const RESOLUTIONS: &[&str] = &[
    "480p", "576p", "720p", "1080p", "1440p", "2160p", "4k", "8k", "uhd",
];

fn as_year(tok: &str) -> Option<u16> {
    if tok.len() != 4 || !tok.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    tok.parse::<u16>()
        .ok()
        .filter(|y| (1900..=2099).contains(y))
}

fn push_unique(out: &mut Vec<String>, tok: &str) {
    if !tok.is_empty() && !out.iter().any(|s| s == tok) {
        out.push(tok.to_string());
    }
}

/// Reduce a media filename to the bare title, the release year if one is there,
/// and the list of tokens that were removed.
///
/// Trailing numbers are kept: they are sequel numbers here, the opposite of the
/// `Copies` rule. The year is kept for the same reason, remakes share titles.
fn normalize_media_title(stem: &str) -> (String, Option<u16>, Vec<String>) {
    let lower = stem.to_lowercase();
    let mut year: Option<u16> = None;
    let mut stripped: Vec<String> = Vec::new();
    // Bracketed chunks are metadata in practice ("[YTS.AM]", "(1080p)", "{GRP}")
    // and never the title, so the whole chunk goes; a year inside it is kept.
    let mut flat = String::with_capacity(lower.len());
    let mut chunk = String::new();
    let mut depth = 0usize;
    for c in lower.chars() {
        match c {
            '[' | '(' | '{' => {
                depth += 1;
                if depth == 1 {
                    chunk.clear();
                } else {
                    chunk.push(c);
                }
            }
            ']' | ')' | '}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    for w in chunk
                        .split(|c: char| !c.is_ascii_alphanumeric())
                        .filter(|w| !w.is_empty())
                    {
                        if year.is_none() {
                            year = as_year(w);
                        }
                        push_unique(&mut stripped, w);
                    }
                    flat.push(' ');
                } else {
                    chunk.push(c);
                }
            }
            _ => {
                if depth > 0 {
                    chunk.push(c)
                } else {
                    flat.push(c)
                }
            }
        }
    }
    if depth > 0 {
        flat.push(' ');
        flat.push_str(&chunk);
    }
    let spaced: String = flat
        .chars()
        .map(|c| if c == '.' || c == '_' { ' ' } else { c })
        .collect();
    let mut padded = format!(
        " {} ",
        spaced.split_whitespace().collect::<Vec<_>>().join(" ")
    );
    for phrase in MEDIA_PHRASES {
        let pat = format!(" {} ", phrase);
        while let Some(i) = padded.find(&pat) {
            push_unique(&mut stripped, phrase);
            padded.replace_range(i..i + pat.len(), " ");
        }
    }
    let noise: HashSet<&str> = MEDIA_NOISE.iter().copied().collect();
    let mut words: Vec<&str> = Vec::new();
    for tok in padded.split_whitespace() {
        if let Some(y) = as_year(tok) {
            year = year.or(Some(y));
            push_unique(&mut stripped, tok);
            continue;
        }
        if noise.contains(tok) {
            push_unique(&mut stripped, tok);
            continue;
        }
        // "x264-GRP": a release group hangs off a noise token, so both go. A dash
        // between two real words ("spider-man") is part of the title instead.
        if let Some((head, tail)) = tok.rsplit_once('-') {
            if noise.contains(head) && !tail.is_empty() {
                push_unique(&mut stripped, head);
                push_unique(&mut stripped, tail);
                continue;
            }
        }
        for w in tok.split('-').filter(|w| !w.is_empty()) {
            if let Some(y) = as_year(w) {
                year = year.or(Some(y));
                push_unique(&mut stripped, w);
                continue;
            }
            if noise.contains(w) {
                push_unique(&mut stripped, w);
                continue;
            }
            words.push(w);
        }
    }
    (words.join(" "), year, stripped)
}

fn entry_match(e: &FileEntry, marker: Option<String>, stripped: Vec<String>) -> NameMatch {
    NameMatch {
        path: e.path.clone(),
        size: e.size,
        modified_ns: e
            .modified
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .and_then(|d| i64::try_from(d.as_nanos()).ok()),
        marker,
        stripped,
    }
}

fn finish(mut groups: Vec<NameGroup>) -> Vec<NameGroup> {
    groups.retain(|g| g.files.len() > 1);
    for g in &mut groups {
        g.files.sort_by(|a, b| a.path.cmp(&b.path));
        g.all_same_size = g.files.iter().all(|f| f.size == g.files[0].size);
    }
    groups.sort_by(|a, b| {
        b.files
            .len()
            .cmp(&a.files.len())
            .then_with(|| a.stem.cmp(&b.stem))
            .then_with(|| a.year.cmp(&b.year))
            .then_with(|| a.ext.cmp(&b.ext))
    });
    groups
}

/// Group files whose names differ only by a copy marker, or (under
/// `MediaTitle`) whose names are the same title at different qualities.
///
/// Pure metadata work: it never reads file contents and never claims the files
/// are identical. Raising `cancel` stops the scan and groups whatever was keyed
/// so far.
pub fn find_similar_names(
    entries: &[FileEntry],
    strategy: NameStrategy,
    cancel: &AtomicBool,
) -> Vec<NameGroup> {
    match strategy {
        NameStrategy::Copies => find_copies(entries, cancel),
        NameStrategy::MediaTitle => find_media_titles(entries, cancel),
    }
}

/// "invoice.pdf" / "invoice (1).pdf" / "invoice copy.pdf". Extension-sensitive,
/// so "song.mp3" and "song.wav" stay apart.
fn find_copies(entries: &[FileEntry], cancel: &AtomicBool) -> Vec<NameGroup> {
    let mut by_key: HashMap<(String, String), Vec<NameMatch>> = HashMap::new();
    for e in entries.iter().take(MAX_ENTRIES) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Some(stem) = e.path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let ext = e
            .path
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| x.to_ascii_lowercase())
            .unwrap_or_default();
        let (norm, marker) = normalize_stem(stem);
        if norm.is_empty() {
            continue;
        }
        by_key
            .entry((norm, ext))
            .or_default()
            .push(entry_match(e, marker, Vec::new()));
    }
    finish(
        by_key
            .into_iter()
            .map(|((stem, ext), files)| NameGroup {
                strategy: NameStrategy::Copies,
                stem,
                ext,
                year: None,
                files,
                all_same_size: false,
            })
            .collect(),
    )
}

/// "Inception.2010.720p.BluRay.x264-GRP.mp4" / "inception 1080p.mkv". Ignores
/// the container but never mixes video with audio, and never merges two films
/// that carry different years.
fn find_media_titles(entries: &[FileEntry], cancel: &AtomicBool) -> Vec<NameGroup> {
    let mut by_key: HashMap<(String, bool), Vec<(NameMatch, Option<u16>)>> = HashMap::new();
    for e in entries.iter().take(MAX_ENTRIES) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Some(stem) = e.path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let ext = match e.path.extension().and_then(|x| x.to_str()) {
            Some(x) => x.to_ascii_lowercase(),
            None => continue,
        };
        let is_video = VIDEO_EXTS.contains(&ext.as_str());
        if !is_video && !AUDIO_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let (title, year, stripped) = normalize_media_title(stem);
        // Junk guard: without it every one-character or all-noise name collapses
        // into a single enormous group.
        if title.len() < 3 || title.chars().filter(|c| c.is_alphanumeric()).count() < 2 {
            continue;
        }
        let marker = stripped
            .iter()
            .find(|t| RESOLUTIONS.contains(&t.as_str()))
            .cloned();
        by_key
            .entry((title, is_video))
            .or_default()
            .push((entry_match(e, marker, stripped), year));
    }
    let mut groups: Vec<NameGroup> = Vec::new();
    for ((title, _), files) in by_key {
        let years: BTreeSet<u16> = files.iter().filter_map(|(_, y)| *y).collect();
        if years.len() < 2 {
            groups.push(NameGroup {
                strategy: NameStrategy::MediaTitle,
                stem: title,
                ext: String::new(),
                year: years.iter().next().copied(),
                files: files.into_iter().map(|(m, _)| m).collect(),
                all_same_size: false,
            });
            continue;
        }
        // Two years under one title means two different films (a remake). Split
        // them, and drop the year-less files: there is no way to tell which film
        // they belong to, and guessing is how a wrong delete happens.
        for y in years {
            groups.push(NameGroup {
                strategy: NameStrategy::MediaTitle,
                stem: title.clone(),
                ext: String::new(),
                year: Some(y),
                files: files
                    .iter()
                    .filter(|(_, fy)| *fy == Some(y))
                    .map(|(m, _)| m.clone())
                    .collect(),
                all_same_size: false,
            });
        }
    }
    finish(groups)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn entry(name: &str, size: u64) -> FileEntry {
        FileEntry {
            path: PathBuf::from("/files").join(name),
            size,
            modified: Some(SystemTime::UNIX_EPOCH),
        }
    }

    fn scan(names: &[(&str, u64)]) -> Vec<NameGroup> {
        let entries: Vec<FileEntry> = names.iter().map(|(n, s)| entry(n, *s)).collect();
        find_similar_names(&entries, NameStrategy::Copies, &AtomicBool::new(false))
    }

    fn scan_media(names: &[(&str, u64)]) -> Vec<NameGroup> {
        let entries: Vec<FileEntry> = names.iter().map(|(n, s)| entry(n, *s)).collect();
        find_similar_names(&entries, NameStrategy::MediaTitle, &AtomicBool::new(false))
    }

    fn file_of<'a>(g: &'a NameGroup, name: &str) -> &'a NameMatch {
        g.files
            .iter()
            .find(|f| f.path.file_name().unwrap() == name)
            .unwrap_or_else(|| panic!("{} is not in the group", name))
    }

    fn marker_of(g: &NameGroup, name: &str) -> Option<String> {
        file_of(g, name).marker.clone()
    }

    #[test]
    fn groups_copy_markers_and_leaves_the_original_unmarked() {
        let groups = scan(&[
            ("invoice.pdf", 100),
            ("invoice (1).pdf", 100),
            ("invoice copy.pdf", 100),
            ("invoice - Copy.pdf", 100),
        ]);
        assert_eq!(groups.len(), 1);
        let g = &groups[0];
        assert_eq!(g.strategy, NameStrategy::Copies);
        assert_eq!(g.stem, "invoice");
        assert_eq!(g.ext, "pdf");
        assert_eq!(g.files.len(), 4);
        assert_eq!(marker_of(g, "invoice.pdf"), None);
        assert_eq!(marker_of(g, "invoice (1).pdf").as_deref(), Some("(1)"));
        assert_eq!(marker_of(g, "invoice copy.pdf").as_deref(), Some("copy"));
        assert_eq!(marker_of(g, "invoice - Copy.pdf").as_deref(), Some("copy"));
        assert!(g.all_same_size);
    }

    #[test]
    fn groups_the_macos_trailing_number_style() {
        let groups = scan(&[("IMG_1234.jpg", 2048), ("IMG_1234 2.jpg", 2048)]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].stem, "IMG_1234");
        assert_eq!(
            marker_of(&groups[0], "IMG_1234 2.jpg").as_deref(),
            Some("2")
        );
        assert_eq!(marker_of(&groups[0], "IMG_1234.jpg"), None);
    }

    #[test]
    fn does_not_group_names_that_are_merely_a_few_edits_apart() {
        // the edit-distance trap: three edits apart, completely unrelated files
        assert!(scan(&[("report-jan.pdf", 10), ("report-feb.pdf", 20)]).is_empty());
        assert!(scan(&[("draft-v1.docx", 10), ("draft-v2.docx", 20)]).is_empty());
    }

    #[test]
    fn does_not_strip_a_number_that_belongs_to_the_name() {
        assert!(scan(&[("Scan 2019.pdf", 10), ("Scan 2020.pdf", 20)]).is_empty());
        assert!(scan(&[("Part 007.mp3", 10), ("Part 008.mp3", 20)]).is_empty());
        // a bare number stem must not collapse to nothing either
        assert!(scan(&[("A 2.txt", 10), ("A 3.txt", 20)]).is_empty());
    }

    #[test]
    fn does_not_group_across_extensions() {
        assert!(scan(&[("song.mp3", 10), ("song.wav", 10)]).is_empty());
        // extension case is normalized though, so these do group
        let groups = scan(&[("photo.JPG", 10), ("photo copy.jpg", 10)]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].ext, "jpg");
    }

    #[test]
    fn all_same_size_is_only_true_when_every_file_matches() {
        let groups = scan(&[("notes.txt", 10), ("notes copy.txt", 99)]);
        assert_eq!(
            groups.len(),
            1,
            "a differently sized pair still forms a group"
        );
        assert_eq!(groups[0].files.len(), 2);
        assert!(!groups[0].all_same_size);
        let same = scan(&[("notes.txt", 10), ("notes copy.txt", 10)]);
        assert!(same[0].all_same_size);
    }

    #[test]
    fn strips_repeated_markers() {
        assert_eq!(normalize_stem("photo copy 2").0, "photo");
        assert_eq!(
            normalize_stem("photo copy 2").1.as_deref(),
            Some("copy 2"),
            "the number belongs to the copy marker, not the name"
        );
        assert_eq!(normalize_stem("photo copy (2)").0, "photo");
        assert_eq!(
            normalize_stem("photo copy (2)").1.as_deref(),
            Some("copy 2")
        );
        assert_eq!(normalize_stem("report (1) copy").0, "report");
        assert_eq!(normalize_stem("report_copy").0, "report");
        assert_eq!(normalize_stem("report-copy").0, "report");
        assert_eq!(normalize_stem("budget(3)").0, "budget");
        assert_eq!(normalize_stem("budget(3)").1.as_deref(), Some("(3)"));
        let groups = scan(&[("photo.jpg", 5), ("photo copy 2.jpg", 5)]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].stem, "photo");
    }

    #[test]
    fn cancelled_scan_returns_early() {
        let entries: Vec<FileEntry> = vec![entry("invoice.pdf", 10), entry("invoice copy.pdf", 10)];
        assert!(
            find_similar_names(&entries, NameStrategy::Copies, &AtomicBool::new(true)).is_empty(),
            "a cancelled scan must not look like a clean finish"
        );
        let media = vec![entry("Inception 1080p.mkv", 10), entry("Inception.mp4", 20)];
        assert!(
            find_similar_names(&media, NameStrategy::MediaTitle, &AtomicBool::new(true)).is_empty()
        );
    }

    #[test]
    fn groups_are_sorted_by_size_then_stem() {
        let groups = scan(&[
            ("zeta.txt", 1),
            ("zeta copy.txt", 1),
            ("alpha.txt", 1),
            ("alpha copy.txt", 1),
            ("beta.txt", 1),
            ("beta copy.txt", 1),
            ("beta (1).txt", 1),
        ]);
        let stems: Vec<&str> = groups.iter().map(|g| g.stem.as_str()).collect();
        assert_eq!(stems, vec!["beta", "alpha", "zeta"]);
    }

    #[test]
    fn files_without_an_extension_still_group() {
        let groups = scan(&[("Makefile", 10), ("Makefile copy", 10)]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].ext, "");
        assert_eq!(groups[0].stem, "Makefile");
    }

    #[test]
    fn media_groups_one_title_across_qualities_and_containers() {
        let groups = scan_media(&[
            ("Inception.2010.720p.BluRay.x264-GRP.mp4", 1_000_000),
            ("inception 1080p.mkv", 8_000_000),
            ("Inception.2010.REMUX.mkv", 30_000_000),
        ]);
        assert_eq!(groups.len(), 1);
        let g = &groups[0];
        assert_eq!(g.strategy, NameStrategy::MediaTitle);
        assert_eq!(g.stem, "inception");
        assert_eq!(g.ext, "");
        assert_eq!(g.year, Some(2010));
        assert_eq!(g.files.len(), 3);
        // wildly different sizes are the whole point here
        assert!(!g.all_same_size);
        let bluray = file_of(g, "Inception.2010.720p.BluRay.x264-GRP.mp4");
        assert_eq!(bluray.marker.as_deref(), Some("720p"));
        for tok in ["2010", "720p", "bluray", "x264", "grp"] {
            assert!(
                bluray.stripped.iter().any(|s| s == tok),
                "{} should be reported as stripped, got {:?}",
                tok,
                bluray.stripped
            );
        }
        assert_eq!(
            file_of(g, "inception 1080p.mkv").stripped,
            vec!["1080p".to_string()]
        );
        assert!(file_of(g, "Inception.2010.REMUX.mkv")
            .stripped
            .iter()
            .any(|s| s == "remux"));
    }

    #[test]
    fn media_keeps_sequels_apart() {
        assert!(
            scan_media(&[("Iron Man 2 1080p.mkv", 10), ("Iron Man 3 1080p.mkv", 20)]).is_empty()
        );
        assert!(scan_media(&[
            ("Iron.Man.2.2010.1080p.BluRay.mkv", 10),
            ("Iron.Man.3.2013.1080p.BluRay.mkv", 20)
        ])
        .is_empty());
    }

    #[test]
    fn media_keeps_remakes_apart_by_year() {
        assert!(scan_media(&[
            ("The Thing 1982 1080p.mkv", 10),
            ("The Thing 2011 1080p.mkv", 20)
        ])
        .is_empty());
        // and a year-less file is dropped rather than guessed into one of them
        assert!(scan_media(&[
            ("The Thing 1982 1080p.mkv", 10),
            ("The Thing 2011 1080p.mkv", 20),
            ("The Thing 720p.mp4", 30)
        ])
        .is_empty());
    }

    #[test]
    fn media_never_mixes_video_with_audio() {
        assert!(scan_media(&[("Inception 1080p.mkv", 10), ("Inception.flac", 20)]).is_empty());
        let audio = scan_media(&[("Inception.flac", 10), ("Inception.mp3", 20)]);
        assert_eq!(audio.len(), 1, "audio still groups with audio");
    }

    #[test]
    fn media_rejects_junk_titles() {
        assert!(scan_media(&[("a.mp4", 10), ("b.mp4", 20)]).is_empty());
        // nothing survives normalization, so these must not collapse together
        assert!(scan_media(&[("1080p.mkv", 10), ("x264.mkv", 20)]).is_empty());
        assert!(scan_media(&[("[YTS.AM].mp4", 10), ("(1080p).mkv", 20)]).is_empty());
    }

    #[test]
    fn media_drops_bracketed_noise_and_keeps_hyphenated_titles() {
        let (title, year, stripped) =
            normalize_media_title("Spider-Man.Into.the.Spider-Verse.2018.[YTS.AM].1080p");
        assert_eq!(title, "spider man into the spider verse");
        assert_eq!(year, Some(2018));
        assert!(stripped.iter().any(|s| s == "yts"));
        assert!(stripped.iter().any(|s| s == "1080p"));
        let groups = scan_media(&[
            (
                "Spider-Man.Into.the.Spider-Verse.2018.[YTS.AM].1080p.mp4",
                5,
            ),
            ("spider man into the spider-verse (2018) 720p WEB-DL.mkv", 9),
        ]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].year, Some(2018));
    }

    #[test]
    fn media_strips_channel_layouts_without_eating_sequel_numbers() {
        let (title, _, stripped) = normalize_media_title("John.Wick.Chapter.2.2017.1080p.DTS.5.1");
        assert_eq!(title, "john wick chapter 2");
        assert!(stripped.iter().any(|s| s == "5 1"));
        assert!(normalize_media_title("Blade Runner 2049 2017 2160p")
            .0
            .eq("blade runner"));
    }
}
