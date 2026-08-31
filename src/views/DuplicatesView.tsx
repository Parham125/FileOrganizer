import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, listen, pickFolder } from "../bridge";
import { formatSize } from "../format";
import { useDupMinMb, useScanMode } from "../store";
import type {
  DupGroup,
  DupScanResult,
  HashAlgo,
  Progress,
  ScanMode,
} from "../types";
import PageHeader from "../components/PageHeader";
import Pager from "../components/Pager";
import ResultFilters, {
  NoFilterMatch,
  useGroupFilter,
} from "../components/ResultFilters";
import ScanModePicker from "../components/ScanModePicker";
import ScanProgress from "../components/ScanProgress";
import Segmented from "../components/Segmented";
import Stack from "../components/Stack";
import StoppedNotice from "../components/StoppedNotice";
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

export default function DuplicatesView({ algo }: { algo: HashAlgo }) {
  const [mode, setMode] = useState<DupMode>("exact");
  const [scanMode, setScanMode] = useScanMode();
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
      {mode === "exact" && (
        <ExactDuplicates
          algo={algo}
          scanMode={scanMode}
          onScanMode={setScanMode}
        />
      )}
      {mode === "similar" && (
        <SimilarImagesView scanMode={scanMode} onScanMode={setScanMode} />
      )}
      {mode === "names" && (
        <SimilarNamesView
          scanMode={scanMode}
          onScanMode={setScanMode}
          onExact={() => setMode("exact")}
        />
      )}
    </div>
  );
}

// A drive can produce thousands of sets. Rendering them all stalls the view, so
// the list is paged while the selection stays whole underneath it.
const PER_PAGE = 25;

function shortestPath(paths: string[]): string {
  return [...paths].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  )[0];
}

// Selected == the copies to remove. Default keeps the shortest path and
// preselects every other copy for the trash.
function defaultRemoval(g: DupGroup): Set<string> {
  const keep = shortestPath(g.paths);
  return new Set(g.paths.filter((p) => p !== keep));
}

// What the scan reads: the whole index across every drive, or one picked folder.
type DupScope = "indexed" | "folder";

