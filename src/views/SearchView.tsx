import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke, listen, pickFolder } from "../bridge";
import { formatDate, formatSize } from "../format";
import { SMALL_PX, isImage, useThumbs } from "../thumbs";
import {
  errorText,
  exportResults,
  isChanged,
  isMissing,
  loadSnapshot,
} from "../snapshot";
import type { LoadedSnapshot, SearchPayload } from "../snapshot";
import type { IndexResult, Progress, RootStatus, SearchHit } from "../types";
import PageHeader from "../components/PageHeader";
import ScanProgress from "../components/ScanProgress";
import Segmented from "../components/Segmented";
import SnapshotBanner, {
  ChangedTag,
  ExportButton,
  MissingTag,
  OpenSavedButton,
  SnapshotNote,
} from "../components/SnapshotBanner";
import StoppedNotice from "../components/StoppedNotice";
import { ThumbSlot } from "../components/Thumb";
import RevealButton from "../components/FileActions";
import ContentSearchView from "./ContentSearchView";
import {
  IconCheck,
  IconChevron,
  IconFolder,
  IconSearch,
  IconTrash,
} from "../components/icons";

type SearchMode = "filenames" | "contents";

export default function SearchView({
  indexed,
  onIndexed,
}: {
  indexed: number;
  onIndexed: (n: number) => void;
}) {
  const [mode, setMode] = useState<SearchMode>("filenames");
  return (
    <div className="space-y-6">
      <PageHeader
        title="Search"
        subtitle={
          mode === "filenames"
            ? "Find any file across every folder you have indexed. Results update as you type."
            : "Search the text inside your documents. Index a folder once, then find any word instantly."
        }
        actions={
          <Segmented<SearchMode>
            ariaLabel="Search mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: "filenames", label: "Filenames" },
              { value: "contents", label: "Contents" },
            ]}
          />
        }
      />
      {mode === "filenames" ? (
        <FilenameSearch indexed={indexed} onIndexed={onIndexed} />
      ) : (
        <ContentSearchView />
      )}
    </div>
  );
}

const SIZE_PRESETS: { label: string; bytes: number | null }[] = [
  { label: "Any size", bytes: null },
  { label: "Over 1 MB", bytes: 1_048_576 },
  { label: "Over 10 MB", bytes: 10_485_760 },
  { label: "Over 100 MB", bytes: 104_857_600 },
];

