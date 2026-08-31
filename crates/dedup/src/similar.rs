use crate::{in_pool, scan_pool, ScanMode};
use fo_indexer::FileEntry;
use image::{DynamicImage, GrayImage, ImageFormat, ImageReader, RgbImage};
use image_hasher::{HasherConfig, ImageHash};
use jpeg_decoder::{Decoder as JpegDecoder, PixelFormat};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"];
/// Guard against the O(n^2) pairwise pass on huge folders. Measured on this
/// machine, 50k hashes is ~1.8s of pairwise distance checks (1.25 billion pairs)
/// and ~15 MB of hashes, both dwarfed by the time spent reading 50k photos off
/// the disk in the first place. Past that the quadratic term starts to show.
const MAX_IMAGES: usize = 50_000;
/// Longest side the hasher is fed. A dHash reduces the picture to an 8x8 grid,
/// so everything past a few hundred pixels is thrown away; shrinking first with
/// a box average keeps the grayscale and Lanczos passes off full-resolution
/// pixels. Applied to every format, so one file always hashes the same way.
const HASH_INPUT_PX: u32 = 256;

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

/// What a similar-image pass found, plus the reason it might have found nothing.
/// An empty `groups` with `too_many_images` set means "nothing was compared",
/// not "nothing is alike", and the UI has to say which it is instead of
/// reporting a clean scan.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SimilarResult {
    pub groups: Vec<SimilarGroup>,
    /// Images found in the folder, when that count is past `MAX_IMAGES` and the
    /// pass therefore did not run. `None` on any scan that actually compared.
    pub too_many_images: Option<usize>,
}

/// image 0.25 decodes JPEG through zune-jpeg, which exposes no scaled-decode
/// entry point, so the JPEG path drops to jpeg-decoder for its DCT scaling
/// (1/2, 1/4, 1/8): a 24MP photo comes back around 750x500 without the full
/// resolution ever being materialised. Anything that is not a JPEG, or whose
/// pixel format is not one of the two common ones, returns `None` and falls
/// back to the ordinary decode.
fn jpeg_scaled(file: &mut BufReader<fs::File>) -> Option<DynamicImage> {
    let mut dec = JpegDecoder::new(file);
    dec.scale(HASH_INPUT_PX as u16, HASH_INPUT_PX as u16).ok()?;
    let info = dec.info()?;
    let px = dec.decode().ok()?;
    let (w, h) = (u32::from(info.width), u32::from(info.height));
    match info.pixel_format {
        PixelFormat::L8 => GrayImage::from_raw(w, h, px).map(DynamicImage::ImageLuma8),
        PixelFormat::RGB24 => RgbImage::from_raw(w, h, px).map(DynamicImage::ImageRgb8),
        _ => None,
    }
}

