import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, listen, pickFolder } from "../bridge";
import { formatDate, formatSize } from "../format";
import { SMALL_PX, isImage, useThumbs } from "../thumbs";
import { errorText, exportResults, isChanged, isMissing } from "../snapshot";
import type { LoadedSnapshot, NamePayload, Verification } from "../snapshot";
import type {
  ExactCheck,
  HashAlgo,
  NameGroup,
  NameScanResult,
  NameStrategy,
  Progress,
  ScanMode,
  SkippedItem,
  TrashOutcome,
} from "../types";
import { NameCoverageNote } from "../components/CoverageNote";
import Pager from "../components/Pager";
import SnapshotBanner, {
  ChangedTag,
  ExportButton,
  MissingTag,
  OpenSavedButton,
  SnapshotNote,
} from "../components/SnapshotBanner";
import { ThumbSlot } from "../components/Thumb";
import ResultFilters, {
  NoFilterMatch,
  useGroupFilter,
} from "../components/ResultFilters";
import RevealButton, {
  FileActionError,
  useFileActions,
} from "../components/FileActions";
import ScanModePicker from "../components/ScanModePicker";
import ScanProgress from "../components/ScanProgress";
import Segmented from "../components/Segmented";
import SortPicker, { sorted, useSort } from "../components/SortPicker";
import type { SortOption } from "../components/SortPicker";
import Stack from "../components/Stack";
import StoppedNotice from "../components/StoppedNotice";
import TrashSetButton from "../components/TrashSetButton";
import {
  IconCheck,
  IconChevron,
  IconFolder,
  IconStop,
} from "../components/icons";

const PER_PAGE = 25;

type NameSortKey = "size" | "files" | "name" | "same";

// "Same size first" is the one worth verifying, so it sits with the others
// rather than as a separate toggle.
const SORT_OPTIONS: SortOption<NameSortKey>[] = [
  { value: "size", label: "Total size", naturalDir: "desc" },
  { value: "files", label: "Files in set", naturalDir: "desc" },
  { value: "name", label: "Name", naturalDir: "asc" },
  { value: "same", label: "Same size first", naturalDir: "desc" },
];

// One set's answer from verify_exact_match. covers is the exact list of files
// the answer was measured over, so a set that loses a file to the Trash stops
// showing a verdict that no longer describes it.
type GroupCheck = {
  covers: string;
  running: boolean;
  stopping: boolean;
  result: ExactCheck | null;
  error: string;
};

// What the scan reads: the whole index across every drive, or one picked folder.
type NameScope = "indexed" | "folder";

// Stable across filtering and paging: the backend keys a group by exactly these
// three, so no two groups can collide here either.
function keyOf(g: NameGroup): string {
  return `${g.stem}|${g.ext}|${g.year ?? ""}`;
}

// Defined once so the filter hook can memoize on them. Files in a name set can
// weigh wildly different amounts, so the size filter can take part of a set and
// leave the rest, and the header has to be rebuilt around what is left.
function pathsOf(g: NameGroup): string[] {
  return g.files.map((f) => f.path);
}

function sizesOf(g: NameGroup): number[] {
  return g.files.map((f) => f.size);
}

function coverOf(g: NameGroup): string {
  return g.files
    .map((f) => f.path)
    .sort()
    .join("\n");
}

function keepOnly(g: NameGroup, paths: Set<string>): NameGroup {
  const files = g.files.filter((f) => paths.has(f.path));
  return {
    ...g,
    files,
    all_same_size: files.every((f) => f.size === files[0].size),
  };
}

