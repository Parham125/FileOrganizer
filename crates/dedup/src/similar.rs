use fo_indexer::FileEntry;
use image_hasher::{HasherConfig, ImageHash};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"];
/// Guard against the O(n^2) pairwise pass on huge folders.
const MAX_IMAGES: usize = 5000;

/// A cluster of perceptually similar (near-duplicate) images.
#[derive(Debug, Clone, Serialize)]
pub struct SimilarGroup {
    pub paths: Vec<PathBuf>,
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
pub fn find_similar_images(
    entries: &[FileEntry],
    max_distance: u32,
    progress: impl Fn(usize, usize) + Sync,
) -> Vec<SimilarGroup> {
    let images: Vec<&FileEntry> = entries.iter().filter(|e| is_image(&e.path)).collect();
    if images.len() > MAX_IMAGES {
        return Vec::new();
    }
    let total = images.len();
    let done = AtomicUsize::new(0);
    let hashed: Vec<(PathBuf, ImageHash)> = images
        .par_iter()
        .filter_map(|e| {
            let out = perceptual_hash(&e.path).ok().map(|h| (e.path.clone(), h));
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            progress(n, total);
            out
        })
        .collect();
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
                paths: idx.iter().map(|&i| hashed[i].0.clone()).collect(),
                distance,
            }
        })
        .collect();
    groups.sort_by(|a, b| b.paths.len().cmp(&a.paths.len()));
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
        let groups = find_similar_images(&entries, 10, |_, _| {});
        assert_eq!(groups.len(), 1, "expected exactly one near-dup group");
        assert_eq!(groups[0].paths.len(), 2);
        let mut names: Vec<String> = groups[0]
            .paths
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["base.png", "near.jpg"]);
    }
}
