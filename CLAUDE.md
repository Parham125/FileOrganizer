# FileOrganizer

Cross-platform desktop app: file index, search, deduplication, and an agentic AI assistant that can act on your disk. Tauri v2 (Rust core + React UI). macOS/Windows/Linux. MIT, public at github.com/Parham125/FileOrganizer.

## Commands

```
pnpm install
pnpm tauri dev              # run the desktop app
pnpm dev                    # browser only, mock bridge, every view usable
pnpm build                  # tsc + vite, must be clean before a release
cargo test --workspace      # 111+ tests, must pass before a release
cargo clippy --workspace --all-targets
pnpm format                 # prettier
```

`cargo` needs `~/.zshenv` sourced. An already-open shell that predates the rust install will fail with "failed to run `cargo metadata`" - open a new terminal.

Use `python3.13`, not `python`, on this machine.

## Layout

```
crates/            UI-independent Rust. Each one is testable on its own.
  indexer/         walkdir + notify watcher + Windows NTFS MFT fast path
  hasher/          BLAKE3 / SHA-256, full and partial (first+last 8 KiB)
  dedup/           staged exact dedup, similar.rs (perceptual), names.rs (title matching)
  search/          SQLite + FTS5. The index, roots, and every query.
  extract/         document text for content search
  trash/           reversible quarantine + undo journal. Trust-critical.
  rules/           saved filter+action cleanups
  chats/           chat history persistence
  archive/         .zip/.rar listing
  thumbs/          thumbnail cache
  ai/              OpenRouter client: SSE streaming, tools, reasoning, caching
src-tauri/src/
  lib.rs           ~50 #[tauri::command]s, app state, settings file, watcher glue
  agent.rs         the agentic tool loop + SYSTEM prompt. 13 tools.
  snapshot.rs      export/import of result sets
src/
  bridge.ts        THE ONLY Tauri seam. Real invoke/listen + a full mock for pnpm dev.
  types.ts         every shape crossing the bridge
  views/           one file per page
  components/      shared UI
```

## Invariants

**Nothing is deleted, ever.** Every destructive path goes through `fo-trash`: files move to a per-volume quarantine (`.FileOrganizer-Trash` at the volume root) and land in the undo journal with their original location. Purge is the only real delete and `is_in_quarantine` guards it - that function rejects any path containing `..`, because a crafted journal row would otherwise walk out of the quarantine and delete a real file. Do not weaken it.

**The indexer skips its own quarantine** (`QUARANTINE_DIR`, `set_excluded_roots`). Without this, trashed files re-pair with their survivors and everything looks like a duplicate. Startup also runs `purge_quarantine_rows`.

**Operations must never return something that looks like an answer when they did nothing.** Three shipped bugs had exactly this shape: a folder move that silently skipped non-regular files, the quarantine re-scan above, and a similar-image cap that returned an empty result instead of saying it compared nothing. Every scan result type therefore carries honesty fields - `cancelled`, `unavailable_roots`, `unreadable_files`, `too_many_images`, `skipped` - and the UI is expected to say which it is. When you add a path that can come up short, add the field too.

**Tauri v2 converts JS camelCase argument keys to Rust snake_case.** `invoke("restore_op", { opId })` reaches `fn restore_op(op_id: String)`. Passing `op_id` from JS fails at runtime, not at compile time. This has bitten this project more than once.

**`bridge.ts` mock must stay in step with the real commands.** Adding a command means adding its mock, or `pnpm dev` and the screenshots break. A stale mock type also hides real breakage: a renamed field once compiled clean while the runtime would have crashed.

**SQLite `substr()` counts characters, not bytes.** Anything doing path arithmetic in SQL must use `chars().count()`. There is a Persian-path test guarding `reparent`.

## AI

OpenRouter, bring-your-own key. Key lives in the system keychain or, by the user's choice, plaintext at 0600 in the app data folder (no Apple Developer Program, so an unsigned build otherwise prompts for the mac password on every launch). `KEY_CACHE` reads it once per launch.

The agent loop is approval-gated: read-only tools run freely, `trash_files`/`move_files`/`create_rule` come back as proposals the user taps to approve. **Every `tool_call` must get a tool response before the next request**, including read calls in a turn that also contains destructive ones, or the API rejects the transcript.

Default model `anthropic/claude-sonnet-5`. Model list in `src/models.ts` is exact OpenRouter IDs, verified against `/models`.

## Design

Paper light / slate-navy dark, IBM Plex Sans + Mono. Teal `#2f6f5e` primary and safe, ochre `#8f5f19` data and attention, brick `#a83c2f` destructive.

No pills or fully-rounded shapes anywhere (4-8px radius), no uppercase eyebrow labels, no em-dashes in UI copy. Destructive actions confirm inline next to the button, never in a modal - see `TrashView.tsx`. Copy is plain and specific: say what happened and what the user can do about it.

## Release

1. Bump the version in three places: `package.json`, `Cargo.toml` (`workspace.package.version`), `src-tauri/tauri.conf.json`.
2. `cargo test --workspace` and `pnpm build` clean.
3. One commit per release, `feat:`/`fix:` + a plain summary + `(vX.Y.Z)`.
4. Tag `vX.Y.Z` and push. `.github/workflows/release.yml` builds Windows, macOS universal, and Ubuntu 22.04 and publishes the release.
5. **Never put the Claude Code session URL in a public commit.** Commits use the user's GitHub noreply email.

Updates are signed with minisign; the private key is at `~/fileorganizer-updater.key` and in the repo's GitHub secrets. macOS bundles are unsigned, so they cannot self-update in place (replacing the .app re-triggers quarantine); the updater sends mac users to the releases page instead.

`ubuntu-22.04` runners are deprecated from 2026-09-17 and removed 2027-04-17.

## Known backlog

- `RulesView.tsx:838` reveals on hover only and swallows its error with `.catch(() => {})`.
- Reasoning text is not persisted in chat history; the "branched" fork tag is session-local.
- ~500 kB JS chunk, no code splitting.
- **The app has never been run against real files by a human.** Tests and mocks caught none of the three bugs above; only real use did. Treat this as the standing risk.
