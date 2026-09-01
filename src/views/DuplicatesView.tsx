import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, listen, pickFolder } from "../bridge";
import { formatSize } from "../format";
import { baseName, shortestPath } from "../paths";
import { useDupMinMb, useScanMode } from "../store";
import { SMALL_PX, isImage, useThumbs } from "../thumbs";
import {
  errorText,
  exportResults,
  isChanged,
  isMissing,
  loadSnapshot,
} from "../snapshot";
import type { DupPayload, LoadedSnapshot } from "../snapshot";
import type {
  DupGroup,
  DupScanResult,
  HashAlgo,
  Progress,
  ScanMode,
  SkippedItem,
  TrashOutcome,
} from "../types";
import { ContentCoverageNote } from "../components/CoverageNote";
import PageHeader from "../components/PageHeader";
import Pager from "../components/Pager";
import SnapshotBanner, {
  ChangedTag,
  ExportButton,
  MissingTag,
  OpenSavedButton,
  SnapshotNote,
} from "../components/SnapshotBanner";
import { ThumbSlot } from "../components/Thumb";
import RevealButton, {
  FileActionError,
  useFileActions,
} from "../components/FileActions";
import ResultFilters, {
  NoFilterMatch,
  useGroupFilter,
} from "../components/ResultFilters";
import ScanModePicker from "../components/ScanModePicker";
import ScanProgress from "../components/ScanProgress";
import Segmented from "../components/Segmented";
import SortPicker, { sorted, useSort } from "../components/SortPicker";
import type { SortOption } from "../components/SortPicker";
import Stack from "../components/Stack";
import StoppedNotice from "../components/StoppedNotice";
import TrashSetButton from "../components/TrashSetButton";
import SimilarImagesView from "./SimilarImagesView";
import SimilarNamesView from "./SimilarNamesView";
import { IconCheck, IconChevron, IconFolder } from "../components/icons";

type DupMode = "exact" | "similar" | "names";

const SUBTITLE: Record<DupMode, string> = {
  exact: "",
  similar:
    "Find photos that look almost the same, like bursts, edits, and re-saves, then keep one and clear the rest. Matches are compared by how the image looks, not by an exact byte match.",
  names:
    "Find files whose names say they belong together, like a copy sitting next to its original or one movie kept at two qualities. Names are all this compares, so you decide what goes.",
};

// Which mode can display each kind of saved file. Opening one switches the
// page to it, so a snapshot always lands in the view that can read it.
const MODE_FOR_KIND: Record<string, DupMode> = {
  duplicates: "exact",
  similar_images: "similar",
  similar_names: "names",
};

export default function DuplicatesView({ algo }: { algo: HashAlgo }) {
  const [mode, setMode] = useState<DupMode>("exact");
  const [scanMode, setScanMode] = useScanMode();
  const [incoming, setIncoming] = useState<LoadedSnapshot | null>(null);
  const [openBusy, setOpenBusy] = useState(false);
  const [openError, setOpenError] = useState("");
  const onAdopted = useCallback(() => setIncoming(null), []);

  async function openSaved() {
    setOpenBusy(true);
    setOpenError("");
    try {
      const loaded = await loadSnapshot();
      if (!loaded) return;
      const next = MODE_FOR_KIND[loaded.snap.kind];
      if (!next) {
        setOpenError(
          "That file holds search results. Open it from the Search page.",
        );
        return;
      }
      setMode(next);
      setIncoming(loaded);
    } catch (e) {
      setOpenError(errorText(e));
    } finally {
      setOpenBusy(false);
    }
  }

  const shared = { incoming, onAdopted, onOpenSaved: openSaved, openBusy };
  return (
    <div className="space-y-6">
      <PageHeader
        title="Duplicates"
        subtitle={
          mode === "exact"
            ? `Find identical files by content hash, then clear the extra copies. Hashing with ${algo === "blake3" ? "BLAKE3" : "SHA-256"}, set in Settings.`
            : SUBTITLE[mode]
        }
        actions={
          <Segmented<DupMode>
            ariaLabel="Duplicate mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: "exact", label: "Exact duplicates" },
              { value: "similar", label: "Similar images" },
              { value: "names", label: "Similar names" },
            ]}
          />
        }
      />
      {openError && (
        <div className="rounded-md border border-brick/40 bg-brick-soft px-3.5 py-2.5 text-sm text-brick">
          {openError}
        </div>
      )}
      {mode === "exact" && (
        <ExactDuplicates
          algo={algo}
          scanMode={scanMode}
          onScanMode={setScanMode}
          {...shared}
        />
      )}
      {mode === "similar" && (
        <SimilarImagesView
          scanMode={scanMode}
          onScanMode={setScanMode}
          {...shared}
        />
      )}
      {mode === "names" && (
        <SimilarNamesView
          algo={algo}
          scanMode={scanMode}
          onScanMode={setScanMode}
          onExact={() => setMode("exact")}
          {...shared}
        />
      )}
    </div>
  );
}

