import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "../bridge";
import { formatRelative, formatSize } from "../format";
import type { RootStatus, StorageStats, TrashOutcome } from "../types";
import PageHeader from "../components/PageHeader";
import RevealButton from "../components/FileActions";
import SortPicker, { sorted, useSort } from "../components/SortPicker";
import type { SortOption } from "../components/SortPicker";
import { IconCheck, IconRestore, IconTrash } from "../components/icons";

type ExtSort = "size" | "count" | "ext";

const EXT_SORTS: SortOption<ExtSort>[] = [
  { value: "size", label: "Total size", naturalDir: "desc" },
  { value: "count", label: "File count", naturalDir: "desc" },
  { value: "ext", label: "Extension", naturalDir: "asc" },
];

type BigSort = "size" | "name" | "modified";

const BIG_SORTS: SortOption<BigSort>[] = [
  { value: "size", label: "Size", naturalDir: "desc" },
  { value: "name", label: "Name", naturalDir: "asc" },
  { value: "modified", label: "Date modified", naturalDir: "desc" },
];

export default function InsightsView() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [away, setAway] = useState<RootStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [outcome, setOutcome] = useState<TrashOutcome | null>(null);
  const extSort = useSort<ExtSort>("insights-ext", EXT_SORTS, "size");
  const bigSort = useSort<BigSort>("insights-largest", BIG_SORTS, "size");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStats(await invoke<StorageStats>("storage_stats"));
      // These totals are read from the index, which keeps every row of a drive
      // that is currently unplugged. Saying so is the difference between a
      // number the reader can act on and one they cannot.
      setAway(
        (
          await invoke<RootStatus[]>("indexed_roots_status").catch(
            () => [] as RootStatus[],
          )
        ).filter((r) => !r.available),
      );
      setError("");
    } catch (e) {
      setError(
        `Could not read storage stats: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Drop any selected path that is no longer among the biggest files.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set((stats?.largest ?? []).map((h) => h.path));
      const next = new Set([...prev].filter((p) => live.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [stats]);

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
      const res = await invoke<TrashOutcome>("trash_files", {
        paths,
        reason: "manual",
      });
      setOutcome(res);
      // Only what reached the quarantine leaves the selection. A skipped file is
      // still on disk taking up the same space, so it stays listed and ticked.
      const moved = new Set(res.moved);
      setSelected((prev) => new Set([...prev].filter((p) => !moved.has(p))));
      if (res.moved.length > 0) await load();
    } catch (e) {
      setError(
        `Could not move files: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Both lists arrive already cut to a top N by the backend, so reordering only
  // shuffles what is on screen and never brings a new row into it. A file the
  // index has no timestamp for sorts as the oldest, which keeps the unknowns
  // together at one end rather than spread through real dates.
  const byExt = useMemo(
    () =>
      sorted(
        stats?.by_ext ?? [],
        (e) =>
          extSort.key === "size"
            ? e.total_size
            : extSort.key === "count"
              ? e.count
              : e.ext,
        extSort.dir,
      ),
    [stats, extSort.key, extSort.dir],
  );
  const largest = useMemo(
    () =>
      sorted(
        stats?.largest ?? [],
        (h) =>
          bigSort.key === "size"
            ? h.size
            : bigSort.key === "name"
              ? h.name
              : (h.modified_ns ?? 0),
        bigSort.dir,
      ),
    [stats, bigSort.key, bigSort.dir],
  );

  const empty = stats !== null && stats.files === 0;
  const maxExt =
    stats?.by_ext.reduce((m, e) => Math.max(m, e.total_size), 0) ?? 0;
  const largestSum = stats?.largest.reduce((s, h) => s + h.size, 0) ?? 0;
  const largestShare =
    stats && stats.total_size > 0
      ? Math.round((largestSum / stats.total_size) * 100)
      : 0;
  const [heroNum, heroUnit] = formatSize(stats?.total_size ?? 0).split(" ");

  return (
    <div
      className={
        "space-y-7" + (outcome ? " pb-64" : selected.size > 0 ? " pb-24" : "")
      }
    >
      <PageHeader
        title="Insights"
        subtitle="See what is taking up space across every folder you have indexed."
        actions={
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-line-strong disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          >
            {loading ? (
              <span className="h-4 w-4 rounded-full border-2 border-line-strong border-t-ink-soft fo-spin" />
            ) : (
              <IconRestore className="h-4 w-4" />
            )}
            Refresh
          </button>
        }
      />

      {error && (
        <div className="rounded-md border border-brick/40 bg-brick-soft px-3.5 py-2.5 text-sm text-brick">
          {error}
        </div>
      )}

      {!stats && loading && (
        <p className="text-sm text-ink-soft">Reading the index</p>
      )}

      {empty && (
        <div className="rounded-lg border border-line bg-surface px-6 py-16 text-center">
          <p className="text-sm font-medium text-ink">Nothing indexed yet</p>
          <p className="mx-auto mt-1 max-w-xs text-sm text-ink-soft">
            Open Search and add a folder. Once it is indexed, your storage
            breakdown shows up here.
          </p>
        </div>
      )}

      {stats && !empty && (
        <>
          <div className="border-b border-line pb-7">
            <div className="flex items-baseline gap-2 font-mono font-semibold tracking-tight text-ink">
              <span className="text-[2.6rem] leading-none sm:text-[3.25rem]">
                {heroNum}
              </span>
              <span className="text-xl text-ink-soft sm:text-2xl">
                {heroUnit}
              </span>
            </div>
            <p className="mt-3.5 max-w-lg text-sm leading-relaxed text-ink-soft">
              across{" "}
              <span className="font-mono font-medium tabular-nums text-ink">
                {stats.files.toLocaleString()}
              </span>{" "}
              indexed files. The {stats.largest.length} biggest hold{" "}
              <span className="font-mono font-medium text-ochre">
                {largestShare}%
              </span>{" "}
              of that.
            </p>
            {away.length > 0 && (
              <p className="mt-2.5 max-w-lg text-sm leading-relaxed text-ink-soft">
                Counts{" "}
                <span className="font-mono font-medium tabular-nums text-ink">
                  {away.reduce((s, r) => s + r.file_count, 0).toLocaleString()}
                </span>{" "}
                files on{" "}
                {away.length === 1
                  ? "a drive that is"
                  : `${away.length} drives that are`}{" "}
                not connected right now, so that space cannot be reclaimed until{" "}
                {away.length === 1 ? "it is" : "they are"} plugged back in.
              </p>
            )}
          </div>

          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="text-[15px] font-semibold tracking-tight text-ink">
                Size by type
              </h2>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <p className="text-xs text-ink-soft">
                  Top {stats.by_ext.length} extensions by space used
                </p>
                <SortPicker sort={extSort} />
              </div>
            </div>
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              <div className="grid grid-cols-[2.75rem_1fr_4.25rem] items-center gap-x-3 border-b border-line px-4 py-2 text-xs text-ink-faint sm:grid-cols-[2.75rem_1fr_4.25rem_4rem]">
                <span>Type</span>
                <span aria-hidden="true" />
                <span className="text-right">Size</span>
                <span className="hidden text-right sm:block">Files</span>
              </div>
              {byExt.map((e) => {
                const share = Math.round(
                  (e.total_size / stats.total_size) * 100,
                );
                const width = maxExt > 0 ? (e.total_size / maxExt) * 100 : 0;
                return (
                  <div
                    key={e.ext}
                    title={`${e.ext}: ${formatSize(e.total_size)} across ${e.count.toLocaleString()} files, ${share}% of indexed size`}
                    className="grid grid-cols-[2.75rem_1fr_4.25rem] items-center gap-x-3 border-b border-line/60 px-4 py-2.5 transition-colors last:border-b-0 hover:bg-surface-2/40 sm:grid-cols-[2.75rem_1fr_4.25rem_4rem]"
                  >
                    <span className="truncate font-mono text-xs font-medium text-ink">
                      {e.ext}
                    </span>
                    <span className="block h-2.5 w-full rounded-[3px] bg-surface-2">
                      <span
                        className="block h-full rounded-[3px] bg-ochre"
                        style={{ width: `${Math.max(width, 1.5)}%` }}
                      />
                    </span>
                    <span className="text-right font-mono text-xs tabular-nums text-ink">
                      {formatSize(e.total_size)}
                    </span>
                    <span className="hidden text-right font-mono text-xs tabular-nums text-ink-soft sm:block">
                      {e.count.toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="text-[15px] font-semibold tracking-tight text-ink">
                Biggest files
              </h2>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <p className="text-xs text-ink-soft">
                  <span className="font-mono text-ink">
                    {formatSize(largestSum)}
                  </span>{" "}
                  in {stats.largest.length} files
                </p>
                <SortPicker sort={bigSort} />
              </div>
            </div>
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              {largest.map((h) => {
                const isSel = selected.has(h.path);
                return (
                  <div
                    key={h.path}
                    onDoubleClick={() => open(h.path)}
                    className={
                      "group flex items-center gap-3 border-b border-line/70 px-4 py-2.5 last:border-b-0 " +
                      (isSel ? "bg-teal-soft/60" : "hover:bg-surface-2/40")
                    }
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
                    <RevealButton
                      name={h.name}
                      onReveal={() => reveal(h.path)}
                    />
                    <div className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-ink">
                      {formatSize(h.size)}
                    </div>
                    <div className="hidden w-24 shrink-0 text-right text-xs text-ink-soft sm:block">
                      {formatRelative(h.modified_ns)}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {/* The outcome rides with the selection bar rather than the top of the
          page, because the button that caused it is down here. */}
      {(outcome || selected.size > 0) && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface md:left-56">
          {outcome && (
            <div
              className={
                "border-b px-4 py-3 " +
                (outcome.moved.length === 0
                  ? "border-brick/40 bg-brick-soft"
                  : outcome.skipped.length > 0
                    ? "border-ochre/40 bg-ochre-soft"
                    : "border-teal-line bg-teal-soft")
              }
            >
              <div className="mx-auto max-w-3xl">
                <div className="flex items-start justify-between gap-3">
                  <p
                    className={
                      "text-sm " +
                      (outcome.moved.length === 0
                        ? "text-brick"
                        : outcome.skipped.length > 0
                          ? "text-ochre"
                          : "text-teal")
                    }
                  >
                    {outcome.moved.length === 0
                      ? `Nothing was moved, so no space was freed. ${outcome.skipped.length} ${outcome.skipped.length === 1 ? "file is" : "files are"} still on your disk.`
                      : outcome.skipped.length > 0
                        ? `Moved ${outcome.moved.length} ${outcome.moved.length === 1 ? "file" : "files"} to Trash. ${outcome.skipped.length} stayed put and ${outcome.skipped.length === 1 ? "is" : "are"} still selected, so you can try again.`
                        : `Moved ${outcome.moved.length} ${outcome.moved.length === 1 ? "file" : "files"} to Trash.`}
                  </p>
                  <button
                    type="button"
                    onClick={() => setOutcome(null)}
                    className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-ink-soft transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                  >
                    Dismiss
                  </button>
                </div>
                {outcome.skipped.length > 0 && (
                  <ul className="mt-2 max-h-28 space-y-1.5 overflow-auto">
                    {outcome.skipped.map((s) => (
                      <li key={s.path} className="text-xs">
                        <span className="block truncate font-mono text-ink">
                          {s.path}
                        </span>
                        <span className="block text-ink-soft">{s.reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          {selected.size > 0 && (
            <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-3">
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
          )}
        </div>
      )}
    </div>
  );
}