// Defined once so the filter hook can memoize on it.
function pathsOf(g: DupGroup): string[] {
  return g.paths;
}

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
}: {
  algo: HashAlgo;
  scanMode: ScanMode;
  onScanMode: (m: ScanMode) => void;
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
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [stopped, setStopped] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const filter = useGroupFilter(groups, pathsOf);

  // Turning the page puts the reader at the top of the new one, not halfway
  // down where the last one ended.
  function goPage(next: number) {
    setPage(next);
    listRef.current?.scrollIntoView({ block: "start" });
  }

  // Filtering is a view over the same results, so the reader lands back on the
  // first page of what is left rather than on an empty page 7.
  useEffect(() => {
    setPage(0);
  }, [filter.query, filter.ext]);

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
    setStopped(false);
    setScanning(true);
    setProgress({ done: 0, total: 0 });
    setGroups(null);
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
      setStopped(res.cancelled);
      const sel: Record<string, Set<string>> = {};
      for (const g of res.groups) sel[g.hash] = defaultRemoval(g);
      setSelection(sel);
    } catch (e) {
      setError(`Scan failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }

  function toggle(hash: string, path: string) {
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
    const visible = new Set((filter.filtered ?? []).map((g) => g.hash));
    let count = 0;
    let bytes = 0;
    let invalid = 0;
    let sets = 0;
    let hidden = 0;
    for (const g of groups ?? []) {
      const rm = selection[g.hash]?.size ?? 0;
      if (rm >= g.paths.length) invalid++;
      if (rm > 0) sets++;
      count += rm;
      bytes += rm * g.size;
      if (rm > 0 && !visible.has(g.hash)) hidden += rm;
    }
    return { count, bytes, invalid, sets, hidden };
  }, [groups, selection, filter.filtered]);

  const wasted = useMemo(
    () => (groups ?? []).reduce((s, g) => s + g.size * (g.paths.length - 1), 0),
    [groups],
  );

  const nothingIndexed = roots !== null && roots.length === 0;
  const loaded = groups?.length ?? 0;
  const listed = filter.filtered?.length ?? 0;
  const pages = Math.max(1, Math.ceil(listed / PER_PAGE));
  const from = page * PER_PAGE;
  const shown = filter.filtered
    ? filter.filtered.slice(from, from + PER_PAGE)
    : [];

  async function trashSelected() {
    const paths: string[] = [];
    for (const g of groups ?? [])
      for (const p of selection[g.hash] ?? []) paths.push(p);
    if (paths.length === 0) return;
    try {
      await invoke<string>("trash_files", { paths, reason: "dedup" });
      const removed = new Set(paths);
      const remaining = (groups ?? [])
        .map((g) => ({ ...g, paths: g.paths.filter((p) => !removed.has(p)) }))
        .filter((g) => g.paths.length > 1);
      setGroups(remaining);
      setGroupCount(remaining.length);
      setPage((p) =>
        Math.min(p, Math.max(0, Math.ceil(remaining.length / PER_PAGE) - 1)),
      );
      const sel: Record<string, Set<string>> = {};
      for (const g of remaining) sel[g.hash] = defaultRemoval(g);
      setSelection(sel);
      setConfirming(false);
      setDone(
        `Moved ${paths.length} ${paths.length === 1 ? "file" : "files"} to Trash and reclaimed ${formatSize(summary.bytes)}. Restore anytime from Trash.`,
      );
    } catch (e) {
      setError(
        `Could not move files: ${e instanceof Error ? e.message : String(e)}`,
      );
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

      {scope === "folder" && root && (
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
              <Segmented<string>
                ariaLabel="Smallest file the scan compares"
                value={String(minMb)}
                onChange={(v) => setMinMb(Number(v))}
                options={[
                  { value: "0", label: "All" },
                  { value: "1", label: "1 MB" },
                  { value: "10", label: "10 MB" },
                  { value: "100", label: "100 MB" },
                ]}
              />
              <p className="max-w-xs text-xs leading-relaxed text-ink-soft">
                {minMb === 0
                  ? "Compares every file. Tiny files repeat on every drive, so expect a long list of sets that free almost nothing."
                  : `Skips files under ${minMb} MB. Small files repeat across drives in the thousands and barely free any space.`}
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

          <ResultFilters filter={filter} unit="sets" />

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
              const keeping = g.paths.length - sel.size;
              const drives = new Set(g.paths.map(driveOf)).size;
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
                        </div>
                        <div className="font-mono text-xs text-ink-faint">
                          {g.hash}
                        </div>
                      </div>
                    </div>
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
                  </div>
                  <ul>
                    {g.paths.map((p) => {
                      const remove = sel.has(p);
                      const name = p.slice(p.lastIndexOf("/") + 1);
                      const dir = p.slice(0, p.lastIndexOf("/"));
                      return (
                        <li key={p}>
                          <label className="flex cursor-pointer items-center gap-3 border-b border-line/60 px-4 py-2.5 last:border-b-0 hover:bg-surface-2/50">
                            <span
                              className={
                                "grid h-4 w-4 shrink-0 place-items-center rounded-[3px] border transition-colors " +
                                (remove
                                  ? "border-brick bg-brick text-white"
                                  : "border-line-strong bg-surface")
                              }
                            >
                              <input
                                type="checkbox"
                                checked={remove}
                                onChange={() => toggle(g.hash, p)}
                                className="sr-only"
                              />
                              {remove && <IconCheck className="h-3 w-3" />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-ink">
                                {name}
                              </span>
                              <span className="block truncate font-mono text-xs text-ink-faint">
                                {dir}
                              </span>
                            </span>
                            <span
                              className={
                                "shrink-0 text-xs " +
                                (remove ? "text-brick" : "text-teal")
                              }
                            >
                              {remove ? "Remove" : "Keep"}
                            </span>
                          </label>
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
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur md:left-56">
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
                    <span className="text-brick">
                      {" "}
                      · {summary.invalid} set{summary.invalid === 1 ? "" : "s"}{" "}
                      would keep no copy
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={summary.invalid > 0}
                  className="rounded-md bg-teal px-3.5 py-2 text-sm font-medium text-white hover:brightness-95 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
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
