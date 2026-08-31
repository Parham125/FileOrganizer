//! On-demand, disk-cached thumbnails for the rows the UI is actually showing.
//!
//! Nothing here is eager: the caller asks for a handful of paths, each one is
//! decoded at most once per (file, size) and the JPEG is kept on disk, so a
//! second look at the same rows never touches the source drive again. Only the
//! raster formats the similar-image pass understands are supported; video, PDF
//! and RAW are out of scope and simply produce no thumbnail.

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{ExtendedColorType, ImageEncoder, ImageReader, Rgb, RgbImage};
use rayon::prelude::*;
use serde::Serialize;
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Same set as fo-dedup's similar-image pass, so anything the app can call
/// "similar" can also be shown.
pub const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"];
/// Refuse to read absurd files at all: past this the decode cost is never worth
/// a 96px preview.
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// Checked from the header before decoding, because a 20000x20000 PNG is a few
/// hundred KB on disk and gigabytes in memory.
pub const MAX_PIXELS: u64 = 50_000_000;
const JPEG_QUALITY: u8 = 75;
/// A thumbnail request must never saturate the machine the way a full scan may.
const MAX_THREADS: usize = 4;

/// One row's thumbnail. `data_uri` and `error` are both `None` when the file is
/// simply not an image the app can preview, which the UI shows as no image.
#[derive(Debug, Clone, Serialize)]
pub struct Thumb {
    pub path: String,
    pub data_uri: Option<String>,
    pub error: Option<String>,
}

/// Whether a path is a raster image this crate can thumbnail.
pub fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Cache identity: the absolute path plus the bytes that would change if the
/// file were edited or replaced, plus the requested size. An edit changes mtime
/// or length, so a stale thumbnail can never be served.
pub fn cache_key(path: &Path, mtime_ns: u128, size: u64, max_px: u32) -> String {
    let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut hasher = blake3::Hasher::new();
    hasher.update(abs.to_string_lossy().as_bytes());
    hasher.update(b"\0");
    hasher.update(&mtime_ns.to_le_bytes());
    hasher.update(&size.to_le_bytes());
    hasher.update(&max_px.to_le_bytes());
    hasher.finalize().to_hex().to_string()
}

/// A JPEG thumbnail of `path` as a `data:image/jpeg;base64,...` URI, whose
/// longest side is `max_px` (smaller images are never upscaled).
///
/// Reads from `<cache_dir>/<key>.jpg` when it is there and writes it after
/// generating. A cache that cannot be read or written is ignored rather than
/// fatal: a broken cache costs speed, never a thumbnail.
pub fn thumbnail(path: &Path, max_px: u32, cache_dir: &Path) -> anyhow::Result<String> {
    if max_px == 0 {
        anyhow::bail!("thumbnail size must be at least 1px");
    }
    let meta = fs::metadata(path).map_err(|_| anyhow::anyhow!("not available"))?;
    if !meta.is_file() {
        anyhow::bail!("not available");
    }
    if meta.len() > MAX_FILE_BYTES {
        anyhow::bail!("too large to preview ({} MB)", meta.len() / (1024 * 1024));
    }
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let cached = cache_dir.join(format!(
        "{}.jpg",
        cache_key(path, mtime_ns, meta.len(), max_px)
    ));
    if let Ok(bytes) = fs::read(&cached) {
        if !bytes.is_empty() {
            return Ok(data_uri(&bytes));
        }
    }
    // One read of the source, two passes over it: the header for the size
    // guard, then the real decode. On a spinning disk the second open would
    // cost another seek.
    let raw = fs::read(path).map_err(|_| anyhow::anyhow!("not available"))?;
    let (w, h) = ImageReader::new(Cursor::new(&raw))
        .with_guessed_format()?
        .into_dimensions()?;
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        anyhow::bail!("image too large to preview ({w}x{h})");
    }
    let img = ImageReader::new(Cursor::new(&raw))
        .with_guessed_format()?
        .decode()?;
    let img = if w.max(h) > max_px {
        img.resize(max_px, max_px, FilterType::Lanczos3)
    } else {
        img
    };
    // Flatten onto white instead of dropping alpha, so a transparent logo does
    // not come back as a black square.
    let rgb: RgbImage = if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
            let p = rgba.get_pixel(x, y).0;
            let a = u32::from(p[3]);
            let over = |c: u8| ((u32::from(c) * a + 255 * (255 - a)) / 255) as u8;
            Rgb([over(p[0]), over(p[1]), over(p[2])])
        })
    } else {
        img.to_rgb8()
    };
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).write_image(
        &rgb,
        rgb.width(),
        rgb.height(),
        ExtendedColorType::Rgb8,
    )?;
    let _ = fs::create_dir_all(cache_dir);
    let _ = fs::write(&cached, &out);
    Ok(data_uri(&out))
}

