import { useEffect, useMemo, useState } from "react";
import { invoke, listen, pickFolder } from "../bridge";
import type {
  Progress,
  ScanMode,
  SimilarGroup,
  SimilarScanResult,
} from "../types";
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
import Stack from "../components/Stack";
import StoppedNotice from "../components/StoppedNotice";
import { IconCheck, IconFolder } from "../components/icons";

// Stable across filtering, unlike the position a set happens to sit at.
function keyOf(g: SimilarGroup): string {
  return g.files.map((f) => f.path).join("|");
}

// Defined once so the filter hook can memoize on it.
function pathsOf(g: SimilarGroup): string[] {
  return g.files.map((f) => f.path);
}

function shortestPath(paths: string[]): string {
  return [...paths].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  )[0];
}

// Selected == the copies to remove. Default keeps the shortest path and
// preselects every other look-alike for the trash.
function defaultRemoval(paths: string[]): Set<string> {
  const keep = shortestPath(paths);
  return new Set(paths.filter((p) => p !== keep));
}

export default function SimilarImagesView({
  scanMode,
  onScanMode,
}: {
  scanMode: ScanMode;
  onScanMode: (m: ScanMode) => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [groups, setGroups] = useState<SimilarGroup[] | null>(null);
  const [selection, setSelection] = useState<Record<string, Set<string>>>({});
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [stopped, setStopped] = useState(false);
  // No size accessor: an image scan reports the paths it compared and nothing
  // about how much they weigh, so the size filter stays out of this mode.
  const filter = useGroupFilter(groups, pathsOf);
  const files = useFileActions();

  useEffect(() => {
    const un = listen<Progress>("similar:progress", (p) => setProgress(p));
    return () => {
      un.then((f) => f());
    };
  }, []);

  async function chooseFolder() {
    const dir = await pickFolder();
    if (dir) setRoot(dir);
  }

  async function scan() {
    if (!root) {
      setError("Pick a folder to scan first.");
      return;
    }
    setError("");
    setDone("");
    setStopped(false);
    setScanning(true);
    setProgress({ done: 0, total: 0 });
    setGroups(null);
    try {
      const res = await invoke<SimilarScanResult>("scan_similar_images", {
        root,
        maxDistance: 8,
        mode: scanMode,
      });
      setGroups(res.groups);
      setStopped(res.cancelled);
      const sel: Record<string, Set<string>> = {};
      for (const g of res.groups) sel[keyOf(g)] = defaultRemoval(pathsOf(g));
      setSelection(sel);
    } catch (e) {
      setError(`Scan failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }

  function toggle(key: string, path: string) {
    setSelection((prev) => {
      const next = new Set(prev[key] ?? []);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { ...prev, [key]: next };
    });
    setConfirming(false);
    setDone("");
  }

  // Over every loaded set, filtered or not: hiding a set is not deselecting it,
  // so hidden reports what the filter is covering up.
  const summary = useMemo(() => {
    let count = 0;
    let invalid = 0;
    let hidden = 0;
    for (const g of groups ?? []) {
      const sel = selection[keyOf(g)];
      const rm = sel?.size ?? 0;
      if (rm >= g.files.length) invalid++;
      count += rm;
      for (const p of sel ?? []) if (!filter.shows(p)) hidden++;
    }
    return { count, invalid, hidden };
  }, [groups, selection, filter.shows]);

  async function trashSelected() {
    const paths: string[] = [];
    for (const g of groups ?? [])
      for (const p of selection[keyOf(g)] ?? []) paths.push(p);
    if (paths.length === 0) return;
    try {
      await invoke<string>("trash_files", { paths, reason: "dedup" });
      const removed = new Set(paths);
      const remaining = (groups ?? [])
        .map((g) => ({ ...g, files: g.files.filter((f) => !removed.has(f.path)) }))
        .filter((g) => g.files.length > 1);
      setGroups(remaining);
      const sel: Record<string, Set<string>> = {};
      for (const g of remaining) sel[keyOf(g)] = defaultRemoval(pathsOf(g));
      setSelection(sel);
      setConfirming(false);
      setDone(
        `Moved ${paths.length} ${paths.length === 1 ? "photo" : "photos"} to Trash. Restore anytime from Trash.`,
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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <ScanModePicker
          value={scanMode}
          onChange={onScanMode}
          disabled={scanning}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={chooseFolder}
            className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          >
            <IconFolder className="h-4 w-4" />
            {root ? "Change folder" : "Pick folder"}
          </button>
          <button
            type="button"
            onClick={scan}
            disabled={scanning || !root}
            className="inline-flex items-center gap-2 rounded-md bg-teal px-3.5 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            {scanning && (
              <span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white fo-spin" />
            )}
            {scanning ? "Scanning" : "Scan"}
          </button>
        </div>
      </div>

      {root && (
        <p className="font-mono text-xs text-ink-soft">
          <span className="text-ink-faint">Target </span>
          {root}
        </p>
      )}

      {progress && (
        <ScanProgress progress={progress} label="Comparing images" />
      )}

      {stopped && (
        <StoppedNotice>
          {groups && groups.length > 0
            ? "You stopped this scan. These are only the sets it had compared by then, so there may be more look-alikes in that folder."
            : "You stopped this scan before it found any look-alikes. Scan again to compare the whole folder."}
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
          <p className="text-sm font-medium text-ink">No look-alikes found</p>
          <p className="mt-1 text-sm text-ink-soft">
            Every image in that folder looks distinct.
          </p>
        </div>
      )}

      {groups && groups.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft">
            <span>
              <span className="font-semibold text-ink">{groups.length}</span>{" "}
              {groups.length === 1 ? "set" : "sets"} of look-alike photos
            </span>
            {stopped && (
              <span className="rounded-[3px] border border-ochre/40 bg-ochre-soft px-1.5 py-0.5 text-xs font-medium text-ochre">
                Partial list
              </span>
            )}
          </div>

          <ResultFilters filter={filter} unit="sets" />

          {(filter.filtered?.length ?? 0) === 0 && (
            <NoFilterMatch filter={filter} unit="sets" />
          )}

          <div className="space-y-4">
            {(filter.filtered ?? []).map((g) => {
              const sel = selection[keyOf(g)] ?? new Set<string>();
              const keeping = g.files.length - sel.size;
              return (
                <div
                  key={keyOf(g)}
                  className="rounded-lg border border-line bg-surface"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Stack n={g.files.length} />
                      <div>
                        <div className="text-sm font-medium text-ink">
                          {g.files.length} photos look alike
                        </div>
                        <div className="text-xs text-ink-faint">
                          looks alike (distance{" "}
                          <span className="font-mono text-ink-soft">
                            {g.distance}
                          </span>
                          )
                        </div>
                      </div>
                    </div>
                    <div className="text-right text-xs text-ink-soft">
                      Keep{" "}
                      <span className="font-semibold text-ink">{keeping}</span>,
                      remove{" "}
                      <span className="font-semibold text-brick">
                        {sel.size}
                      </span>
                    </div>
                  </div>
                  <ul>
                    {pathsOf(g).map((p) => {
                      const remove = sel.has(p);
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
                            className="flex items-center gap-2 border-b border-line/60 px-4 py-2.5 last:border-b-0 hover:bg-surface-2/50"
                          >
                            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
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
                                  onChange={() => toggle(keyOf(g), p)}
                                  aria-label={`Remove ${name}`}
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
                            </label>
                            <span
                              className={
                                "shrink-0 text-xs " +
                                (remove ? "text-brick" : "text-teal")
                              }
                            >
                              {remove ? "Remove" : "Keep"}
                            </span>
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
        </>
      )}

      {summary.count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur md:left-56">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
            {confirming ? (
              <>
                <span className="text-sm text-ink">
                  Move {summary.count}{" "}
                  {summary.count === 1 ? "photo" : "photos"} to Trash? You can
                  restore them later.
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
                    {summary.count}
                  </span>{" "}
                  selected to remove
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
