use anyhow::Result;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HashAlgo {
    Blake3,
    Sha256,
}

/// Read size for full-file hashing. Large enough that a multi-gigabyte file is
/// read in a few thousand syscalls rather than tens of thousands, which matters
/// most on spinning disks where each read costs a seek if the head has moved.
/// Heap allocated: a buffer this size does not belong on the stack.
const READ_CHUNK: usize = 1 << 20;

/// Hash a file's contents and return lowercase hex. Streamed in chunks, so peak
/// memory is the buffer regardless of how big the file is.
pub fn hash_file(path: &Path, algo: HashAlgo) -> Result<String> {
    // No BufReader: these reads are already far larger than its buffer, so it
    // would just pass them straight through.
    let mut file = File::open(path)?;
    let mut buf = vec![0u8; READ_CHUNK];
    match algo {
        HashAlgo::Blake3 => {
            let mut hasher = blake3::Hasher::new();
            loop {
                let n = file.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            Ok(hasher.finalize().to_hex().to_string())
        }
        HashAlgo::Sha256 => {
            let mut hasher = Sha256::new();
            loop {
                let n = file.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            Ok(hex_lower(&hasher.finalize()))
        }
    }
}

/// Hash the first and last `bytes` of a file (whole file if it is <= 2*bytes). Lowercase hex.
pub fn hash_partial(path: &Path, algo: HashAlgo, bytes: usize) -> Result<String> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    if len <= (2 * bytes) as u64 {
        let mut whole = Vec::new();
        file.read_to_end(&mut whole)?;
        return Ok(digest(algo, &[&whole]));
    }
    let mut head = vec![0u8; bytes];
    file.seek(SeekFrom::Start(0))?;
    file.read_exact(&mut head)?;
    let mut tail = vec![0u8; bytes];
    file.seek(SeekFrom::End(-(bytes as i64)))?;
    file.read_exact(&mut tail)?;
    Ok(digest(algo, &[&head, &tail]))
}

fn digest(algo: HashAlgo, chunks: &[&[u8]]) -> String {
    match algo {
        HashAlgo::Blake3 => {
            let mut hasher = blake3::Hasher::new();
            for c in chunks {
                hasher.update(c);
            }
            hasher.finalize().to_hex().to_string()
        }
        HashAlgo::Sha256 => {
            let mut hasher = Sha256::new();
            for c in chunks {
                hasher.update(c);
            }
            hex_lower(&hasher.finalize())
        }
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}