fn data_uri(bytes: &[u8]) -> String {
    format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Thumbnail a batch of paths on a small pool. Every path comes back in the
/// same order with its own outcome; one unreadable file never fails the batch.
pub fn thumbnails(paths: &[String], max_px: u32, cache_dir: &Path) -> Vec<Thumb> {
    let _ = fs::create_dir_all(cache_dir);
    let run = || {
        paths
            .par_iter()
            .map(|p| {
                let path = Path::new(p);
                if !is_image(path) {
                    return Thumb {
                        path: p.clone(),
                        data_uri: None,
                        error: None,
                    };
                }
                match thumbnail(path, max_px, cache_dir) {
                    Ok(uri) => Thumb {
                        path: p.clone(),
                        data_uri: Some(uri),
                        error: None,
                    },
                    Err(e) => Thumb {
                        path: p.clone(),
                        data_uri: None,
                        error: Some(e.to_string()),
                    },
                }
            })
            .collect()
    };
    match rayon::ThreadPoolBuilder::new()
        .num_threads(MAX_THREADS)
        .build()
    {
        Ok(pool) => pool.install(run),
        Err(_) => run(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::Duration;

    fn decode_uri(uri: &str) -> Vec<u8> {
        let b64 = uri
            .strip_prefix("data:image/jpeg;base64,")
            .expect("data uri");
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .expect("base64")
    }

    fn write_png(path: &Path, w: u32, h: u32) {
        let img = RgbImage::from_fn(w, h, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 128]));
        img.save(path).expect("write png");
    }

    #[test]
    fn generates_a_data_uri_sized_to_max_px() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.png");
        write_png(&src, 200, 100);
        let uri = thumbnail(&src, 64, &dir.path().join("cache")).unwrap();
        assert!(uri.starts_with("data:image/jpeg;base64,"));
        let img = image::load_from_memory(&decode_uri(&uri)).unwrap();
        assert_eq!((img.width(), img.height()), (64, 32));
    }

    #[test]
    fn never_upscales_a_small_image() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("small.png");
        write_png(&src, 20, 10);
        let uri = thumbnail(&src, 96, &dir.path().join("cache")).unwrap();
        let img = image::load_from_memory(&decode_uri(&uri)).unwrap();
        assert_eq!((img.width(), img.height()), (20, 10));
    }

    #[test]
    fn second_call_is_served_from_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let src = dir.path().join("a.png");
        write_png(&src, 200, 100);
        thumbnail(&src, 64, &cache).unwrap();
        let meta = fs::metadata(&src).unwrap();
        let mtime_ns = meta
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let key = cache.join(format!("{}.jpg", cache_key(&src, mtime_ns, meta.len(), 64)));
        assert!(key.exists(), "generating should have written the cache");
        fs::write(&key, b"SENTINEL").unwrap();
        let uri = thumbnail(&src, 64, &cache).unwrap();
        assert_eq!(decode_uri(&uri), b"SENTINEL");
    }

    #[test]
    fn cache_misses_after_the_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let src = dir.path().join("a.png");
        write_png(&src, 200, 100);
        let first = thumbnail(&src, 64, &cache).unwrap();
        let meta = fs::metadata(&src).unwrap();
        let mtime_ns = meta
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let key = cache.join(format!("{}.jpg", cache_key(&src, mtime_ns, meta.len(), 64)));
        fs::write(&key, b"SENTINEL").unwrap();
        // Move the mtime by hand: rewriting the same bytes can land on the same
        // coarse filesystem timestamp and make this test lie.
        fs::OpenOptions::new()
            .write(true)
            .open(&src)
            .unwrap()
            .set_modified(meta.modified().unwrap() + Duration::from_secs(5))
            .unwrap();
        let uri = thumbnail(&src, 64, &cache).unwrap();
        assert_ne!(decode_uri(&uri), b"SENTINEL");
        assert_eq!(uri, first, "same pixels should re-encode identically");
    }

    #[test]
    fn a_non_image_has_no_thumbnail_and_no_error() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("notes.txt");
        fs::write(&src, "hello").unwrap();
        let out = thumbnails(
            &[src.to_string_lossy().to_string()],
            64,
            &dir.path().join("cache"),
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].data_uri.is_none());
        assert!(out[0].error.is_none());
    }

    #[test]
    fn a_corrupt_image_reports_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("broken.png");
        fs::write(&src, b"not a png at all").unwrap();
        let out = thumbnails(
            &[src.to_string_lossy().to_string()],
            64,
            &dir.path().join("cache"),
        );
        assert!(out[0].data_uri.is_none());
        assert!(out[0].error.is_some());
    }

    #[test]
    fn an_oversize_file_reports_an_error_without_decoding() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("huge.jpg");
        let f = fs::File::create(&src).unwrap();
        f.set_len(MAX_FILE_BYTES + 1).unwrap();
        drop(f);
        let err = thumbnail(&src, 64, &dir.path().join("cache")).unwrap_err();
        assert!(err.to_string().contains("too large"), "{err}");
    }

    #[test]
    fn a_missing_path_reports_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let out = thumbnails(
            &[dir.path().join("gone.png").to_string_lossy().to_string()],
            64,
            &dir.path().join("cache"),
        );
        assert_eq!(out[0].error.as_deref(), Some("not available"));
    }

    #[test]
    fn a_broken_cache_directory_still_yields_a_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.png");
        write_png(&src, 40, 40);
        // A regular file where the cache directory should be: every read and
        // write against it fails, and the thumbnail still comes back.
        let cache = dir.path().join("cache");
        let mut f = fs::File::create(&cache).unwrap();
        f.write_all(b"x").unwrap();
        drop(f);
        assert!(thumbnail(&src, 32, &cache).is_ok());
    }
}
