# FileOrganizer

A fast, cross-platform desktop app to **search, index, and deduplicate** your files, with an AI-assisted organizer on the way. Built with Tauri v2 (Rust core) and React.

Everything you delete goes through an app-managed trash with a full undo journal, so the tool is safe to actually run on your real files.

> Status: **v1** ships search + index + dedup. The agentic AI organizer is the next milestone (see [Roadmap](#roadmap)).

## Screenshots

| Search | Duplicates | Trash |
| --- | --- | --- |
| ![Search](docs/screenshots/search.png) | ![Duplicates](docs/screenshots/duplicates.png) | ![Trash](docs/screenshots/trash.png) |

## Features

- **Instant search** over a live index. Substring filename matching (SQLite FTS5 with a trigram tokenizer, not just prefix), with size and extension filters, in a virtualized list that stays smooth at 100k+ rows.
- **Live indexing.** Point it at a folder; it crawls once and then keeps up with changes as they happen (via filesystem watch events).
- **Deduplicator.** A staged pipeline (group by size, then a partial hash, then a full content hash) finds byte-for-byte duplicates without hashing everything. Hashing is parallelized. Results group by wasted space, preselect the safe copies to remove, and never delete without you.
- **Safe deletion.** Removed files move to an app-managed quarantine with a manifest of where they came from. Restore any file or whole operation, undo the last delete, or empty the trash when you're sure. Restores never overwrite an existing file.
- **BLAKE3 or SHA-256.** BLAKE3 by default for speed; SHA-256 selectable in Settings.
- **Light and dark themes**, keyboard-friendly, no telemetry.

## Architecture

Rust does the heavy lifting; the UI is a thin React layer talking to it over Tauri commands.

```
crates/
  fo-indexer   filesystem enumeration (walkdir) + live watcher (notify)
  fo-hasher    BLAKE3 / SHA-256, full and partial hashing
  fo-dedup     staged duplicate-detection pipeline (rayon-parallel)
  fo-search    SQLite FTS5 index (trigram tokenizer, WAL)
  fo-trash     quarantine store + undo journal (own SQLite DB)
  fo-ai        OpenRouter client (BYO key) - wired in a later milestone
src-tauri/     Tauri v2 app: commands, events, state
src/           React + Vite + TypeScript frontend
```

The indexer is built around a `FileSource` trait. v1 uses a portable `walkdir` + `notify` source that runs everywhere. A Windows-only fast path that reads the NTFS MFT and USN Journal directly (Everything-style, near-instant full-drive indexing) is planned behind the same trait.

## Develop

Requires Rust, Node, and pnpm.

```sh
pnpm install
pnpm tauri dev        # run the desktop app
```

The frontend can also run in a plain browser for UI work (`pnpm dev`) - it serves mock data when the Tauri runtime isn't present, so every view is usable without launching the shell.

Checks:

```sh
cargo test --workspace    # Rust unit tests (dedup, trash, search)
cargo check --workspace
pnpm build                # typecheck + frontend build
```

On macOS, run `. "$HOME/.cargo/env"` first if `cargo` isn't on your PATH.

## Build

```sh
pnpm tauri build          # release build + installer for the current OS
```

Windows installers are produced in CI (see `.github/workflows/`). Development is macOS-first; the Windows-specific fast path is validated separately.

## Roadmap

- **v1 (now):** index, instant search, deduplicator, safe trash + undo.
- **Next:** AI organizer via OpenRouter (BYO key, default `anthropic/claude-sonnet-5`) - semantic search over your files and an agentic auto-organize that proposes a folder plan, previews it, and applies it reversibly.
- **Later:** Windows MFT/USN fast indexer, perceptual/near-duplicate matching for images, content search inside documents.

## Credits

Built by [Parham](https://github.com/Parham125), with development help from Claude (Anthropic's Claude Code).

## License

MIT. See [LICENSE](LICENSE).
