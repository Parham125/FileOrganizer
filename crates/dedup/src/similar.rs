use crate::{in_pool, scan_pool, ScanMode};
use fo_indexer::FileEntry;
use image_hasher::{HasherConfig, ImageHash};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"];
/// Guard against the O(n^2) pairwise pass on huge folders.
const MAX_IMAGES: usize = 5000;

/// One image in a near-duplicate cluster. Same shape as `NameMatch` so the UI
/// can filter and sort both scans the same way: deciding which copy of a resaved
/// photo to keep is a question about size, and the metadata is already in hand
/// from the index, so carrying it costs no extra I/O.
#[derive(Debug, Clone, Serialize)]
pub struct SimilarFile {
    pub path: PathBuf,
    pub size: u64,
    pub modified_ns: Option<i64>,
}

/// A cluster of perceptually similar (near-duplicate) images.
#[derive(Debug, Clone, Serialize)]
pub struct SimilarGroup {
    pub files: Vec<SimilarFile>,
    pub distance: u32,
}

/// Perceptual (gradient/dHash, 64-bit) hash of a raster image, robust to
/// re-encoding and small edits. Supports jpg/png/gif/bmp/webp/tiff.
pub fn perceptual_hash(path: &Path) -> anyhow::Result<ImageHash> {
    let img = image::open(path)?;
    Ok(HasherConfig::new().to_hasher().hash_image(&img))
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn uf_find(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

/// Group images whose perceptual-hash Hamming distance is within `max_distance`.
/// Hashes in parallel (skipping files that fail to decode), then clusters with
/// union-find. Each returned group has 2+ members and reports the largest
/// pairwise distance inside it; groups are sorted by member count desc.
///
/// Raising `cancel` stops the hashing pass and clusters only what was already
/// hashed; the caller reads the flag afterwards to tell that from a clean run.
///
/// `unreadable` counts images that could not be opened or decoded, so a scan
/// over a drive that went away reports the gap instead of quietly returning
/// fewer groups.
pub fn find_similar_images(
    entries: &[FileEntry],
    max_distance: u32,
    mode: ScanMode,
    cancel: &AtomicBool,
    unreadable: &AtomicUsize,
    progress: impl Fn(usize, usize) + Sync,
) -> Vec<SimilarGroup> {
    let mut images: Vec<&FileEntry> = entries.iter().filter(|e| is_image(&e.path)).collect();
    if images.len() > MAX_IMAGES {
        return Vec::new();
    }
    // Decode in directory order so an HDD reads forward instead of seeking.
    images.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    let total = images.len();
    let done = AtomicUsize::new(0);
    let pool = scan_pool(mode);
    let hashed: Vec<(SimilarFile, ImageHash)> = in_pool(pool.as_ref(), || {
        images
            .par_iter()
            .filter_map(|e| {
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
                let out = match perceptual_hash(&e.path) {
                    Ok(h) => Some((
                        SimilarFile {
                            path: e.path.clone(),
                            size: e.size,
                            modified_ns: e
                                .modified
                                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                                .and_then(|d| i64::try_from(d.as_nanos()).ok()),
                        },
                        h,
                    )),
                    Err(_) => {
                        unreadable.fetch_add(1, Ordering::Relaxed);
                        None
                    }
                };
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                progress(n, total);
                out
            })
            .collect()
    });
    let n = hashed.len();
    let mut parent: Vec<usize> = (0..n).collect();
    for i in 0..n {
        for j in (i + 1)..n {
            if hashed[i].1.dist(&hashed[j].1) <= max_distance {
                let (ri, rj) = (uf_find(&mut parent, i), uf_find(&mut parent, j));
                if ri != rj {
                    parent[ri] = rj;
                }
            }
        }
    }
    let mut clusters: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        let r = uf_find(&mut parent, i);
        clusters.entry(r).or_default().push(i);
    }
    let mut groups: Vec<SimilarGroup> = clusters
        .into_values()
        .filter(|idx| idx.len() > 1)
        .map(|idx| {
            let mut distance = 0;
            for a in 0..idx.len() {
                for b in (a + 1)..idx.len() {
                    distance = distance.max(hashed[idx[a]].1.dist(&hashed[idx[b]].1));
                }
            }
            SimilarGroup {
                files: idx.iter().map(|&i| hashed[i].0.clone()).collect(),
                distance,
            }
        })
        .collect();
    groups.sort_by(|a, b| b.files.len().cmp(&a.files.len()));
    groups
}

#[cfg(test)]
mod tests {
    use super::*;
    use fo_indexer::{FileSource, WalkdirSource};
    use image::{Rgb, RgbImage};

    #[test]
    fn groups_near_duplicates_and_excludes_different() {
        let dir = tempfile::tempdir().unwrap();
        // A smooth gradient image.
        let mut base = RgbImage::new(64, 64);
        for (x, y, px) in base.enumerate_pixels_mut() {
            *px = Rgb([(x * 3) as u8, (y * 3) as u8, 128]);
        }
        base.save(dir.path().join("base.png")).unwrap();
        // Same image with a single pixel nudged: perceptually identical, not byte-identical.
        let mut near = base.clone();
        near.put_pixel(0, 0, Rgb([base.get_pixel(0, 0)[0].wrapping_add(2), 0, 128]));
        near.save(dir.path().join("near.jpg")).unwrap();
        // A clearly different image (vertical stripes).
        let mut other = RgbImage::new(64, 64);
        for (x, _y, px) in other.enumerate_pixels_mut() {
            *px = if (x / 4) % 2 == 0 {
                Rgb([255, 255, 255])
            } else {
                Rgb([0, 0, 0])
            };
        }
        other.save(dir.path().join("other.png")).unwrap();
        let entries = WalkdirSource.enumerate(dir.path()).unwrap();
        let groups = find_similar_images(
            &entries,
            10,
            ScanMode::Sequential,
            &AtomicBool::new(false),
            &AtomicUsize::new(0),
            |_, _| {},
        );
        assert_eq!(groups.len(), 1, "expected exactly one near-dup group");
        assert_eq!(groups[0].files.len(), 2);
        let mut names: Vec<String> = groups[0]
            .files
            .iter()
            .map(|f| f.path.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["base.png", "near.jpg"]);
        // sizes and times ride along, so the UI can filter by size and show
        // which copy of a resaved photo is the bigger one
        for f in &groups[0].files {
            let on_disk = std::fs::metadata(&f.path).unwrap();
            assert_eq!(f.size, on_disk.len(), "{}", f.path.display());
            assert!(f.size > 0);
            assert!(f.modified_ns.is_some());
        }
        // cancelling before the first decode leaves nothing to cluster
        let cancelled = find_similar_images(
            &entries,
            10,
            ScanMode::Auto,
            &AtomicBool::new(true),
            &AtomicUsize::new(0),
            |_, _| {},
        );
        assert!(cancelled.is_empty());
        // an image that went away with its drive is counted, not dropped quietly
        std::fs::remove_file(dir.path().join("other.png")).unwrap();
        let unreadable = AtomicUsize::new(0);
        let groups = find_similar_images(
            &entries,
            10,
            ScanMode::Sequential,
            &AtomicBool::new(false),
            &unreadable,
            |_, _| {},
        );
        assert_eq!(unreadable.load(Ordering::Relaxed), 1);
        assert_eq!(groups.len(), 1);
    }
}
