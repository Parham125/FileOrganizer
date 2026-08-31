<div align="center">

<img src="docs/banner.png" alt="FileOrganizer" width="100%" />

<br/>
<br/>

[![Release](https://img.shields.io/github/v/release/Parham125/FileOrganizer?color=2f6f5e&label=release&style=flat-square)](https://github.com/Parham125/FileOrganizer/releases)
[![Downloads](https://img.shields.io/github/downloads/Parham125/FileOrganizer/total?color=2f6f5e&style=flat-square)](https://github.com/Parham125/FileOrganizer/releases)
[![License](https://img.shields.io/github/license/Parham125/FileOrganizer?color=2f6f5e&style=flat-square)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-2f6f5e?style=flat-square)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white&style=flat-square)
![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white&style=flat-square)
![React](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white&style=flat-square)

**A fast desktop app to search, index, and deduplicate your files, with an AI assistant that helps you tidy up, and asks before it touches anything.**

[Install](#install) &nbsp;·&nbsp; [Features](#features) &nbsp;·&nbsp; [Screenshots](#screenshots) &nbsp;·&nbsp; [How it works](#how-it-works) &nbsp;·&nbsp; [Build from source](#develop)

</div>

---

## Install

### Windows
Grab the latest installer from the [**Releases**](https://github.com/Parham125/FileOrganizer/releases) page:

- **`FileOrganizer_x64-setup.exe`** (recommended), or
- **`FileOrganizer_x64_en-US.msi`**

**Pick one format and keep updating with that one.** The two are different installer technologies that register separately, so installing with the MSI and then running the `.exe` leaves you with two installations rather than an update. Your data is shared either way, since it lives outside the install folder. The `.exe` is recommended because its uninstaller offers to remove the app's data and warns about files still sitting in the app's Trash; the MSI has no equivalent. To switch, uninstall the old one first.

Both are built from source by GitHub Actions on every release tag. The app is not code-signed, so SmartScreen warns on first run. Choose **More info -> Run anyway**.

### macOS
Take **`FileOrganizer_universal.dmg`** from the [**Releases**](https://github.com/Parham125/FileOrganizer/releases) page. It is a universal build, so it runs natively on Apple Silicon and Intel.

It is not signed or notarized, so Gatekeeper blocks it on first open: right-click the app and choose **Open**, or run `xattr -cr /Applications/FileOrganizer.app`. For the same reason the app cannot update itself on macOS (a freshly downloaded bundle is quarantined again, and Gatekeeper refuses it), so it tells you when a new version exists and links to the release instead. Windows and the Linux AppImage do update in place.

### Linux
x86_64 builds are on the [**Releases**](https://github.com/Parham125/FileOrganizer/releases) page. Pick by distro:

- **`.deb`** for Debian and Ubuntu
- **`.rpm`** for Fedora and other RPM distros
- **`.AppImage`** for anything else (`chmod +x` it and run it)

Built on Ubuntu 22.04, so they need **22.04 or newer** and equivalents (glibc 2.35+). Older distributions are not supported. Like the Windows and macOS builds, nothing here is signed. Take the `.AppImage` if you want in-app updates: it is the only Linux format Tauri's updater can replace in place, so a `.deb` or `.rpm` install has to be updated by downloading the new one.

---

## Features

🔎 **Instant search.** A live index with substring filename matching (SQLite FTS5 with a trigram tokenizer, not just prefixes), size and extension filters, in a virtualized list that stays smooth past 100k files.

♻️ **Deduplicator.** A staged pipeline (group by size, then a partial hash, then a full content hash) finds byte-for-byte duplicates without hashing everything. Parallel hashing, grouped by wasted space, safe copies preselected. BLAKE3 by default, SHA-256 optional.

🖼️ **Near-duplicate images.** Beyond exact copies, it finds photos that look the same (resaved, resized, lightly edited) using perceptual hashing, so you can clear out visual dupes too.

🏷️ **Similar names.** Finds a copy sitting next to its original (`invoice (1).pdf`), and one movie kept at two qualities (`Inception.2010.720p.mp4` beside `inception 1080p.mkv`, container ignored). Sequels and remakes are deliberately kept apart. Nothing here is hashed, so nothing is preselected: it shows you the sizes, the dates and why each file matched, and you decide.

📄 **Search inside documents.** Index a folder once and full-text search the text inside your files: plain text, code, PDF, and DOCX.

📊 **Storage insights.** See what is actually eating your disk: total indexed size, a size-by-type breakdown, and your biggest files, with the same open, reveal, and trash actions as search.

⚙️ **Rules.** Save a filter and an action once (say, PDFs in Downloads older than 90 days go to an archive folder), see exactly which files match before you commit, then run it whenever you like. Every run goes through Trash, so it is undoable.

🗂️ **AI organizer.** Point it at a messy folder and it proposes a tidy structure. You preview every move before anything happens, and it is fully reversible.

💬 **AI assistant.** A chat that can actually act: it searches, scans for duplicates, reads your storage breakdown, and proposes changes using real tools. It can also offer to save a recurring cleanup as a rule. Replies stream in as they are written, with live tool activity and formatted markdown, and past conversations are saved so you can pick one back up. Read-only actions run on their own; anything that moves or trashes a file becomes a one-tap approval card showing exactly which files are affected.

🛟 **Safe by design.** Deletions go to an app-managed Trash with a full undo journal, kept on the same drive as the file, so trashing from an external disk is instant and costs nothing on your system drive. Restore any file, undo the last change, or remove-forever when you are sure. Moves never overwrite, and the AI has no permanent-delete power at all.

⏹️ **Built for big, slow disks.** Scans can be stopped at any point, and a sequential mode reads one file at a time, which is usually much faster on an external or spinning drive. Duplicates can be found across every drive you have indexed at once, straight from the index with no re-walk.

🗜️ **Looks inside archives.** The assistant can list what is in a `.zip`, `.tar`, `.tar.gz` or `.7z` without extracting it, so you know what a big archive holds before deciding its fate. (RAR is not supported: every Rust binding ships bundled non-free C++.)

🧠 **Reasoning, your call.** Reasoning effort is a setting (off, low, medium, high), so you decide how hard the model thinks against how many tokens it spends. Its thinking streams in, collapsed, under the answer.

🔒 **Private.** Your files never leave your machine. The only network call is to your own AI provider, using your own key. Store the key in the OS keychain, or in the app's data folder if you would rather not be asked for your password on every launch.

---

## Screenshots

<div align="center">
<img src="docs/screenshots/assistant.png" alt="AI assistant proposing an action" width="90%" />
<p><em>The assistant proposes actions and waits for your approval, showing the exact files.</em></p>
</div>

<table>
<tr>
<td width="50%"><img src="docs/screenshots/search.png" alt="Search" /><p align="center"><em>Instant search with multi-select</em></p></td>
<td width="50%"><img src="docs/screenshots/duplicates.png" alt="Duplicates" /><p align="center"><em>Deduplicator, grouped by wasted space</em></p></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/organize.png" alt="Organize" /><p align="center"><em>AI organize, previewed before applying</em></p></td>
<td width="50%"><img src="docs/screenshots/trash.png" alt="Trash" /><p align="center"><em>Reversible Trash with undo</em></p></td>
</tr>
</table>

---

## How it works

Rust does the heavy lifting; a React UI talks to it over Tauri commands.

```
crates/
  fo-indexer   filesystem enumeration (walkdir) + Windows NTFS MFT fast path + live watcher (notify)
  fo-hasher    BLAKE3 / SHA-256, full and partial hashing
  fo-dedup     staged exact-duplicate pipeline + perceptual near-dup images (rayon-parallel)
  fo-search    SQLite FTS5 filename index (trigram) + document content index
  fo-extract   text extraction (plain/code, PDF, DOCX)
  fo-trash     quarantine store + reversible undo journal
  fo-ai        OpenRouter client + agentic tool loop
src-tauri/     Tauri v2 app: commands, events, state
src/           React + Vite + TypeScript frontend
```

The indexer is built around a `FileSource` trait. Everywhere it uses a portable `walkdir` + `notify` source. On Windows it also has a fast path (`MftSource`) that reads the NTFS MFT directly for near-instant full-drive enumeration (Everything-style), and falls back to the portable walker when that is not available.

### The AI assistant

The assistant is a tool-calling loop. Your message goes to the model along with a set of tools it may call:

- **Read-only** (`search_files`, `list_folder`, `find_duplicates`, `index_stats`) run automatically, and their results feed back into the conversation so the model can investigate.
- **Destructive** (`trash_files`, `move_files`) are never run by the loop. They come back as proposed actions you approve first, then execute through the reversible journal.

So the model never touches a file directly. It requests an action, and either it is safe and read-only, or it is a proposal you confirm. There is deliberately no permanent-delete tool.

---

## Develop

Requires Rust, Node, and pnpm.

```sh
pnpm install
pnpm tauri dev        # run the desktop app
```

The frontend also runs in a plain browser for UI work (`pnpm dev`); it serves mock data when the desktop runtime is not present, so every view is usable without launching the shell.

```sh
cargo test --workspace    # Rust unit tests (dedup, trash, search, agent)
pnpm build                # typecheck + frontend build
pnpm tauri build          # release build + installer for the current OS
```

Tagging a release (`git tag vX.Y.Z && git push origin vX.Y.Z`) triggers the GitHub Actions workflow that builds and publishes the Windows installers.

---

## Roadmap

- [x] Windows NTFS MFT fast indexer (near-instant full-drive enumeration)
- [x] Perceptual / near-duplicate matching for images
- [x] Content search inside documents
- [x] Storage insights, saved rules, chat history, streaming replies
- [ ] USN Journal live sync on Windows
- [ ] OCR for image and scanned-PDF text
- [ ] RAR support (needs a non-bundled unrar binary)

---

## Credits

Built by [Parham](https://github.com/Parham125), with development help from Claude (Anthropic's Claude Code).

## License

[MIT](LICENSE).
