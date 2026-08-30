import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke, listen, pickFolder } from "../bridge";
import { formatDate, formatSize } from "../format";
import type { Progress, SearchHit } from "../types";
import PageHeader from "../components/PageHeader";
import ProgressBar from "../components/ProgressBar";
import {
  IconCheck,
  IconFolder,
  IconReveal,
  IconSearch,
  IconTrash,
} from "../components/icons";

const SIZE_PRESETS: { label: string; bytes: number | null }[] = [
  { label: "Any size", bytes: null },
  { label: "Over 1 MB", bytes: 1_048_576 },
  { label: "Over 10 MB", bytes: 10_485_760 },
  { label: "Over 100 MB", bytes: 104_857_600 },
];

export default function SearchView({
  indexed,
  onIndexed,
}: {
  indexed: number;
  onIndexed: (n: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [ext, setExt] = useState("");
  const [minIdx, setMinIdx] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);

  const stateRef = useRef({ query, ext, minIdx });
  stateRef.current = { query, ext, minIdx };

  const runSearch = useCallback(async () => {
    const s = stateRef.current;
    try {
      const results = await invoke<SearchHit[]>("search", {
        query: s.query,
        opts: {
          ext: s.ext.trim().replace(/^\./, "") || null,
          min_size: SIZE_PRESETS[s.minIdx].bytes,
          limit: 5000,
        },
      });
      setHits(results);
      setSearched(true);
      setError("");
    } catch (e) {
      setError(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    const un1 = listen<Progress>("index:progress", (p) => setProgress(p));
    const un2 = listen("index:changed", () => runSearch());
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
    };
  }, [runSearch]);

  useEffect(() => {
    const t = setTimeout(runSearch, 150);
    return () => clearTimeout(t);
  }, [query, ext, minIdx, runSearch]);

  async function addFolder() {
    setError("");
    const dir = await pickFolder();
    if (!dir) return;
    setBusy(true);
    setProgress({ done: 0, total: 0 });
    try {
      const total = await invoke<number>("index_folder", { path: dir });
      await invoke("start_watch", { path: dir });
      onIndexed(total);
      await runSearch();
    } catch (e) {
      setError(`Could not index folder: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  // Drop any selected path that fell out of the current results.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(hits.map((h) => h.path));
      const next = new Set([...prev].filter((p) => live.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [hits]);

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function reveal(path: string) {
    try {
      await invoke("reveal_file", { path });
    } catch (e) {
      setError(`Could not reveal file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function open(path: string) {
    try {
      await invoke("open_file", { path });
    } catch (e) {
      setError(`Could not open file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function trashSelected() {
    const paths = [...selected];
    if (paths.length === 0) return;
    try {
      await invoke<string>("trash_files", { paths, reason: "manual" });
      setSelected(new Set());
      await runSearch();
    } catch (e) {
      setError(`Could not move files: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const rowVirtualizer = useVirtualizer({
    count: hits.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 58,
    overscan: 14,
  });

  return (
    <div className={"space-y-6" + (selected.size > 0 ? " pb-24" : "")}>
      <PageHeader
        title="Search"
        subtitle="Find any file across every folder you have indexed. Results update as you type."
        actions={
          <button
            type="button"
            onClick={addFolder}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-md bg-teal px-3.5 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            {busy ? (
              <span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white fo-spin" />
            ) : (
              <IconFolder className="h-4 w-4" />
            )}
            {busy ? "Indexing" : "Add folder"}
          </button>
        }
      />

      {progress && (
        <div className="rounded-lg border border-line bg-surface p-4">
          <ProgressBar progress={progress} label="Indexing folder" />
        </div>
      )}

      {error && (
        <div className="rounded-md border border-brick/40 bg-brick-soft px-3.5 py-2.5 text-sm text-brick">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or path"
            className="w-full rounded-md border border-line bg-surface py-2.5 pl-10 pr-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-teal focus-visible:ring-2 focus-visible:ring-teal/30"
          />
        </div>
        <input
          value={ext}
          onChange={(e) => setExt(e.target.value)}
          placeholder="Extension"
          aria-label="Filter by extension"
          className="w-full rounded-md border border-line bg-surface px-3 py-2.5 font-mono text-sm text-ink outline-none placeholder:font-sans placeholder:text-ink-faint focus:border-teal focus-visible:ring-2 focus-visible:ring-teal/30 sm:w-36"
        />
        <select
          value={minIdx}
          onChange={(e) => setMinIdx(Number(e.target.value))}
          aria-label="Minimum size"
          className="w-full rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-teal focus-visible:ring-2 focus-visible:ring-teal/30 sm:w-40"
        >
          {SIZE_PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-xs text-ink-soft">
          <span>
            {hits.length.toLocaleString()} {hits.length === 1 ? "result" : "results"}
          </span>
          <span className="font-mono">
            {formatSize(hits.reduce((s, h) => s + h.size, 0))} total
          </span>
        </div>
        <div ref={parentRef} className="h-[52vh] min-h-[280px] overflow-auto">
          {hits.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
              <p className="text-sm font-medium text-ink">
                {searched && (query || ext) ? "No files match" : "Nothing to show yet"}
              </p>
              <p className="max-w-xs text-sm text-ink-soft">
                {searched && (query || ext)
                  ? "Try a shorter query or clear the filters."
                  : indexed > 0
                    ? "Start typing above to search your index."
                    : "Add a folder to build your searchable index."}
              </p>
            </div>
          ) : (
            <div
              style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}
            >
              {rowVirtualizer.getVirtualItems().map((vi) => {
                const h = hits[vi.index];
                const isSel = selected.has(h.path);
                return (
                  <div
                    key={vi.key}
                    onDoubleClick={() => open(h.path)}
                    className={
                      "group absolute left-0 top-0 flex w-full items-center gap-3 border-b border-line/70 px-4 " +
                      (isSel ? "bg-teal-soft/60" : "hover:bg-surface-2/40")
                    }
                    style={{
                      height: vi.size,
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    <label className="flex shrink-0 cursor-pointer items-center">
                      <span
                        className={
                          "grid h-4 w-4 place-items-center rounded-[3px] border transition-colors " +
                          (isSel
                            ? "border-teal bg-teal text-white"
                            : "border-line-strong bg-surface")
                        }
                      >
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggle(h.path)}
                          aria-label={`Select ${h.name}`}
                          className="sr-only"
                        />
                        {isSel && <IconCheck className="h-3 w-3" />}
                      </span>
                    </label>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink">
                        {h.name}
                      </div>
                      <div className="truncate font-mono text-xs text-ink-faint">
                        {h.path}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => reveal(h.path)}
                      aria-label={`Reveal ${h.name} in Finder`}
                      className="shrink-0 rounded-md p-1.5 text-ink-faint opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal group-hover:opacity-100"
                    >
                      <IconReveal className="h-4 w-4" />
                    </button>
                    <div className="w-20 shrink-0 text-right font-mono text-xs tabular-nums text-ink-soft">
                      {formatSize(h.size)}
                    </div>
                    <div className="hidden w-24 shrink-0 text-right text-xs text-ink-soft sm:block">
                      {formatDate(h.modified_ns)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur md:left-56">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-ink-soft">
              <span className="font-semibold text-ink">{selected.size}</span>{" "}
              {selected.size === 1 ? "file" : "files"} selected
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={trashSelected}
                className="inline-flex items-center gap-2 rounded-md bg-brick px-3.5 py-2 text-sm font-medium text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                <IconTrash className="h-4 w-4" />
                Move {selected.size} to Trash
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