export default function SimilarNamesView({
  algo,
  scanMode,
  onScanMode,
  onExact,
  incoming,
  onAdopted,
  onOpenSaved,
  openBusy,
}: {
  algo: HashAlgo;
  scanMode: ScanMode;
  onScanMode: (m: ScanMode) => void;
  onExact: () => void;
  incoming: LoadedSnapshot | null;
  onAdopted: () => void;
  onOpenSaved: () => void;
  openBusy: boolean;
}) {
  const [strategy, setStrategy] = useState<NameStrategy>("copies");
  const [scope, setScope] = useState<NameScope>("indexed");
  const [roots, setRoots] = useState<string[] | null>(null);
  const [showRoots, setShowRoots] = useState(false);
  const [scanned, setScanned] = useState<NameScope | null>(null);
  const chosen = useRef(false);
  const [root, setRoot] = useState<string | null>(null);
  const [groups, setGroups] = useState<NameGroup[] | null>(null);
  const [groupCount, setGroupCount] = useState(0);
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<Record<string, Set<string>>>({});
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmSet, setConfirmSet] = useState<string | null>(null);
  // What the last trash refused to touch, and which set's button asked for it,
  // so the reasons land where the press happened instead of at the top of a
  // long page. null means the footer asked.
  const [skipped, setSkipped] = useState<SkippedItem[]>([]);
  const [skippedFrom, setSkippedFrom] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [stopped, setStopped] = useState(false);
  const [awayRoots, setAwayRoots] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<LoadedSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState("");
  const [checks, setChecks] = useState<Record<string, GroupCheck>>({});
  // Bumped every time the results are replaced. A check that was still hashing
  // when that happened describes files this page no longer shows, so its answer
  // is dropped rather than filed against the new set.
  const generation = useRef(0);
  const [inFlight, setInFlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const filter = useGroupFilter(groups, pathsOf, sizesOf, keepOnly);
  const sort = useSort<NameSortKey>("names", SORT_OPTIONS, "size");
  const files = useFileActions();
  const gone = (path: string) =>
    loaded != null && isMissing(loaded.checked, path);

  function goPage(next: number) {
    setPage(next);
    listRef.current?.scrollIntoView({ block: "start" });
  }

  useEffect(() => {
    const un = listen<Progress>("names:progress", (p) => setProgress(p));
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    invoke<string[]>("list_indexed_roots")
      .then((r) => {
        setRoots(r);
        if (!chosen.current && r.length === 0) setScope("folder");
      })
      .catch(() => setRoots([]));
  }, []);

  // Filtering is a view over the same results, so the reader lands back on the
  // first page of what is left rather than on an empty page 7.
  useEffect(() => {
    setPage(0);
  }, [filter.query, filter.ext, filter.minMb, sort.key, sort.dir]);

  // A snapshot the page handed down. Nothing is preselected here for the same
  // reason a live name scan preselects nothing: these files only share a name.
  useEffect(() => {
    if (!incoming || incoming.snap.kind !== "similar_names") return;
    const payload = incoming.snap.payload as NamePayload;
    const next = payload.groups ?? [];
    setLoaded(incoming);
    setGroups(next);
    setGroupCount(payload.group_count ?? next.length);
    setAwayRoots(payload.unavailable_roots ?? []);
    setStopped(payload.cancelled ?? false);
    if (payload.strategy) setStrategy(payload.strategy);
    setScanned(null);
    setSelection({});
    generation.current++;
    setChecks({});
    setPage(0);
    setError("");
    setDone("");
    setSaved("");
    setSkipped([]);
    setConfirmSet(null);
    onAdopted();
  }, [incoming, onAdopted]);

  function chooseScope(next: NameScope) {
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
    setSaved("");
    setSaveError("");
    setStopped(false);
    setScanning(true);
    setProgress({ done: 0, total: 0 });
    setGroups(null);
    setLoaded(null);
    setAwayRoots([]);
    setSelection({});
    generation.current++;
    setChecks({});
    setPage(0);
    setSkipped([]);
    setConfirmSet(null);
    try {
      const res = await invoke<NameScanResult>("scan_similar_names", {
        root: scope === "indexed" ? null : root,
        strategy,
        mode: scanMode,
      });
      setScanned(scope);
      setGroups(res.groups);
      setGroupCount(res.group_count);
      setAwayRoots(res.unavailable_roots ?? []);
      setStopped(res.cancelled);
      // Nothing is preselected on purpose. These files only share a name, so
      // there is no copy the app can safely call redundant.
      setSelection({});
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
        "similar_names",
        scanned === "folder" ? root : null,
        media ? "the Same title strategy" : "the Copies strategy",
        {
          group_count: groupCount,
          groups,
          cancelled: stopped,
          unavailable_roots: awayRoots,
          strategy,
        } satisfies NamePayload,
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

  function toggle(key: string, path: string) {
    if (gone(path)) return;
    setSelection((prev) => {
      const next = new Set(prev[key] ?? []);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { ...prev, [key]: next };
    });
    setConfirming(false);
    setDone("");
  }

  // Opens and hashes the files in one set, the same staged comparison the exact
  // scan runs. Nothing else on the page waits for it.
  async function runCheck(g: NameGroup) {
    const key = keyOf(g);
    const covers = coverOf(g);
    const paths = g.files.map((f) => f.path);
    const gen = generation.current;
    setChecks((prev) => ({
      ...prev,
      [key]: {
        covers,
        running: true,
        stopping: false,
        result: null,
        error: "",
      },
    }));
    // Counted apart from `checks`, which a new scan or an opened snapshot wipes
    // while the backend is still hashing. Reading busy off that record would let
    // a scan start and steal the cancel token out from under a live check.
    setInFlight((n) => n + 1);
    try {
      const res = await invoke<ExactCheck>("verify_exact_match", {
        paths,
        algo,
        mode: scanMode,
      });
      if (gen !== generation.current) return;
      setChecks((prev) => ({
        ...prev,
        [key]: {
          covers,
          running: false,
          stopping: false,
          result: res,
          error: "",
        },
      }));
    } catch (e) {
      if (gen !== generation.current) return;
      // The command refuses oversized sets with its own wording, so it is
      // shown as it came back rather than replaced with a guess.
      setChecks((prev) => ({
        ...prev,
        [key]: {
          covers,
          running: false,
          stopping: false,
          result: null,
          error: errorText(e),
        },
      }));
    } finally {
      setInFlight((n) => n - 1);
    }
  }

  // Shares the scan flag with everything else that reads the disk, so this is
  // the same stop the scan progress card uses. It reports whether it actually
  // reached a running token: a false there means this check was never the one
  // holding it, and the button has to say so instead of sitting on "Stopping"
  // for a stop that did nothing.
  async function stopCheck(key: string) {
    setChecks((prev) =>
      prev[key] ? { ...prev, [key]: { ...prev[key], stopping: true } } : prev,
    );
    try {
      const hit = await invoke<boolean>("cancel_scan");
      if (!hit)
        setChecks((prev) =>
          prev[key]
            ? {
                ...prev,
                [key]: {
                  ...prev[key],
                  stopping: false,
                  error:
                    "Nothing was stopped. This check is still reading and will finish on its own.",
                },
              }
            : prev,
        );
    } catch (e) {
      setChecks((prev) =>
        prev[key]
          ? {
              ...prev,
              [key]: {
                ...prev[key],
                stopping: false,
                error: `Could not stop: ${errorText(e)}`,
              },
            }
          : prev,
      );
    }
  }

  // Over every loaded group, not just the visible ones: a pick made before the
  // filter went on is still a pick, and it is still going to the Trash.
  const summary = useMemo(() => {
    let count = 0;
    let bytes = 0;
    let invalid = 0;
    let sets = 0;
    let hidden = 0;
    for (const g of groups ?? []) {
      const sel = selection[keyOf(g)];
      if (!sel || sel.size === 0) continue;
      const live = g.files.filter((f) => !gone(f.path)).length;
      if (sel.size >= live) invalid++;
      sets++;
      count += sel.size;
      for (const f of g.files) if (sel.has(f.path)) bytes += f.size;
      for (const p of sel) if (!filter.shows(p)) hidden++;
    }
    return { count, bytes, invalid, sets, hidden };
  }, [groups, selection, filter.shows, loaded]);

  // Ordering runs over what the filter left and before the page is cut, or the
  // second page would hold rows from the unsorted list.
  const ordered = useMemo(() => {
    if (!filter.filtered) return null;
    return sorted(
      filter.filtered,
      (g) =>
        sort.key === "name"
          ? g.stem
          : sort.key === "files"
            ? g.files.length
            : sort.key === "same"
              ? g.all_same_size
                ? 1
                : 0
              : g.files.reduce((n, f) => n + f.size, 0),
      sort.dir,
    );
  }, [filter.filtered, sort.key, sort.dir]);
  const nothingIndexed = roots !== null && roots.length === 0;
  const listed = ordered?.length ?? 0;
  const pages = Math.max(1, Math.ceil(listed / PER_PAGE));
  const from = page * PER_PAGE;
  const shown = ordered ? ordered.slice(from, from + PER_PAGE) : [];
  const checkBusy = inFlight > 0;
  const media = strategy === "media";
  // Only the sets on this page. Nothing off screen is ever requested, and what
  // has already arrived is served from the module cache when paging back.
  const thumb = useThumbs(
    shown.flatMap((g) => g.files.map((f) => f.path)),
    SMALL_PX,
  );

  // Shared by the footer and by the per-set button. trash_files reports what it
  // actually moved, so only res.moved leaves the list, the selection, and the
  // reclaimed total. Anything it refused stays on screen and stays ticked, and
  // its set is kept alive even at one file so the reader can still see it and
  // try again. Throws when nothing moved, so the caller reports it where it was
  // pressed rather than showing a done line for work that did not happen.
  async function removePaths(paths: string[], from: string | null) {
    const res = await invoke<TrashOutcome>("trash_files", {
      paths,
      reason: "dedup",
    });
    if (res.moved.length === 0) {
      setDone("");
      setSkipped(res.skipped);
      setSkippedFrom(from);
      throw new Error(
        res.skipped.length > 0
          ? "nothing moved, every file was refused. The reasons are listed below."
          : "nothing moved, and the Trash gave no reason.",
      );
    }
    const removed = new Set(res.moved);
    const stuck = new Set(res.skipped.map((s) => s.path));
    let freed = 0;
    for (const g of groups ?? [])
      for (const f of g.files) if (removed.has(f.path)) freed += f.size;
    const remaining = (groups ?? [])
      .map((g) => {
        const files = g.files.filter((f) => !removed.has(f.path));
        return {
          ...g,
          files,
          all_same_size: files.every((f) => f.size === files[0]?.size),
        };
      })
      .filter(
        (g) => g.files.length > 1 || g.files.some((f) => stuck.has(f.path)),
      );
    setGroups(remaining);
    setGroupCount(remaining.length);
    setPage((p) =>
      Math.min(p, Math.max(0, Math.ceil(remaining.length / PER_PAGE) - 1)),
    );
    setSelection((prev) => {
      const next: Record<string, Set<string>> = {};
      for (const g of remaining) {
        const kept = new Set(
          [...(prev[keyOf(g)] ?? [])].filter((p) => !removed.has(p)),
        );
        if (kept.size > 0) next[keyOf(g)] = kept;
      }
      return next;
    });
    setConfirming(false);
    setConfirmSet(null);
    setError("");
    setSkipped(res.skipped);
    setSkippedFrom(from);
    const n = res.moved.length;
    setDone(
      n === paths.length
        ? `Moved ${n} ${n === 1 ? "file" : "files"} to Trash and freed ${formatSize(freed)}. Restore anytime from Trash.`
        : `Moved ${n} of the ${paths.length} files you picked to Trash and freed ${formatSize(freed)}. Restore anytime from Trash.`,
    );
  }

  async function trashSelected() {
    const paths: string[] = [];
    for (const g of groups ?? [])
      for (const p of selection[keyOf(g)] ?? []) paths.push(p);
    if (paths.length === 0) return;
    try {
      await removePaths(paths, null);
    } catch (e) {
      setError(`Could not move files: ${errorText(e)}`);
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-6 pb-28">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <Segmented<NameScope>
          ariaLabel="What the scan covers"
          value={scope}
          onChange={chooseScope}
          options={[
            { value: "indexed", label: "Everything indexed" },
            { value: "folder", label: "One folder" },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2">
          {groups && groups.length > 0 && !loaded && (
            <ExportButton onExport={save} busy={saving} kind="similar_names" />
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
          {/* A check and a scan share one cancel token, so the second one to
              start takes it and Stop then hits the wrong job. The check already
              waits for the scan, and this is the other half of that. */}
          {checkBusy && !scanning && (
            <span className="max-w-xs text-xs leading-relaxed text-ink-soft">
              A set is being checked byte for byte. Let it finish or stop it
              first, then scan.
            </span>
          )}
          <button
            type="button"
            onClick={scan}
            disabled={
              scanning ||
              checkBusy ||
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

      {loaded && groups && (
        <SnapshotBanner
          loaded={loaded}
          summary={`${groupCount.toLocaleString()} ${groupCount === 1 ? "set" : "sets"}`}
          onClose={() => {
            setLoaded(null);
            setGroups(null);
            setSelection({});
            setAwayRoots([]);
            setStopped(false);
          }}
        />
      )}

      {scope === "folder" && root && !loaded && (
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
            Add the folders and drives you want covered in Search, then read
            every name here in one pass. To read a single folder right now,
            switch to One folder.
          </p>
        </div>
      )}

      {!(scope === "indexed" && nothingIndexed) && (
        <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
          <div
            className={
              "space-y-1.5" +
              (scanning ? " pointer-events-none opacity-60" : "")
            }
          >
            <Segmented<NameStrategy>
              ariaLabel="How names are matched"
              value={strategy}
              onChange={setStrategy}
              options={[
                { value: "copies", label: "Copies" },
                { value: "media", label: "Same title" },
              ]}
            />
            <p className="max-w-sm text-xs leading-relaxed text-ink-soft">
              {media
                ? "One title held at several qualities, like Inception.2010.720p.mp4 next to inception 1080p.mkv. Ignores the container, and never mixes video with audio."
                : "A file sitting next to its own copy, like invoice (1).pdf next to invoice.pdf. Only matches within the same extension."}
            </p>
          </div>
          <ScanModePicker
            value={scanMode}
            onChange={onScanMode}
            disabled={scanning}
          />
        </div>
      )}

      {progress && <ScanProgress progress={progress} label="Reading names" />}

      {stopped && (
        <StoppedNotice>
          {groups && groups.length > 0
            ? `You stopped this scan. These are only the names it had read by then, so there may be more matches ${scanned === "indexed" ? "across your indexed folders" : "in that folder"}.`
            : `You stopped this scan before it matched any names. Scan again to read ${scanned === "indexed" ? "every indexed folder" : "the whole folder"}.`}
        </StoppedNotice>
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
      {skippedFrom === null && skipped.length > 0 && (
        <SkippedNote items={skipped} />
      )}

      {groups && groups.length === 0 && !done && !stopped && (
        <div className="rounded-lg border border-line bg-surface px-6 py-16 text-center">
          <p className="text-sm font-medium text-ink">
            {media ? "No repeated titles" : "No copies by name"}
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-ink-soft">
            {media
              ? "Every video and track carries its own title here. Switch to Copies to look for files sitting next to a copy of themselves."
              : "No file here sits next to a copy of its own name. Switch to Same title to look for one movie or album held at several qualities."}
          </p>
        </div>
      )}

      {groups && groups.length > 0 && (
        <>
          <div className="rounded-lg border border-ochre/40 bg-ochre-soft px-4 py-3">
            <p className="text-sm font-semibold text-ochre">
              Matched by name, not by content
            </p>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ochre">
              Nothing in this list was compared byte for byte, so two files in
              one set can hold completely different things. That is why nothing
              is selected here: read the size and the date, then pick what goes.
            </p>
            <button
              type="button"
              onClick={onExact}
              className="mt-2.5 rounded-md border border-ochre/40 bg-surface px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:border-ochre focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ochre"
            >
              Compare by content instead
            </button>
          </div>

          <NameCoverageNote roots={awayRoots} />

          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <span className="text-ink-soft">
              <span className="font-semibold text-ink">
                {groupCount.toLocaleString()}
              </span>{" "}
              {media ? "repeated" : "name"} {groupCount === 1 ? "set" : "sets"}
            </span>
            {stopped && (
              <span className="rounded-[3px] border border-ochre/40 bg-ochre-soft px-1.5 py-0.5 text-xs font-medium text-ochre">
                Partial list
              </span>
            )}
            {groupCount > (groups?.length ?? 0) && (
              <span className="text-xs text-ink-faint">
                The first {(groups?.length ?? 0).toLocaleString()} are listed
                below
              </span>
            )}
          </div>

          <div className="space-y-2">
            <ResultFilters filter={filter} unit="sets" />
            <div className="flex justify-end">
              <SortPicker sort={sort} label="Sort sets by" />
            </div>
          </div>

          {listed === 0 ? (
            <NoFilterMatch filter={filter} unit="sets" />
          ) : (
            <>
              {pages > 1 && (
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
                  const held = checks[keyOf(g)];
                  return (
                    <NameGroupCard
                      key={keyOf(g)}
                      group={g}
                      selected={selection[keyOf(g)] ?? new Set<string>()}
                      onToggle={(p) => toggle(keyOf(g), p)}
                      files={files}
                      thumb={thumb}
                      checked={loaded?.checked ?? null}
                      check={held && held.covers === coverOf(g) ? held : null}
                      onCheck={() => runCheck(g)}
                      onStop={() => stopCheck(keyOf(g))}
                      busy={scanning || checkBusy}
                      confirmOpen={confirmSet === keyOf(g)}
                      onConfirmOpen={(open) =>
                        setConfirmSet(open ? keyOf(g) : null)
                      }
                      onTrashSet={(paths) => removePaths(paths, keyOf(g))}
                      skipped={skippedFrom === keyOf(g) ? skipped : null}
                    />
                  );
                })}
              </div>

              {pages > 1 && (
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
        </>
      )}

      {summary.count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface px-4 py-3 md:left-56">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
            {confirming ? (
              <>
                <span className="text-sm text-ink">
                  Move {summary.count} {summary.count === 1 ? "file" : "files"}{" "}
                  to Trash and free{" "}
                  <span className="font-mono text-ochre">
                    {formatSize(summary.bytes)}
                  </span>
                  ? These were matched by name, so open anything you are unsure
                  about first. You can restore them later.
                  {/* Ticking every box in a set is allowed, but it is the one
                      case that leaves no file behind, so it is said out loud
                      before anything moves. */}
                  {summary.invalid > 0 && (
                    <>
                      {" "}
                      <span className="text-ochre">
                        {summary.invalid}{" "}
                        {summary.invalid === 1 ? "set" : "sets"} would be
                        emptied completely, keeping no file on disk.
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
                  selected to remove across{" "}
                  <span className="font-semibold text-ink">
                    {summary.sets.toLocaleString()}
                  </span>
                  {summary.sets === 1 ? " set" : " sets"},{" "}
                  <span className="font-mono text-ochre">
                    {formatSize(summary.bytes)}
                  </span>{" "}
                  freed
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
                    <span className="text-brick">
                      {" "}
                      · {summary.invalid} set{summary.invalid === 1 ? "" : "s"}{" "}
                      would keep no file
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

// What the Trash refused to take, in its own words. The backend writes each
// reason as a finished sentence, so it is shown as it came back.
function SkippedNote({ items }: { items: SkippedItem[] }) {
  return (
    <div className="rounded-md border border-ochre/40 bg-ochre-soft px-3.5 py-2.5 text-sm text-ochre">
      <p className="font-medium">
        {items.length} {items.length === 1 ? "file" : "files"} did not move and{" "}
        {items.length === 1 ? "is" : "are"} still on disk.{" "}
        {items.length === 1 ? "It stays" : "They stay"} listed here, and
        anything you had ticked stays ticked, so you can fix the reason and try
        again.
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {items.map((s) => (
          <li key={s.path} className="text-xs leading-relaxed">
            <span className="block truncate font-mono" title={s.path}>
              {s.path}
            </span>
            <span className="block">{s.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// One name set. Size is the whole judgement here, so where the files differ
// every row carries a bar drawn against the biggest file in the set.
function NameGroupCard({
  group,
  selected,
  onToggle,
  files,
  thumb,
  checked,
  check,
  onCheck,
  onStop,
  busy,
  confirmOpen,
  onConfirmOpen,
  onTrashSet,
  skipped,
}: {
  group: NameGroup;
  selected: Set<string>;
  onToggle: (path: string) => void;
  files: ReturnType<typeof useFileActions>;
  thumb: (path: string) => string | null | undefined;
  checked: Verification | null;
  check: GroupCheck | null;
  onCheck: () => void;
  onStop: () => void;
  busy: boolean;
  confirmOpen: boolean;
  onConfirmOpen: (open: boolean) => void;
  onTrashSet: (paths: string[]) => Promise<void>;
  skipped: SkippedItem[] | null;
}) {
  const media = group.strategy === "media";
  const largest = Math.max(...group.files.map((f) => f.size), 1);
  const smallest = Math.min(...group.files.map((f) => f.size));
  // One image in the set gives the whole set a preview column, so the rows stay
  // lined up whether or not a given preview ever arrives.
  const previews = group.files.some((f) => isImage(f.path));
  const result = check?.result ?? null;
  // A cancelled run and a run that opened nothing are not verdicts, so only a
  // finished comparison is allowed to mark rows or replace the size hint.
  const measured =
    result != null && !result.cancelled && result.compared > 0 ? result : null;
  const matched = measured
    ? measured.groups.reduce((n, g) => n + g.paths.length, 0)
    : 0;
  // Two pairs that match inside themselves are not one identical set, so the
  // count of groups decides the wording as much as the count of files does.
  const sets = measured ? measured.groups.length : 0;
  const allSame =
    measured != null &&
    measured.groups.length === 1 &&
    measured.unique.length === 0 &&
    measured.unreadable.length === 0 &&
    matched === group.files.length;
  // Which file landed where, so the rows themselves carry the split instead of
  // the reader matching paths against a paragraph.
  const marks = useMemo(() => {
    const out = new Map<string, { label: string; tone: string }>();
    if (!measured) return out;
    measured.groups.forEach((g, i) => {
      // A 512-path set can split further than the alphabet goes, so past Z the
      // labels carry on AA, AB rather than into punctuation.
      let tag = "";
      for (let n = i; ; n = Math.floor(n / 26) - 1) {
        tag = String.fromCharCode(65 + (n % 26)) + tag;
        if (n < 26) break;
      }
      const label =
        measured.groups.length > 1 ? `Identical ${tag}` : "Identical";
      for (const p of g.paths)
        out.set(p, {
          label,
          tone: "border-teal-line bg-teal-soft text-teal",
        });
    });
    for (const p of measured.unique)
      out.set(p, {
        label: "Different bytes",
        tone: "border-line bg-surface-2 text-ink-soft",
      });
    for (const p of measured.unreadable)
      out.set(p, {
        label: "Could not read",
        tone: "border-ochre/40 bg-ochre-soft text-ochre",
      });
    return out;
  }, [measured]);
  // A path a snapshot says is gone cannot be trashed, so the whole set button
  // offers only what is still on disk.
  const live = group.files
    .filter((f) => !(checked != null && isMissing(checked, f.path)))
    .map((f) => f.path);
  // The one clause that is true here and in neither other tab: a name set is a
  // guess until someone runs the exact check on it. Once a verdict exists the
  // question repeats what was actually measured instead.
  const note = measured
    ? (allSame
        ? `The exact check read all ${group.files.length} and found them byte for byte identical, so this leaves no copy of that file anywhere.`
        : measured.compared === 1
          ? "The exact check could open only one of these, so nothing here was ever compared against anything."
          : matched > 0
            ? `The exact check compared ${measured.compared} of these and only ${matched} are byte for byte identical, so the rest are separate files.`
            : `The exact check compared ${measured.compared} of these and none of them matched each other, so every one is a separate file.`) +
      (measured.unreadable.length > 0
        ? ` ${measured.unreadable.length} could not be opened and ${measured.unreadable.length === 1 ? "was" : "were"} never compared.`
        : "")
    : "Nothing here has been compared byte for byte. These files share a name and nothing else, so two of them can hold completely different things.";
  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Stack n={group.files.length} variant="guess" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {/* The matched key as the backend normalized it, in mono for the
                  same reason paths are: it is data, not a title someone typed. */}
              <span className="truncate font-mono text-sm font-medium text-ink">
                {group.stem}
                {!media && group.ext && (
                  <span className="text-ink-faint">.{group.ext}</span>
                )}
              </span>
              {media && group.year != null && (
                <span className="rounded-[3px] border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink-soft">
                  {group.year}
                </span>
              )}
            </div>
            <div className="text-xs text-ink-faint">
              {/* A set can be left at one file when the Trash refused the rest,
                  so the count carries its own verb. */}
              {group.files.length}{" "}
              {group.files.length === 1
                ? media
                  ? "file carries this title, the rest could not be moved"
                  : "file carries this name, the rest could not be moved"
                : media
                  ? "files share this title across containers"
                  : "files share this name"}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-2">
          {measured ? (
            <span
              className={
                "rounded-[3px] border px-1.5 py-0.5 text-xs font-medium " +
                (allSame
                  ? "border-teal-line bg-teal-soft text-teal"
                  : matched > 0
                    ? "border-ochre/40 bg-ochre-soft text-ochre"
                    : "border-line bg-surface-2 text-ink-soft")
              }
            >
              {allSame
                ? `All ${group.files.length} identical`
                : sets > 1
                  ? `${sets} identical groups`
                  : matched > 0
                    ? `${matched} identical`
                    : measured.compared === 1
                      ? "Nothing to compare"
                      : "No byte match"}
            </span>
          ) : null}
          {measured != null && measured.unreadable.length > 0 && (
            <span className="rounded-[3px] border border-ochre/40 bg-ochre-soft px-1.5 py-0.5 text-xs font-medium text-ochre">
              {measured.unreadable.length} unread
            </span>
          )}
          {measured == null &&
            (group.all_same_size ? (
              <span className="text-xs text-ink-soft">
                All {formatSize(largest)}, size matches
              </span>
            ) : (
              <span className="rounded-[3px] border border-ochre/40 bg-ochre-soft px-1.5 py-0.5 text-xs font-medium text-ochre">
                {formatSize(smallest)} to {formatSize(largest)}
              </span>
            ))}
          {check?.running ? (
            <button
              type="button"
              onClick={onStop}
              disabled={check.stopping}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink transition-colors hover:border-line-strong disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
            >
              {check.stopping ? (
                <span className="h-3.5 w-3.5 rounded-full border-2 border-ink-faint/40 border-t-ink-faint fo-spin" />
              ) : (
                <IconStop className="h-3.5 w-3.5" />
              )}
              {check.stopping ? "Stopping" : "Stop"}
            </button>
          ) : (
            <button
              type="button"
              onClick={onCheck}
              disabled={busy}
              className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink transition-colors hover:border-line-strong disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
            >
              {check ? "Check again" : "Check for exact match"}
            </button>
          )}
          {live.length > 0 && (
            <TrashSetButton
              paths={live}
              noun="file"
              note={note}
              open={confirmOpen}
              onOpen={onConfirmOpen}
              onTrash={onTrashSet}
            />
          )}
        </div>
      </div>
      {skipped != null && skipped.length > 0 && (
        <div className="border-b border-line px-4 py-3">
          <SkippedNote items={skipped} />
        </div>
      )}
      {check && (check.error !== "" || check.running || result != null) && (
        <div className="border-b border-line px-4 py-3 text-sm leading-relaxed">
          {check.error !== "" && <p className="text-brick">{check.error}</p>}
          {check.running && (
            <p className="flex items-center gap-2 text-ink-soft">
              <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-ink-faint/40 border-t-ink-faint fo-spin" />
              Comparing these {group.files.length} files byte for byte. The rest
              of the list stays open while it runs.
            </p>
          )}
          {result?.cancelled && (
            <p className="text-ochre">
              {result.compared === 0
                ? "You stopped this check before it read anything, so none of these files have been compared."
                : `You stopped this check. It got through ${result.compared} of ${group.files.length} files, so this is not a verdict yet. Check again to finish.`}
            </p>
          )}
          {result != null && !result.cancelled && result.compared === 0 && (
            <p className="text-ochre">
              Nothing in this set was opened, so this says nothing about whether
              the files match.
              {result.unreadable.length > 0 &&
                ` All ${result.unreadable.length} refused to open: the drive may be unplugged, or the paths may not be plain files.`}
            </p>
          )}
          {allSame && (
            <p className="text-teal">
              All {group.files.length} files are byte for byte identical.
              Keeping one and moving the rest to Trash is safe.
            </p>
          )}
          {measured != null && !allSame && sets > 1 && (
            <p className="text-ink">
              These {measured.compared} files split into {sets} identical groups
              {measured.unique.length > 0
                ? `, and ${measured.unique.length} match nothing else`
                : ""}
              . Each row below says which group it fell into.
            </p>
          )}
          {measured != null &&
            !allSame &&
            sets === 1 &&
            measured.unique.length === 0 && (
              <p className="text-ink">
                All {matched} files that were compared are byte for byte
                identical. Keeping one of them and moving the rest to Trash is
                safe.
              </p>
            )}
          {measured != null && sets === 1 && measured.unique.length > 0 && (
            <p className="text-ink">
              {matched} of {measured.compared} files are byte for byte
              identical, the rest only share the name. Each row below says which
              it is.
            </p>
          )}
          {measured != null && matched === 0 && measured.compared === 1 && (
            <p className="text-ochre">
              Only one file here could be opened, so there was nothing to
              compare it against.
            </p>
          )}
          {measured != null && matched === 0 && measured.compared > 1 && (
            <p className="text-ink">
              Same name, different bytes. None of these {measured.compared}{" "}
              files match each other, so there is no copy here to remove.
            </p>
          )}
          {/* Every cancelled run also comes back with a populated unreadable
              list, so this is tied to a verdict: a coverage claim next to "none
              of these have been compared" contradicts it. */}
          {measured != null && measured.unreadable.length > 0 && (
            <p className="mt-1 text-ochre">
              {measured.unreadable.length}{" "}
              {measured.unreadable.length === 1 ? "file" : "files"} could not be
              opened, so this covers only the other {measured.compared}. The
              drive may be unplugged, or the path may not be a plain file.
            </p>
          )}
          {result != null && result.bytes_hashed > 0 && (
            <p className="mt-1 text-xs text-ink-faint">
              <span className="font-mono">
                {formatSize(result.bytes_hashed)}
              </span>{" "}
              read from disk, including the 16 KB probe taken from every file
              that got past the size check. Only files ruled out by size alone
              were never opened.
            </p>
          )}
        </div>
      )}
      <ul>
        {group.files.map((f) => {
          const remove = selected.has(f.path);
          const mark = marks.get(f.path);
          const lost = checked != null && isMissing(checked, f.path);
          const cut = Math.max(
            f.path.lastIndexOf("/"),
            f.path.lastIndexOf("\\"),
          );
          const name = f.path.slice(cut + 1);
          const dir = f.path.slice(0, cut);
          const why = media
            ? (f.stripped ?? []).slice(0, 5).join(" · ")
            : f.marker
              ? `copy marker ${f.marker}`
              : "bare name";
          return (
            <li key={f.path}>
              <div
                onDoubleClick={() => files.open(f.path)}
                className={
                  "flex items-start gap-2 border-b border-line/60 px-4 py-3 last:border-b-0 " +
                  (lost ? "bg-surface-2/40" : "hover:bg-surface-2/50")
                }
              >
                <label
                  className={
                    "flex min-w-0 flex-1 items-start gap-3 " +
                    (lost ? "cursor-default" : "cursor-pointer")
                  }
                >
                  <span
                    className={
                      "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[3px] border transition-colors " +
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
                      onChange={() => onToggle(f.path)}
                      aria-label={
                        lost ? `${name} is missing` : `Remove ${name}`
                      }
                      className="sr-only"
                    />
                    {remove && !lost && <IconCheck className="h-3 w-3" />}
                  </span>
                  {previews && (
                    <ThumbSlot
                      path={f.path}
                      src={thumb(f.path)}
                      size="h-10 w-10"
                      dim={lost}
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span
                      className={
                        "block truncate text-sm " +
                        (lost ? "text-ink-faint line-through" : "text-ink")
                      }
                    >
                      {name}
                    </span>
                    <span className="block truncate font-mono text-xs text-ink-faint">
                      {dir}
                    </span>
                    {/* Size against the biggest file in the set, and what put
                      this file in the set, on one quiet line. */}
                    <span className="mt-1.5 flex items-center gap-2">
                      {!group.all_same_size && (
                        <span
                          aria-hidden="true"
                          className="block h-[3px] w-20 shrink-0 rounded-[2px] bg-surface-2"
                        >
                          <span
                            className="block h-full rounded-[2px] bg-ochre"
                            style={{
                              width: `${Math.max(4, (f.size / largest) * 100)}%`,
                            }}
                          />
                        </span>
                      )}
                      {why && (
                        <span className="min-w-0 truncate font-mono text-xs text-ink-faint">
                          {why}
                        </span>
                      )}
                    </span>
                  </span>
                </label>
                <span className="shrink-0 text-right">
                  <span
                    className={
                      "block font-mono text-sm " +
                      (group.all_same_size ? "text-ink-soft" : "text-ink")
                    }
                  >
                    {formatSize(f.size)}
                  </span>
                  <span className="block text-xs text-ink-faint">
                    {formatDate(f.modified_ns) || "no date"}
                  </span>
                  {mark && (
                    <span
                      className={
                        "mt-1 inline-block rounded-[3px] border px-1.5 py-0.5 text-xs font-medium " +
                        mark.tone
                      }
                    >
                      {mark.label}
                    </span>
                  )}
                  {lost ? (
                    <span className="mt-1 block">
                      <MissingTag />
                    </span>
                  ) : checked != null && isChanged(checked, f.path) ? (
                    <span className="mt-1 block">
                      <ChangedTag />
                    </span>
                  ) : (
                    remove && (
                      <span className="block text-xs text-brick">Remove</span>
                    )
                  )}
                </span>
                <RevealButton
                  name={name}
                  onReveal={() => files.reveal(f.path)}
                  className="-mt-0.5"
                />
              </div>
              {files.failed?.path === f.path && (
                <FileActionError message={files.failed.message} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
