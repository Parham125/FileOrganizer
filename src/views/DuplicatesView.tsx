import { useEffect, useMemo, useState } from "react";
import { invoke, listen, pickFolder } from "../bridge";
import { formatSize } from "../format";
import type { DupGroup, HashAlgo, Progress } from "../types";
import PageHeader from "../components/PageHeader";
import ProgressBar from "../components/ProgressBar";
import { IconCheck, IconFolder } from "../components/icons";

function shortestPath(paths: string[]): string {
  return [...paths].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

// Selected == the copies to remove. Default keeps the shortest path and
// preselects every other copy for the trash.
function defaultRemoval(g: DupGroup): Set<string> {
  const keep = shortestPath(g.paths);
  return new Set(g.paths.filter((p) => p !== keep));
}

export default function DuplicatesView({ algo }: { algo: HashAlgo }) {
  const [root, setRoot] = useState<string | null>(null);
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [selection, setSelection] = useState<Record<string, Set<string>>>({});
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    const un = listen<Progress>("dedup:progress", (p) => setProgress(p));
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
    setScanning(true);
    setProgress({ done: 0, total: 0 });
    setGroups(null);
    try {
      const res = await invoke<DupGroup[]>("scan_duplicates", { root, algo });
      setGroups(res);
      const sel: Record<string, Set<string>> = {};
      for (const g of res) sel[g.hash] = defaultRemoval(g);
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

  const summary = useMemo(() => {
    let count = 0;
    let bytes = 0;
    let invalid = 0;
    for (const g of groups ?? []) {
      const rm = selection[g.hash]?.size ?? 0;
      if (rm >= g.paths.length) invalid++;
      count += rm;
      bytes += rm * g.size;
    }
    return { count, bytes, invalid };
  }, [groups, selection]);

  const wasted = useMemo(
    () => (groups ?? []).reduce((s, g) => s + g.size * (g.paths.length - 1), 0),
    [groups],
  );

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
      const sel: Record<string, Set<string>> = {};
      for (const g of remaining) sel[g.hash] = defaultRemoval(g);
      setSelection(sel);
      setConfirming(false);
      setDone(
        `Moved ${paths.length} ${paths.length === 1 ? "file" : "files"} to Trash and reclaimed ${formatSize(summary.bytes)}. Restore anytime from Trash.`,
      );
    } catch (e) {
      setError(`Could not move files: ${e instanceof Error ? e.message : String(e)}`);
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-6 pb-28">
      <PageHeader
        title="Duplicates"
        subtitle={`Find identical files by content hash, then clear the extra copies. Hashing with ${algo === "blake3" ? "BLAKE3" : "SHA-256"}, set in Settings.`}
        actions={
          <div className="flex items-center gap-2">
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
        }
      />

      {root && (
        <p className="font-mono text-xs text-ink-soft">
          <span className="text-ink-faint">Target </span>
          {root}
        </p>
      )}

      {progress && (
        <div className="rounded-lg border border-line bg-surface p-4">
          <ProgressBar progress={progress} label="Hashing files" />
        </div>
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

      {groups && groups.length === 0 && !done && (
        <div className="rounded-lg border border-line bg-surface px-6 py-16 text-center">
          <p className="text-sm font-medium text-ink">No duplicates found</p>
          <p className="mt-1 text-sm text-ink-soft">
            Every file in that folder is already unique.
          </p>
        </div>
      )}

      {groups && groups.length > 0 && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <span className="text-ink-soft">
              <span className="font-semibold text-ink">{groups.length}</span>{" "}
              duplicate {groups.length === 1 ? "set" : "sets"}
            </span>
            <span className="text-ink-soft">
              <span className="font-mono font-semibold text-ochre">
                {formatSize(wasted)}
              </span>{" "}
              can be reclaimed
            </span>
          </div>

          <div className="space-y-4">
            {groups.map((g) => {
              const sel = selection[g.hash] ?? new Set<string>();
              const keeping = g.paths.length - sel.size;
              return (
                <div
                  key={g.hash}
                  className="rounded-lg border border-line bg-surface"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Stack n={g.paths.length} />
                      <div>
                        <div className="text-sm font-medium text-ink">
                          {g.paths.length} identical copies, {formatSize(g.size)}{" "}
                          each
                        </div>
                        <div className="font-mono text-xs text-ink-faint">
                          {g.hash}
                        </div>
                      </div>
                    </div>
                    <div className="text-right text-xs">
                      <div className="text-ink-soft">
                        Keep <span className="font-semibold text-ink">{keeping}</span>,
                        remove{" "}
                        <span className="font-semibold text-brick">{sel.size}</span>
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
        </>
      )}

      {summary.count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur md:left-56">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
            {confirming ? (
              <>
                <span className="text-sm text-ink">
                  Move {summary.count} {summary.count === 1 ? "file" : "files"} to
                  Trash and reclaim{" "}
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
                  <span className="font-semibold text-ink">{summary.count}</span>{" "}
                  selected to remove,{" "}
                  <span className="font-mono text-ochre">
                    {formatSize(summary.bytes)}
                  </span>{" "}
                  reclaimed
                  {summary.invalid > 0 && (
                    <span className="text-brick">
                      {" "}
                      · {summary.invalid} set{summary.invalid === 1 ? "" : "s"} would
                      keep no copy
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

function Stack({ n }: { n: number }) {
  const layers = Math.min(n, 3);
  return (
    <span className="relative block h-9 w-9 shrink-0">
      {Array.from({ length: layers }).map((_, i) => (
        <span
          key={i}
          className={
            "absolute h-7 w-6 rounded-[3px] border " +
            (i === layers - 1
              ? "border-teal-line bg-teal-soft"
              : "border-line-strong bg-surface-2")
          }
          style={{ left: i * 4, top: i * 3, zIndex: i }}
        />
      ))}
    </span>
  );
}