// A drive can produce thousands of sets. Rendering them all stalls the view, so
// the list is paged while the selection stays whole underneath it.
const PER_PAGE = 25;

// The word for one file in a set, in one place: the set button asks about
// copies and the message it leaves behind has to say the same word.
const SET_NOUN = { one: "copy", many: "copies" };

// Where a partial trash gets reported. from is the hash of the set whose own
// button was pressed, or null for the footer, so the note lands where the press
// happened rather than at the top of a page the reader has scrolled past.
type Skipped = { from: string | null; items: SkippedItem[] };

// What trash_files refused to move, in the words the backend already wrote.
// Reasons are shown verbatim: they name the drive, the free space, or the OS
// error, and any summary of that is a worse answer than the answer.
function SkippedNote({ items }: { items: SkippedItem[] }) {
  return (
    <div className="rounded-md border border-ochre/40 bg-ochre-soft px-3.5 py-2.5 text-left text-sm text-ochre">
      <p className="font-medium">
        {items.length} {items.length === 1 ? "file is" : "files are"} still on
        disk and {items.length === 1 ? "was" : "were"} not moved
      </p>
      {/* Every path is listed, but a whole disconnected drive can be a hundred
          of them and this note sits in a fixed footer, so the list scrolls
          instead of pushing the buttons off the screen. */}
      <ul className="mt-1.5 max-h-40 space-y-1.5 overflow-y-auto">
        {items.map((s) => (
          <li key={s.path}>
            <span className="block truncate font-mono text-xs" title={s.path}>
              {s.path}
            </span>
            <span className="block text-xs">{s.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Selected == the copies to remove. Default keeps the shortest path still on
// disk and preselects every other copy for the trash. A file a snapshot says is
// gone is never preselected: it is not a copy anyone can reclaim space from.
function defaultRemoval(
  g: DupGroup,
  gone: (path: string) => boolean,
): Set<string> {
  const live = g.paths.filter((p) => !gone(p));
  const keep = shortestPath(live.length > 0 ? live : g.paths);
  return new Set(live.filter((p) => p !== keep));
}

type Coverage = { roots: string[]; unreadable: number };

// What the scan reads: the whole index across every drive, or one picked folder.
type DupScope = "indexed" | "folder";

// Defined once so the filter hook can memoize on them. Every copy in a set
// weighs the same, so the size filter takes a whole set or leaves it whole.
function pathsOf(g: DupGroup): string[] {
  return g.paths;
}

function sizesOf(g: DupGroup): number[] {
  return g.paths.map(() => g.size);
}

function keepOnly(g: DupGroup, paths: Set<string>): DupGroup {
  return { ...g, paths: g.paths.filter((p) => paths.has(p)) };
}

type DupSort = "wasted" | "size" | "copies" | "name";

// Wasted space first, which is the order this list has always shipped in and
// the reason most people open it.
const DUP_SORTS: SortOption<DupSort>[] = [
  { value: "wasted", label: "Wasted space", naturalDir: "desc" },
  { value: "size", label: "File size", naturalDir: "desc" },
  { value: "copies", label: "Number of copies", naturalDir: "desc" },
  { value: "name", label: "Name", naturalDir: "asc" },
];

// Anything outside /Volumes sits on the drive the system booted from. Used only
// to tell the reader when one set straddles two disks.
// Which disk a path sits on: a macOS mount under /Volumes, a Windows drive
// letter, or the system disk. The app ships on both, so this cannot assume one.
function driveOf(path: string): string {
  const win = /^([a-zA-Z]:)[\\/]/.exec(path);
  if (win) return win[1].toUpperCase();
  if (path.startsWith("\\\\")) {
    const parts = path.slice(2).split("\\");
    return parts[0] ? `\\\\${parts[0]}` : "\\\\";
  }
  if (path.startsWith("/Volumes/")) {
    const at = path.indexOf("/", 9);
    return path.slice(0, at < 0 ? path.length : at);
  }
  return "/";
}

function ExactDuplicates({
  algo,
  scanMode,
  onScanMode,
  incoming,
  onAdopted,
  onOpenSaved,
  openBusy,
}: {
  algo: HashAlgo;
  scanMode: ScanMode;
  onScanMode: (m: ScanMode) => void;
  incoming: LoadedSnapshot | null;
  onAdopted: () => void;
  onOpenSaved: () => void;
  openBusy: boolean;
}) {
  const [scope, setScope] = useState<DupScope>("indexed");
  // null until the index answers, so the picker never flashes an empty state
  // over a list that is about to arrive.
  const [roots, setRoots] = useState<string[] | null>(null);
  const [showRoots, setShowRoots] = useState(false);
  const [minMb, setMinMb] = useDupMinMb();
  // What the results on screen actually came from. The toggle can move after a
  // scan, and the labelling has to follow the run, not the control.
  const [scanned, setScanned] = useState<DupScope | null>(null);
  const chosen = useRef(false);
  const [root, setRoot] = useState<string | null>(null);
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  // What the scan actually confirmed, which is what the reader is told. It can
  // run ahead of groups.length when the backend caps what it hands over.
  const [groupCount, setGroupCount] = useState(0);
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<Record<string, Set<string>>>({});
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Which set is asking to be trashed whole. One at a time, so a second press
  // moves the question rather than leaving two open.
  const [confirmSet, setConfirmSet] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [skipped, setSkipped] = useState<Skipped | null>(null);
  const [stopped, setStopped] = useState(false);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [snapshot, setSnapshot] = useState<LoadedSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const filter = useGroupFilter(groups, pathsOf, sizesOf, keepOnly);
  const sort = useSort<DupSort>("duplicates", DUP_SORTS, "wasted");
  const files = useFileActions();
  const gone = (path: string) =>
    snapshot != null && isMissing(snapshot.checked, path);

  // Turning the page puts the reader at the top of the new one, not halfway
  // down where the last one ended.
  function goPage(next: number) {
    setPage(next);
    listRef.current?.scrollIntoView({ block: "start" });
  }

  // Filtering is a view over the same results, so the reader lands back on the
  // first page of what is left rather than on an empty page 7. Reordering
  // changes what every page holds, so it goes back to the first one too.
  useEffect(() => {
    setPage(0);
  }, [filter.query, filter.ext, filter.minMb, sort.key, sort.dir]);

  useEffect(() => {
    const un = listen<Progress>("dedup:progress", (p) => setProgress(p));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Which folders an indexed scan will cover. Falling back to one folder keeps
  // the view usable on a fresh install where nothing is indexed yet.
  useEffect(() => {
    invoke<string[]>("list_indexed_roots")
      .then((r) => {
        setRoots(r);
        if (!chosen.current && r.length === 0) setScope("folder");
      })
      .catch(() => setRoots([]));
  }, []);

  // A snapshot the page handed down. Adopting it replaces whatever is on screen
  // and rebuilds the selection, because those picks were made against a scan
  // that was live at the time.
  useEffect(() => {
    if (!incoming || incoming.snap.kind !== "duplicates") return;
    const payload = incoming.snap.payload as DupPayload;
    const next = payload.groups ?? [];
    setSnapshot(incoming);
    setGroups(next);
    setGroupCount(payload.group_count ?? next.length);
    setCoverage({
      roots: payload.unavailable_roots ?? [],
      unreadable: payload.unreadable_files ?? 0,
    });
    setStopped(payload.cancelled ?? false);
    setScanned(null);
    setPage(0);
    setError("");
    setDone("");
    setSkipped(null);
    setSaved("");
    const sel: Record<string, Set<string>> = {};
    for (const g of next)
      sel[g.hash] = defaultRemoval(g, (p) => isMissing(incoming.checked, p));
    setSelection(sel);
    onAdopted();
  }, [incoming, onAdopted]);

  function chooseScope(next: DupScope) {
    chosen.current = true;
    setScope(next);
    setError("");
  }

  async function chooseFolder() {
    const dir = await pickFolder();
    if (dir) setRoot(dir);
  }

  async function scan() {
    if (scope === "folder" && !root) {
      setError("Pick a folder to scan first.");
      return;
    }
    setError("");
    setDone("");
    setSkipped(null);
    setSaved("");
    setSaveError("");
    setStopped(false);
    setScanning(true);
    setProgress({ done: 0, total: 0 });
    setGroups(null);
    setSnapshot(null);
    setCoverage(null);
    setPage(0);
    try {
      const res =
        scope === "indexed"
          ? await invoke<DupScanResult>("scan_duplicates_indexed", {
              algo,
              mode: scanMode,
              minSize: minMb > 0 ? minMb * 1024 * 1024 : 1,
            })
          : await invoke<DupScanResult>("scan_duplicates", {
              root,
              algo,
              mode: scanMode,
            });
      setScanned(scope);
      setGroups(res.groups);
      setGroupCount(res.group_count);
      setCoverage({
        roots: res.unavailable_roots ?? [],
        unreadable: res.unreadable_files ?? 0,
      });
      setStopped(res.cancelled);
      const sel: Record<string, Set<string>> = {};
      for (const g of res.groups) sel[g.hash] = defaultRemoval(g, () => false);
      setSelection(sel);
    } catch (e) {
      setError(`Scan failed: ${errorText(e)}`);
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }

  async function save() {
    if (!groups) return;
    setSaving(true);
    setSaveError("");
    setSaved("");
    try {
      const path = await exportResults(
        "duplicates",
        scanned === "folder" ? root : null,
        algo === "blake3" ? "BLAKE3" : "SHA-256",
        {
          group_count: groupCount,
          groups,
          cancelled: stopped,
          unavailable_roots: coverage?.roots ?? [],
          unreadable_files: coverage?.unreadable ?? 0,
        } satisfies DupPayload,
      );
      if (path)
        setSaved(
          `Saved ${groups.length.toLocaleString()} sets to ${path}. Open it again from any duplicate mode.`,
        );
    } catch (e) {
      setSaveError(`Nothing was saved: ${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  }

  function toggle(hash: string, path: string) {
    if (gone(path)) return;
    setSelection((prev) => {
      const next = new Set(prev[hash] ?? []);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { ...prev, [hash]: next };
    });
    setConfirming(false);
    setDone("");
  }

  // Every page at once, filtered or not: the selection spans the whole result,
  // so the running totals have to as well, or paging or filtering away would
  // look like losing the picks. hidden is what the filter is covering up.
  const summary = useMemo(() => {
    let count = 0;
    let bytes = 0;
    let invalid = 0;
    let sets = 0;
    let hidden = 0;
    for (const g of groups ?? []) {
      const sel = selection[g.hash];
      const rm = sel?.size ?? 0;
      const live = g.paths.filter((p) => !gone(p)).length;
      if (rm > 0 && rm >= live) invalid++;
      if (rm > 0) sets++;
      count += rm;
      bytes += rm * g.size;
      for (const p of sel ?? []) if (!filter.shows(p)) hidden++;
    }
    return { count, bytes, invalid, sets, hidden };
  }, [groups, selection, filter.shows, snapshot]);

  const wasted = useMemo(
    () => (groups ?? []).reduce((s, g) => s + g.size * (g.paths.length - 1), 0),
    [groups],
  );

  // Ordering runs over the filtered sets and before the page is cut out of
  // them, or turning to page 2 would show whatever the old order left there.
  // Sorting by name uses the shortest path, the copy the defaults keep.
  const ordered = useMemo(() => {
    if (!filter.filtered) return null;
    return sorted(
      filter.filtered,
      (g) =>
        sort.key === "wasted"
          ? g.size * (g.paths.length - 1)
          : sort.key === "size"
            ? g.size
            : sort.key === "copies"
              ? g.paths.length
              : baseName(shortestPath(g.paths)),
      sort.dir,
    );
  }, [filter.filtered, sort.key, sort.dir]);

  const nothingIndexed = roots !== null && roots.length === 0;
  const loaded = groups?.length ?? 0;
  const listed = ordered?.length ?? 0;
  const pages = Math.max(1, Math.ceil(listed / PER_PAGE));
  const from = page * PER_PAGE;
  const shown = ordered ? ordered.slice(from, from + PER_PAGE) : [];
  // Only the sets on this page. Nothing off screen is ever requested, and what
  // has already arrived is served from the module cache when paging back.
  const thumb = useThumbs(
    shown.flatMap((g) => g.paths),
    SMALL_PX,
  );
  // The skipped note belongs next to the button that was pressed, but a set can
  // fall out of the list and the footer only exists while something is ticked.
  // When its own spot is gone the note moves up to the page rather than with it.
  const skippedInline =
    skipped != null &&
    (skipped.from === null
      ? summary.count > 0
      : shown.some((g) => g.hash === skipped.from));

  // Shared by the footer and by the per-set button. Both trash a list of paths
  // and then rebuild the results in place, never by re-scanning: a set left
  // holding one file is no longer a duplicate set, so it drops out entirely.
  // Only what the backend says it moved leaves the screen. A skipped file is
  // still sitting on disk, so it stays listed, stays ticked, and says why, and
  // the message is written from moved rather than from what was asked for.
  // Throws on failure so the caller can report it where it was pressed.
  async function removePaths(
    paths: string[],
    from: string | null,
    message: (moved: string[]) => string,
  ) {
    const res = await invoke<TrashOutcome>("trash_files", {
      paths,
      reason: "dedup",
    });
    const removed = new Set(res.moved);
    const remaining = (groups ?? [])
      .map((g) => ({ ...g, paths: g.paths.filter((p) => !removed.has(p)) }))
      .filter((g) => g.paths.length > 1);
    setGroups(remaining);
    setGroupCount(remaining.length);
    setPage((p) =>
      Math.min(p, Math.max(0, Math.ceil(remaining.length / PER_PAGE) - 1)),
    );
    // Every set the user did not act on keeps exactly the boxes they left,
    // including the ones they cleared on purpose. Rebuilding the defaults here
    // would re-tick copies they had decided to keep.
    const sel: Record<string, Set<string>> = {};
    for (const g of remaining) {
      const had = selection[g.hash];
      sel[g.hash] = had
        ? new Set([...had].filter((p) => !removed.has(p)))
        : defaultRemoval(g, gone);
    }
    setSelection(sel);
    setConfirming(false);
    setConfirmSet(null);
    setError("");
    setSkipped(res.skipped.length > 0 ? { from, items: res.skipped } : null);
    setDone(res.moved.length > 0 ? message(res.moved) : "");
  }

  async function trashSelected() {
    const paths: string[] = [];
    const bytesOf = new Map<string, number>();
    for (const g of groups ?? [])
      for (const p of selection[g.hash] ?? []) {
        paths.push(p);
        bytesOf.set(p, g.size);
      }
    if (paths.length === 0) return;
    try {
      await removePaths(paths, null, (moved) => {
        const bytes = moved.reduce((s, p) => s + (bytesOf.get(p) ?? 0), 0);
        return `Moved ${moved.length} ${moved.length === 1 ? "file" : "files"} to Trash and reclaimed ${formatSize(bytes)}. Restore anytime from Trash.`;
      });
    } catch (e) {
      setError(`Could not move files: ${errorText(e)}`);
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-6 pb-28">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <Segmented<DupScope>
          ariaLabel="What the scan covers"
          value={scope}
          onChange={chooseScope}
          options={[
            { value: "indexed", label: "Everything indexed" },
            { value: "folder", label: "One folder" },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2">
          {groups && groups.length > 0 && !snapshot && (
            <ExportButton onExport={save} busy={saving} kind="duplicates" />
          )}
          <OpenSavedButton onOpen={onOpenSaved} busy={openBusy} />
          {scope === "folder" && (
            <button
              type="button"
              onClick={chooseFolder}
              className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
            >
              <IconFolder className="h-4 w-4" />
              {root ? "Change folder" : "Pick folder"}
            </button>
          )}
          <button
            type="button"
            onClick={scan}
            disabled={
              scanning ||
              (scope === "indexed" ? roots === null || nothingIndexed : !root)
            }
            className="inline-flex items-center gap-2 rounded-md bg-teal px-3.5 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            {scanning && (
              <span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white fo-spin" />
            )}
            {scanning ? "Scanning" : "Scan"}
          </button>
        </div>
      </div>

      <SnapshotNote error={saveError} done={saved} />

      {snapshot && groups && (
        <SnapshotBanner
          loaded={snapshot}
          summary={`${groupCount.toLocaleString()} ${groupCount === 1 ? "set" : "sets"}`}
          onClose={() => {
            setSnapshot(null);
            setGroups(null);
            setSelection({});
            setCoverage(null);
            setStopped(false);
          }}
        />
      )}

      {scope === "folder" && root && !snapshot && (
        <p className="truncate font-mono text-xs text-ink-soft">
          <span className="text-ink-faint">Target </span>
          {root}
        </p>
      )}

      {scope === "indexed" && roots === null && (
        <p className="text-sm text-ink-faint">
          Checking which folders are indexed
        </p>
      )}

      {scope === "indexed" && roots !== null && roots.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowRoots(!showRoots)}
            aria-expanded={showRoots}
            className="-ml-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          >
            <IconChevron
              className={
                "h-3.5 w-3.5 transition-transform " +
                (showRoots ? "rotate-90" : "")
              }
            />
            Covers {roots.length} indexed{" "}
            {roots.length === 1 ? "folder" : "folders"}
          </button>
          {showRoots && (
            <ul className="mt-1 space-y-1.5 rounded-lg border border-line bg-surface px-4 py-3">
              {roots.map((p) => (
                <li
                  key={p}
                  className="truncate font-mono text-xs text-ink-soft"
                  title={p}
                >
                  {p}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {scope === "indexed" && nothingIndexed && (
        <div className="rounded-lg border border-line bg-surface px-6 py-10 text-center">
          <p className="text-sm font-medium text-ink">No folders indexed yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-ink-soft">
            Add the folders and drives you want covered in Search, then scan
            them all here in one pass. To hash a single folder right now, switch
            to One folder.
          </p>
        </div>
      )}

      {/* Nothing to tune while there is nothing to scan. */}
      {!(scope === "indexed" && nothingIndexed) && (
        <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
          <ScanModePicker
            value={scanMode}
            onChange={onScanMode}
            disabled={scanning}
          />
          {scope === "indexed" && (
            <div
              className={
                "space-y-1.5" +
                (scanning ? " pointer-events-none opacity-60" : "")
              }
            >
              {/* Named against the size filter under the results: this one
                  decides what gets hashed, that one decides what is listed. */}
              <p className="text-xs font-medium text-ink">Skip files under</p>
              <Segmented<string>
                ariaLabel="Skip files under this size"
                value={String(minMb)}
                onChange={(v) => setMinMb(Number(v))}
                options={[
                  { value: "0", label: "Nothing" },
                  { value: "1", label: "1 MB" },
                  { value: "10", label: "10 MB" },
                  { value: "100", label: "100 MB" },
                ]}
              />
              <p className="max-w-xs text-xs leading-relaxed text-ink-soft">
                {minMb === 0
                  ? "Hashes every file. Tiny files repeat on every drive, so expect a long list of sets that free almost nothing."
                  : `Never hashes a file under ${minMb} MB, which is most of the work. To hide small files from results you already have, use the size filter above the list.`}
              </p>
            </div>
          )}
        </div>
      )}

      {progress && <ScanProgress progress={progress} label="Hashing files" />}

      {stopped && (
        <StoppedNotice>
          {groups && groups.length > 0
            ? `You stopped this scan. These are only the sets it had confirmed by then, so there may be more duplicates ${scanned === "indexed" ? "across your indexed folders" : "in that folder"}.`
            : `You stopped this scan before it confirmed any duplicates. Scan again to look through ${scanned === "indexed" ? "every indexed folder" : "the whole folder"}.`}
        </StoppedNotice>
      )}

      {coverage && !snapshot && (
        <ContentCoverageNote
          roots={coverage.roots}
          unreadable={coverage.unreadable}
          noun="duplicate set"
        />
      )}

      {error && (
        <div className="rounded-md border border-brick/40 bg-brick-soft px-3.5 py-2.5 text-sm text-brick">
          {error}
        </div>
      )}
      {done && (
        <div className="flex items-start gap-2 rounded-md border border-teal-line bg-teal-soft px-3.5 py-2.5 text-sm text-teal">
          <IconCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{done}</span>
        </div>
      )}
      {skipped && !skippedInline && <SkippedNote items={skipped.items} />}

      {groups && groups.length === 0 && !done && !stopped && (
        <div className="rounded-lg border border-line bg-surface px-6 py-16 text-center">
          <p className="text-sm font-medium text-ink">No duplicates found</p>
          <p className="mt-1 text-sm text-ink-soft">
            {scanned === "indexed"
              ? minMb > 0
                ? `Every indexed file over ${minMb} MB is already unique. Lower the size floor to compare smaller files too.`
                : "Every file across your indexed folders is already unique."
              : "Every file in that folder is already unique."}
          </p>
        </div>
      )}

      {groups && groups.length > 0 && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <span className="text-ink-soft">
              <span className="font-semibold text-ink">
                {groupCount.toLocaleString()}
              </span>{" "}
              duplicate {groupCount === 1 ? "set" : "sets"}
            </span>
            <span className="text-ink-soft">
              <span className="font-mono font-semibold text-ochre">
                {formatSize(wasted)}
              </span>{" "}
              can be reclaimed
            </span>
            {stopped && (
              <span className="rounded-[3px] border border-ochre/40 bg-ochre-soft px-1.5 py-0.5 text-xs font-medium text-ochre">
                Partial list
              </span>
            )}
            {groupCount > loaded && (
              <span className="text-xs text-ink-faint">
                The first {loaded.toLocaleString()} are listed below
              </span>
            )}
          </div>

          {scanned === "indexed" && (
            <p className="max-w-2xl text-xs leading-relaxed text-ink-faint">
              Removed copies go to the Trash on the drive they live on, so a
              copy on an external drive stays on that drive. Restore any of them
              from the Trash view.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1 basis-80">
              <ResultFilters filter={filter} unit="sets" />
            </div>
            <SortPicker sort={sort} />
          </div>

          {listed === 0 && <NoFilterMatch filter={filter} unit="sets" />}

          {pages > 1 && listed > 0 && (
            <Pager
              page={page}
              pages={pages}
              from={from + 1}
              to={from + shown.length}
              total={listed}
              unit="Sets"
              onPage={goPage}
            />
          )}

          <div ref={listRef} className="space-y-4">
            {shown.map((g) => {
              const sel = selection[g.hash] ?? new Set<string>();
              // A path a snapshot says is gone cannot be trashed, so the whole
              // set button offers only what is still on disk.
              const live = g.paths.filter((p) => !gone(p));
              const missing = g.paths.length - live.length;
              const keeping = g.paths.length - sel.size - missing;
              // A changed copy is still a real file the user may want gone, so
              // it stays on offer. It is no longer the file that was hashed
              // though, and the confirm cannot claim these are identical.
              const changed = snapshot
                ? live.filter((p) => isChanged(snapshot.checked, p)).length
                : 0;
              const drives = new Set(g.paths.map(driveOf)).size;
              // Every copy in a set is the same file, so one image copy means
              // the whole set gets the preview column and the rows stay lined
              // up whether or not a given preview ever arrives.
              const previews = g.paths.some(isImage);
              return (
                <div
                  key={g.hash}
                  className="rounded-lg border border-line bg-surface"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Stack n={g.paths.length} />
                      <div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-ink">
                          <span>
                            {g.paths.length} identical copies,{" "}
                            {formatSize(g.size)} each
                          </span>
                          {drives > 1 && (
                            <span className="rounded-[3px] border border-ochre/40 bg-ochre-soft px-1.5 py-0.5 text-xs font-medium text-ochre">
                              across {drives} drives
                            </span>
                          )}
                          {missing > 0 && (
                            <span className="rounded-[3px] border border-ochre/40 bg-ochre-soft px-1.5 py-0.5 text-xs font-medium text-ochre">
                              {missing} missing
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-xs text-ink-faint">
                          {g.hash}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
                      <div className="text-right text-xs">
                        <div className="text-ink-soft">
                          Keep{" "}
                          <span className="font-semibold text-ink">
                            {keeping}
                          </span>
                          , remove{" "}
                          <span className="font-semibold text-brick">
                            {sel.size}
                          </span>
                        </div>
                        <div className="font-mono text-ochre">
                          frees {formatSize(g.size * (g.paths.length - 1))}
                        </div>
                      </div>
                      {live.length > 0 && (
                        <TrashSetButton
                          paths={live}
                          noun={SET_NOUN.one}
                          nounPlural={SET_NOUN.many}
                          note={
                            changed > 0
                              ? `${changed} of ${changed === 1 ? "them has" : "them have"} changed on disk since this list was saved, so ${changed === 1 ? "it is" : "they are"} no longer the file the scan compared.`
                              : undefined
                          }
                          open={confirmSet === g.hash}
                          onOpen={(open) => setConfirmSet(open ? g.hash : null)}
                          onTrash={(paths) =>
                            removePaths(
                              paths,
                              g.hash,
                              (moved) =>
                                `Moved ${moved.length} ${moved.length === 1 ? SET_NOUN.one : SET_NOUN.many} to Trash and reclaimed ${formatSize(g.size * moved.length)}. Restore anytime from Trash.`,
                            )
                          }
                        />
                      )}
                    </div>
                    {skipped && skipped.from === g.hash && (
                      <div className="basis-full">
                        <SkippedNote items={skipped.items} />
                      </div>
                    )}
                  </div>
                  <ul>
                    {g.paths.map((p) => {
                      const remove = sel.has(p);
                      const lost = gone(p);
                      const cut = Math.max(
                        p.lastIndexOf("/"),
                        p.lastIndexOf("\\"),
                      );
                      const name = p.slice(cut + 1);
                      const dir = p.slice(0, cut);
                      return (
                        <li key={p}>
                          <div
                            onDoubleClick={() => files.open(p)}
                            className={
                              "flex items-center gap-2 border-b border-line/60 px-4 py-2.5 last:border-b-0 " +
                              (lost
                                ? "bg-surface-2/40"
                                : "hover:bg-surface-2/50")
                            }
                          >
                            <label
                              className={
                                "flex min-w-0 flex-1 items-center gap-3 " +
                                (lost ? "cursor-default" : "cursor-pointer")
                              }
                            >
                              <span
                                className={
                                  "grid h-4 w-4 shrink-0 place-items-center rounded-[3px] border transition-colors " +
                                  (lost
                                    ? "border-line bg-surface-2"
                                    : remove
                                      ? "border-brick bg-brick text-white"
                                      : "border-line-strong bg-surface")
                                }
                              >
                                <input
                                  type="checkbox"
                                  checked={remove}
                                  disabled={lost}
                                  onChange={() => toggle(g.hash, p)}
                                  aria-label={
                                    lost
                                      ? `${name} is missing`
                                      : `Remove ${name}`
                                  }
                                  className="sr-only"
                                />
                                {remove && !lost && (
                                  <IconCheck className="h-3 w-3" />
                                )}
                              </span>
                              {previews && (
                                <ThumbSlot
                                  path={p}
                                  src={thumb(p)}
                                  size="h-10 w-10"
                                  dim={lost}
                                />
                              )}
                              <span className="min-w-0 flex-1">
                                <span
                                  className={
                                    "block truncate text-sm " +
                                    (lost
                                      ? "text-ink-faint line-through"
                                      : "text-ink")
                                  }
                                >
                                  {name}
                                </span>
                                <span className="block truncate font-mono text-xs text-ink-faint">
                                  {dir}
                                </span>
                              </span>
                            </label>
                            {lost ? (
                              <MissingTag />
                            ) : snapshot && isChanged(snapshot.checked, p) ? (
                              <ChangedTag />
                            ) : (
                              <span
                                className={
                                  "shrink-0 text-xs " +
                                  (remove ? "text-brick" : "text-teal")
                                }
                              >
                                {remove ? "Remove" : "Keep"}
                              </span>
                            )}
                            <RevealButton
                              name={name}
                              onReveal={() => files.reveal(p)}
                            />
                          </div>
                          {files.failed?.path === p && (
                            <FileActionError message={files.failed.message} />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>

          {pages > 1 && listed > 0 && (
            <Pager
              page={page}
              pages={pages}
              from={from + 1}
              to={from + shown.length}
              total={listed}
              unit="Sets"
              onPage={goPage}
            />
          )}
        </>
      )}

      {summary.count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface px-4 py-3 md:left-56">
          {skipped && skipped.from === null && (
            <div className="mx-auto mb-3 max-w-3xl">
              <SkippedNote items={skipped.items} />
            </div>
          )}
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
            {confirming ? (
              <>
                <span className="text-sm text-ink">
                  Move {summary.count} {summary.count === 1 ? "file" : "files"}{" "}
                  to Trash and reclaim{" "}
                  <span className="font-mono text-ochre">
                    {formatSize(summary.bytes)}
                  </span>
                  ? You can restore them later.
                  {/* Ticking every box in a set is allowed, but it is the one
                      case that leaves no copy behind, so it is said out loud
                      before the files move. */}
                  {summary.invalid > 0 && (
                    <>
                      {" "}
                      <span className="text-ochre">
                        {summary.invalid}{" "}
                        {summary.invalid === 1 ? "set" : "sets"} would be
                        emptied completely, keeping no copy on disk.
                      </span>
                    </>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={trashSelected}
                    className="rounded-md bg-brick px-3.5 py-2 text-sm font-medium text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                  >
                    Move to Trash
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="text-sm text-ink-soft">
                  <span className="font-semibold text-ink">
                    {summary.count.toLocaleString()}
                  </span>{" "}
                  selected to remove
                  {pages > 1 && (
                    <>
                      {" across "}
                      <span className="font-semibold text-ink">
                        {summary.sets.toLocaleString()}
                      </span>
                      {summary.sets === 1 ? " set" : " sets"}
                    </>
                  )}
                  ,{" "}
                  <span className="font-mono text-ochre">
                    {formatSize(summary.bytes)}
                  </span>{" "}
                  reclaimed
                  {summary.hidden > 0 && (
                    <>
                      {" · "}
                      <span className="font-semibold text-ink">
                        {summary.hidden.toLocaleString()}
                      </span>{" "}
                      hidden by the filter
                      <button
                        type="button"
                        onClick={filter.clear}
                        className="ml-1.5 rounded-[3px] underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                      >
                        Show all
                      </button>
                    </>
                  )}
                  {summary.invalid > 0 && (
                    <span className="text-ochre">
                      {" "}
                      · {summary.invalid} set{summary.invalid === 1 ? "" : "s"}{" "}
                      would keep no copy
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="rounded-md bg-teal px-3.5 py-2 text-sm font-medium text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                >
                  Move selected to Trash
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