function FilenameSearch({
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
  const [stopped, setStopped] = useState("");
  const [roots, setRoots] = useState<RootStatus[]>([]);
  const [showRoots, setShowRoots] = useState(false);
  const [confirmRoot, setConfirmRoot] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState<LoadedSnapshot | null>(null);
  const [snapHits, setSnapHits] = useState<SearchHit[]>([]);
  const [saving, setSaving] = useState(false);
  const [openBusy, setOpenBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState("");
  const parentRef = useRef<HTMLDivElement>(null);

  const stateRef = useRef({ query, ext, minIdx });
  stateRef.current = { query, ext, minIdx };
  // How far the pass got, so a stopped run can say what it actually indexed.
  const readRef = useRef(0);

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
    const un1 = listen<Progress>("index:progress", (p) => {
      readRef.current = p.done;
      setProgress(p);
    });
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
    setStopped("");
    const dir = await pickFolder();
    if (!dir) return;
    setBusy(true);
    setProgress({ done: 0, total: 0 });
    readRef.current = 0;
    try {
      const res = await invoke<IndexResult>("index_folder", { path: dir });
      // A half-indexed folder should not be watched, the watcher would keep a
      // partial picture of it fresh and look complete.
      if (!res.cancelled) await invoke("start_watch", { path: dir });
      else
        setStopped(
          `You stopped indexing after ${readRef.current.toLocaleString()} ${readRef.current === 1 ? "file" : "files"}. Those are searchable now. Add the folder again to index the rest.`,
        );
      onIndexed(res.count);
      await refreshRoots();
      await runSearch();
    } catch (e) {
      setError(
        `Could not index folder: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  // Status, not just paths: a root on an unplugged drive keeps every one of its
  // rows searchable, so the list has to say so rather than showing it as fine.
  const refreshRoots = useCallback(async () => {
    try {
      setRoots(await invoke<RootStatus[]>("indexed_roots_status"));
    } catch {
      // keep the last known list rather than blanking the panel
    }
  }, []);

  useEffect(() => {
    refreshRoots();
  }, [refreshRoots]);

  async function removeRoot(path: string) {
    setError("");
    setRemoving(path);
    try {
      const rows = await invoke<number>("remove_indexed_root", { path });
      setConfirmRoot(null);
      setNote(
        `Forgot ${rows.toLocaleString()} ${rows === 1 ? "file" : "files"} from ${path}. Nothing was deleted from your disk.`,
      );
      await refreshRoots();
      onIndexed(await invoke<number>("index_stats"));
      await runSearch();
    } catch (e) {
      setError(
        `Could not remove folder: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setRemoving(null);
    }
  }

  // What the list is actually showing: a live search, or a saved list that is
  // deliberately not being re-run underneath the reader.
  const rows = loaded ? snapHits : hits;
  const gone = (path: string) =>
    loaded != null && isMissing(loaded.checked, path);

  // Drop any selected path that fell out of the current results.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(rows.map((h) => h.path));
      const next = new Set([...prev].filter((p) => live.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  async function save() {
    setSaving(true);
    setSaveError("");
    setSaved("");
    try {
      const path = await exportResults(
        "search",
        null,
        query ? `the query "${query}"` : null,
        {
          query,
          ext,
          min_size: SIZE_PRESETS[minIdx].bytes,
          hits,
        } satisfies SearchPayload,
      );
      if (path)
        setSaved(`Saved ${hits.length.toLocaleString()} results to ${path}`);
    } catch (e) {
      setSaveError(`Nothing was saved: ${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function openSaved() {
    setOpenBusy(true);
    setSaveError("");
    setSaved("");
    try {
      const next = await loadSnapshot();
      if (!next) return;
      if (next.snap.kind !== "search") {
        setSaveError(
          "That file holds duplicate results. Open it from the Duplicates page.",
        );
        return;
      }
      setLoaded(next);
      setSnapHits((next.snap.payload as SearchPayload).hits ?? []);
      setSelected(new Set());
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setOpenBusy(false);
    }
  }

  function toggle(path: string) {
    if (gone(path)) return;
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
      setError(
        `Could not reveal file: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function open(path: string) {
    try {
      await invoke("open_file", { path });
    } catch (e) {
      setError(
        `Could not open file: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function trashSelected() {
    const paths = [...selected];
    if (paths.length === 0) return;
    try {
      await invoke<string>("trash_files", { paths, reason: "manual" });
      setSelected(new Set());
      // A saved list is not re-run, so the rows that just went are taken out of
      // it by hand rather than by searching again.
      if (loaded) {
        const removed = new Set(paths);
        setSnapHits((prev) => prev.filter((h) => !removed.has(h.path)));
      } else await runSearch();
    } catch (e) {
      setError(`Could not move files: ${errorText(e)}`);
    }
  }

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 58,
    overscan: 14,
  });
  const virtual = rowVirtualizer.getVirtualItems();
  // Only the window the virtualizer is actually drawing, so scrolling a result
  // set of thousands never asks the drive for more than a screenful at a time.
  const thumb = useThumbs(
    virtual.map((vi) => rows[vi.index]?.path ?? ""),
    SMALL_PX,
  );
  // One image anywhere in the results reserves the column on every row, so a
  // mixed list stays in one straight edge instead of stepping in and out.
  const previews = useMemo(() => rows.some((h) => isImage(h.path)), [rows]);
  const offline = roots.filter((r) => !r.available).length;

  return (
    <div className={"space-y-6" + (selected.size > 0 ? " pb-24" : "")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            setShowRoots(!showRoots);
            setConfirmRoot(null);
            setNote("");
          }}
          aria-expanded={showRoots}
          className="-ml-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        >
          <IconChevron
            className={
              "h-3.5 w-3.5 transition-transform " +
              (showRoots ? "rotate-90" : "")
            }
          />
          Indexed folders ({roots.length})
          {offline > 0 && (
            <span className="text-ochre">
              {" · "}
              {offline} not connected
            </span>
          )}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {hits.length > 0 && !loaded && (
            <ExportButton onExport={save} busy={saving} kind="search" />
          )}
          <OpenSavedButton onOpen={openSaved} busy={openBusy} />
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
        </div>
      </div>

      <SnapshotNote error={saveError} done={saved} />

      {showRoots && (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {roots.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <p className="text-sm font-medium text-ink">
                No folders indexed yet
              </p>
              <p className="mt-1 text-sm text-ink-soft">
                Add a folder to build your searchable index.
              </p>
            </div>
          ) : (
            <ul>
              {roots.map(({ path: p, available, file_count }) => (
                <li
                  key={p}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line/70 px-4 py-2.5 last:border-b-0"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-ink-soft">
                      {p}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
                      {!available && (
                        <span className="rounded-[3px] border border-ochre/40 bg-ochre-soft px-1.5 py-0.5 font-medium text-ochre">
                          Not connected
                        </span>
                      )}
                      <span>
                        <span className="font-mono tabular-nums">
                          {file_count.toLocaleString()}
                        </span>{" "}
                        {file_count === 1 ? "file" : "files"} indexed
                        {available ? "" : ", still searchable but not openable"}
                      </span>
                    </span>
                  </span>
                  {confirmRoot === p ? (
                    <div className="flex w-full flex-wrap items-center justify-end gap-2">
                      <span className="mr-auto text-xs text-ink-soft">
                        Drop this folder from the index? The files stay on your
                        disk, they only stop showing up in search.
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setConfirmRoot(null)}
                          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                        >
                          Keep folder
                        </button>
                        <button
                          type="button"
                          onClick={() => removeRoot(p)}
                          disabled={removing === p}
                          className="inline-flex items-center gap-1.5 rounded-md border border-ochre/50 bg-ochre-soft px-2.5 py-1.5 text-xs font-medium text-ochre transition-colors hover:brightness-95 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ochre"
                        >
                          {removing === p && (
                            <span className="h-3.5 w-3.5 rounded-full border-2 border-ochre/30 border-t-ochre fo-spin" />
                          )}
                          {removing === p ? "Removing" : "Remove from index"}
                        </button>
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmRoot(p);
                        setNote("");
                      }}
                      className="shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium text-ochre transition-colors hover:bg-ochre-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ochre"
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {note && (
            <p className="border-t border-line bg-surface-2/50 px-4 py-2.5 text-xs text-ink-soft">
              {note}
            </p>
          )}
        </div>
      )}

      {progress && <ScanProgress progress={progress} label="Indexing folder" />}

      {stopped && <StoppedNotice>{stopped}</StoppedNotice>}

      {error && (
        <div className="rounded-md border border-brick/40 bg-brick-soft px-3.5 py-2.5 text-sm text-brick">
          {error}
        </div>
      )}

      {/* A saved list is not something you can type into, so the banner takes
          the place of the query controls until it is closed. */}
      {loaded ? (
        <SnapshotBanner
          loaded={loaded}
          summary={`${snapHits.length.toLocaleString()} ${snapHits.length === 1 ? "result" : "results"}`}
          onClose={() => {
            setLoaded(null);
            setSnapHits([]);
            setSelected(new Set());
          }}
        />
      ) : (
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
      )}

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-xs text-ink-soft">
          <span>
            {rows.length.toLocaleString()}{" "}
            {rows.length === 1 ? "result" : "results"}
            {loaded && <span className="text-ink-faint"> as saved</span>}
          </span>
          <span className="font-mono">
            {formatSize(rows.reduce((s, h) => s + h.size, 0))} total
          </span>
        </div>
        <div ref={parentRef} className="h-[52vh] min-h-[280px] overflow-auto">
          {rows.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
              <p className="text-sm font-medium text-ink">
                {searched && (query || ext)
                  ? "No files match"
                  : "Nothing to show yet"}
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
              style={{
                height: rowVirtualizer.getTotalSize(),
                position: "relative",
              }}
            >
              {virtual.map((vi) => {
                const h = rows[vi.index];
                const isSel = selected.has(h.path);
                const lost = gone(h.path);
                return (
                  <div
                    key={vi.key}
                    onDoubleClick={() => open(h.path)}
                    className={
                      "group absolute left-0 top-0 flex w-full items-center gap-3 border-b border-line/70 px-4 " +
                      (lost
                        ? "bg-surface-2/40"
                        : isSel
                          ? "bg-teal-soft/60"
                          : "hover:bg-surface-2/40")
                    }
                    style={{
                      height: vi.size,
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    <label
                      className={
                        "flex shrink-0 items-center " +
                        (lost ? "cursor-default" : "cursor-pointer")
                      }
                    >
                      <span
                        className={
                          "grid h-4 w-4 place-items-center rounded-[3px] border transition-colors " +
                          (lost
                            ? "border-line bg-surface-2"
                            : isSel
                              ? "border-teal bg-teal text-white"
                              : "border-line-strong bg-surface")
                        }
                      >
                        <input
                          type="checkbox"
                          checked={isSel}
                          disabled={lost}
                          onChange={() => toggle(h.path)}
                          aria-label={
                            lost ? `${h.name} is missing` : `Select ${h.name}`
                          }
                          className="sr-only"
                        />
                        {isSel && !lost && <IconCheck className="h-3 w-3" />}
                      </span>
                    </label>
                    {previews && (
                      <ThumbSlot
                        path={h.path}
                        src={thumb(h.path)}
                        size="h-10 w-10"
                        dim={lost}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div
                        className={
                          "truncate text-sm font-medium " +
                          (lost ? "text-ink-faint line-through" : "text-ink")
                        }
                      >
                        {h.name}
                      </div>
                      <div className="truncate font-mono text-xs text-ink-faint">
                        {h.path}
                      </div>
                    </div>
                    {lost ? (
                      <MissingTag />
                    ) : (
                      loaded &&
                      isChanged(loaded.checked, h.path) && <ChangedTag />
                    )}
                    <RevealButton
                      name={h.name}
                      onReveal={() => reveal(h.path)}
                    />
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
