import { invoke, pickOpenFile, pickSaveFile } from "./bridge";
import type {
  DupScanResult,
  NameScanResult,
  NameStrategy,
  PathStatus,
  ResultSnapshot,
  SearchHit,
  SimilarScanResult,
  SnapshotKind,
} from "./types";

// Parking a result set on a file and reading it back. A duplicate scan over an
// external drive can run for hours, and that is exactly the list people want to
// reopen the next day rather than run again.

// What each kind carries. The payload is the scan envelope itself, so a saved
// list keeps everything the live one showed, coverage gaps included.
export type DupPayload = DupScanResult;
export type SimilarPayload = SimilarScanResult;
export type NamePayload = NameScanResult & { strategy: NameStrategy };
export type SearchPayload = {
  query: string;
  ext: string;
  min_size: number | null;
  hits: SearchHit[];
};

export const KIND_LABEL: Record<SnapshotKind, string> = {
  duplicates: "Exact duplicates",
  similar_images: "Similar images",
  similar_names: "Similar names",
  search: "Search results",
};

const KIND_SLUG: Record<SnapshotKind, string> = {
  duplicates: "duplicates",
  similar_images: "similar-images",
  similar_names: "similar-names",
  search: "search",
};

// A snapshot that has been read back and checked against the disk.
export type LoadedSnapshot = {
  snap: ResultSnapshot;
  checked: Verification;
};

export type Verification = {
  // Only the paths the runtime answered for. A path missing from this map was
  // never checked, and its row is left alone rather than guessed at.
  status: Map<string, PathStatus>;
  missing: number;
  changed: number;
  checked: number;
  total: number;
};

export function defaultFilename(kind: SnapshotKind): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `fileorganizer-${KIND_SLUG[kind]}-${day}.json`;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Returns the file it wrote, or null when the save dialog was dismissed.
export async function exportResults(
  kind: SnapshotKind,
  scope: string | null,
  note: string | null,
  payload: unknown,
): Promise<string | null> {
  const path = await pickSaveFile(defaultFilename(kind));
  if (!path) return null;
  await invoke("export_results", { path, kind, scope, note, payload });
  return path;
}

export async function importResults(): Promise<ResultSnapshot | null> {
  const path = await pickOpenFile();
  if (!path) return null;
  return invoke<ResultSnapshot>("import_results", { path });
}

// The runtime refuses more than 50,000 at once, so this walks the list in
// chunks and stops at that ceiling rather than failing the whole import.
const VERIFY_CHUNK = 10_000;
const VERIFY_MAX = 50_000;

export async function verifyPaths(
  entries: { path: string; expected_size: number }[],
): Promise<Verification> {
  const status = new Map<string, PathStatus>();
  const take = entries.slice(0, VERIFY_MAX);
  for (let i = 0; i < take.length; i += VERIFY_CHUNK) {
    const chunk = take.slice(i, i + VERIFY_CHUNK);
    const out = await invoke<PathStatus[]>("verify_snapshot_paths", {
      paths: chunk,
    });
    for (const s of out) status.set(s.path, s);
  }
  let missing = 0;
  let changed = 0;
  for (const s of status.values()) {
    if (!s.exists) missing++;
    else if (s.size_changed) changed++;
  }
  return {
    status,
    missing,
    changed,
    checked: status.size,
    total: entries.length,
  };
}

// Every path a payload holds, with the size it had when the snapshot was
// written, so the check can report a file that was replaced as well as one that
// is gone. Kept here so each view hands over its payload and nothing else.
export function pathsIn(
  snap: ResultSnapshot,
): { path: string; expected_size: number }[] {
  const out: { path: string; expected_size: number }[] = [];
  if (snap.kind === "duplicates") {
    for (const g of (snap.payload as DupPayload).groups ?? [])
      for (const p of g.paths) out.push({ path: p, expected_size: g.size });
  } else if (snap.kind === "similar_images") {
    for (const g of (snap.payload as SimilarPayload).groups ?? [])
      for (const f of g.files)
        out.push({ path: f.path, expected_size: f.size });
  } else if (snap.kind === "similar_names") {
    for (const g of (snap.payload as NamePayload).groups ?? [])
      for (const f of g.files)
        out.push({ path: f.path, expected_size: f.size });
  } else if (snap.kind === "search") {
    for (const h of (snap.payload as SearchPayload).hits ?? [])
      out.push({ path: h.path, expected_size: h.size });
  }
  return out;
}

// Read a snapshot back and check it against the disk in one step, so no view
// can show a saved list without also knowing what has moved under it.
export async function loadSnapshot(): Promise<LoadedSnapshot | null> {
  const snap = await importResults();
  if (!snap) return null;
  return { snap, checked: await verifyPaths(pathsIn(snap)) };
}

// True when the row points at a file that is no longer there. Anything the
// check did not cover counts as present, because guessing the other way would
// grey out rows nobody verified.
export function isMissing(checked: Verification, path: string): boolean {
  const s = checked.status.get(path);
  return s != null && !s.exists;
}

export function isChanged(checked: Verification, path: string): boolean {
  const s = checked.status.get(path);
  return s != null && s.exists && s.size_changed === true;
}