/// Perceptual (gradient/dHash, 64-bit) hash of a raster image, robust to
/// re-encoding and small edits. Supports jpg/png/gif/bmp/webp/tiff.
///
/// Streamed, never slurped: a 70 MB uncompressed TIFF must not become 70 MB of
/// resident bytes per scanning thread. The picture is shrunk to `HASH_INPUT_PX`
/// before hashing, so one file always produces the same hash whichever decode
/// path it took.
pub fn perceptual_hash(path: &Path) -> anyhow::Result<ImageHash> {
    let mut file = BufReader::with_capacity(64 * 1024, fs::File::open(path)?);
    let mut head = [0u8; 16];
    let n = file.read(&mut head)?;
    file.rewind()?;
    let jpeg = image::guess_format(&head[..n]).ok() == Some(ImageFormat::Jpeg);
    let img = match jpeg.then(|| jpeg_scaled(&mut file)).flatten() {
        Some(img) => img,
        None => {
            file.rewind()?;
            ImageReader::new(&mut file)
                .with_guessed_format()?
                .decode()?
        }
    };
    let img = if img.width().max(img.height()) > HASH_INPUT_PX {
        img.thumbnail(HASH_INPUT_PX, HASH_INPUT_PX)
    } else {
        img
    };
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
///
/// A folder past `MAX_IMAGES` comes back with `too_many_images` set to the count
/// and no groups: refusing to compare is a legitimate outcome, reporting it as
/// "nothing alike" is not.
pub fn find_similar_images(
    entries: &[FileEntry],
    max_distance: u32,
    mode: ScanMode,
    cancel: &AtomicBool,
    unreadable: &AtomicUsize,
    progress: impl Fn(usize, usize) + Sync,
) -> SimilarResult {
    let mut images: Vec<&FileEntry> = entries.iter().filter(|e| is_image(&e.path)).collect();
    if images.len() > MAX_IMAGES {
        return SimilarResult {
            groups: Vec::new(),
            too_many_images: Some(images.len()),
        };
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
    SimilarResult {
        groups,
        too_many_images: None,
    }
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
        let out = find_similar_images(
            &entries,
            10,
            ScanMode::Sequential,
            &AtomicBool::new(false),
            &AtomicUsize::new(0),
            |_, _| {},
        );
        assert!(out.too_many_images.is_none());
        let groups = out.groups;
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
        assert!(cancelled.groups.is_empty());
        // an image that went away with its drive is counted, not dropped quietly
        std::fs::remove_file(dir.path().join("other.png")).unwrap();
        let unreadable = AtomicUsize::new(0);
        let out = find_similar_images(
            &entries,
            10,
            ScanMode::Sequential,
            &AtomicBool::new(false),
            &unreadable,
            |_, _| {},
        );
        assert_eq!(unreadable.load(Ordering::Relaxed), 1);
        assert_eq!(out.groups.len(), 1);
    }

    /// The pre-shrink and the scaled JPEG decode only kick in past
    /// `HASH_INPUT_PX`, so the small fixtures above never exercise them: a
    /// full-size photo and a re-encoded, resized copy of it still have to land
    /// in one group, and an unrelated photo still has to stay out.
    #[test]
    fn groups_near_duplicates_of_full_size_photos() {
        let dir = tempfile::tempdir().unwrap();
        let base = RgbImage::from_fn(1600, 1200, |x, y| {
            let blob = (((x / 200) + (y / 150)) % 3) as u8;
            Rgb([
                (x / 7) as u8,
                (y / 5).wrapping_add(u32::from(blob) * 60) as u8,
                (x.wrapping_mul(y) / 401) as u8,
            ])
        });
        base.save(dir.path().join("photo.jpg")).unwrap();
        // The same shot resized and resaved, the way a phone backup or a chat
        // app hands it back.
        DynamicImage::ImageRgb8(base.clone())
            .resize(900, 675, image::imageops::FilterType::Triangle)
            .to_rgb8()
            .save(dir.path().join("photo_small.jpg"))
            .unwrap();
        RgbImage::from_fn(1600, 1200, |x, y| {
            Rgb([if (x / 80 + y / 80) % 2 == 0 { 250 } else { 10 }, 20, 200])
        })
        .save(dir.path().join("unrelated.png"))
        .unwrap();
        let entries = WalkdirSource.enumerate(dir.path()).unwrap();
        let out = find_similar_images(
            &entries,
            8,
            ScanMode::Sequential,
            &AtomicBool::new(false),
            &AtomicUsize::new(0),
            |_, _| {},
        );
        assert_eq!(out.groups.len(), 1, "{:?}", out.groups);
        let mut names: Vec<String> = out.groups[0]
            .files
            .iter()
            .map(|f| f.path.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["photo.jpg", "photo_small.jpg"]);
    }

    /// The old cap returned an empty vec, which the UI could only read as "no
    /// similar images". A refusal has to be distinguishable from an answer.
    #[test]
    fn a_folder_past_the_cap_reports_the_count_instead_of_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let img = RgbImage::from_fn(8, 8, |x, y| Rgb([(x * 8) as u8, (y * 8) as u8, 0]));
        img.save(dir.path().join("a.png")).unwrap();
        let one = WalkdirSource.enumerate(dir.path()).unwrap();
        // Cheaper than writing 50k files: the same entry repeated is still
        // 50k+ images as far as the cap is concerned.
        let entries: Vec<FileEntry> = std::iter::repeat_n(one[0].clone(), MAX_IMAGES + 1).collect();
        let out = find_similar_images(
            &entries,
            10,
            ScanMode::Sequential,
            &AtomicBool::new(false),
            &AtomicUsize::new(0),
            |_, _| {},
        );
        assert!(out.groups.is_empty());
        assert_eq!(out.too_many_images, Some(MAX_IMAGES + 1));
    }
}
