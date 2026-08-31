import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, listen, pickFolder } from "../bridge";
import { formatDate, formatSize } from "../format";
import { LARGE_PX, useThumbs } from "../thumbs";
import { errorText, exportResults, isChanged, isMissing } from "../snapshot";
import type { LoadedSnapshot, SimilarPayload } from "../snapshot";
import type {
  Progress,
  ScanMode,
  SimilarFile,
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
import { ContentCoverageNote } from "../components/CoverageNote";
import Pager from "../components/Pager";
import ScanModePicker from "../components/ScanModePicker";
import ScanProgress from "../components/ScanProgress";
import SnapshotBanner, {
  ChangedTag,
  ExportButton,
  MissingTag,
  OpenSavedButton,
  SnapshotNote,
} from "../components/SnapshotBanner";
import Stack from "../components/Stack";
import StoppedNotice from "../components/StoppedNotice";
import Thumb from "../components/Thumb";
import { IconCheck, IconFolder } from "../components/icons";

// Each set is a grid of previews rather than a list, so a page holds far fewer
// sets than the paged text lists do. It is also the ceiling on how many
// thumbnails the app ever asks a slow drive for at once.
const PER_PAGE = 12;

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

// Selected == the copies to remove. Default keeps the shortest path still on
// disk and preselects every other look-alike for the trash. A file a snapshot
// says is gone is never preselected: it is not a copy anyone can act on.
function defaultRemoval(
  paths: string[],
  gone: (path: string) => boolean,
): Set<string> {
  const live = paths.filter((p) => !gone(p));
  const keep = shortestPath(live.length > 0 ? live : paths);
  return new Set(live.filter((p) => p !== keep));
}

type Coverage = { roots: string[]; unreadable: number };

export default function SimilarImagesView({
  scanMode,
  onScanMode,
  incoming,
  onAdopted,
  onOpenSaved,
  openBusy,
}: {
  scanMode: ScanMode;
  onScanMode: (m: ScanMode) => void;
  incoming: LoadedSnapshot | null;
  onAdopted: () => void;
  onOpenSaved: () => void;
  openBusy: boolean;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [groups, setGroups] = useState<SimilarGroup[] | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [loaded, setLoaded] = useState<LoadedSnapshot | null>(null);
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<Record<string, Set<string>>>({});
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [stopped, setStopped] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  // No size accessor: the size filter is shared with the duplicate lists, where
  // a set is a set of identical files. Look-alikes differ in size on purpose,
  // and hiding the small one hides the answer.
  const filter = useGroupFilter(groups, pathsOf);
  const files = useFileActions();
  const gone = (path: string) =>
    loaded != null && isMissing(loaded.checked, path);

  useEffect(() => {
    const un = listen<Progress>("similar:progress", (p) => setProgress(p));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // A snapshot the page handed down. Adopting it replaces whatever is on screen
  // and drops the selection, because those picks were made against a live scan.
  useEffect(() => {
    if (!incoming || incoming.snap.kind !== "similar_images") return;
    const payload = incoming.snap.payload as SimilarPayload;
    const next = payload.groups ?? [];
    setLoaded(incoming);
    setGroups(next);
    setCoverage({
      roots: payload.unavailable_roots ?? [],
      unreadable: payload.unreadable_files ?? 0,
    });
    setStopped(payload.cancelled ?? false);
    setPage(0);
    setError("");
    setDone("");
    setSaved("");
    const sel: Record<string, Set<string>> = {};
    for (const g of next)
      sel[keyOf(g)] = defaultRemoval(pathsOf(g), (p) =>
        isMissing(incoming.checked, p),
      );
    setSelection(sel);
    onAdopted();
  }, [incoming, onAdopted]);

  useEffect(() => {
    setPage(0);
  }, [filter.query, filter.ext]);

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
    setSaved("");
    setSaveError("");
    setStopped(false);
    setScanning(true);
    setProgress({ done: 0, total: 0 });
    setGroups(null);
    setLoaded(null);
    setCoverage(null);
    setPage(0);
    try {
      const res = await invoke<SimilarScanResult>("scan_similar_images", {
        root,
        maxDistance: 8,
        mode: scanMode,
      });
      setGroups(res.groups);
      setCoverage({
        roots: res.unavailable_roots ?? [],
        unreadable: res.unreadable_files ?? 0,
      });
      setStopped(res.cancelled);
      const sel: Record<string, Set<string>> = {};
      for (const g of res.groups)
        sel[keyOf(g)] = defaultRemoval(pathsOf(g), () => false);
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
        "similar_images",
        root,
        "a maximum distance of 8",
        {
          groups,
          cancelled: stopped,
          unavailable_roots: coverage?.roots ?? [],
          unreadable_files: coverage?.unreadable ?? 0,
        } satisfies SimilarPayload,
      );
      if (path) setSaved(`Saved ${groups.length} sets to ${path}`);
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

  // Over every loaded set, filtered or not: hiding a set is not deselecting it,
  // so hidden reports what the filter is covering up. A set counts as invalid
  // when nothing that still exists would survive the trash.
  const summary = useMemo(() => {
    let count = 0;
    let invalid = 0;
    let hidden = 0;
    for (const g of groups ?? []) {
      const sel = selection[keyOf(g)];
      const rm = sel?.size ?? 0;
      const live = g.files.filter((f) => !gone(f.path)).length;
      if (rm > 0 && rm >= live) invalid++;
      count += rm;
      for (const p of sel ?? []) if (!filter.shows(p)) hidden++;
    }
    return { count, invalid, hidden };
  }, [groups, selection, filter.shows, loaded]);

  const listed = filter.filtered?.length ?? 0;
  const pages = Math.max(1, Math.ceil(listed / PER_PAGE));
  const from = page * PER_PAGE;
  const shown = filter.filtered
    ? filter.filtered.slice(from, from + PER_PAGE)
    : [];
  // Only the sets on this page. Nothing off screen is ever requested, and what
  // has already arrived is served from the module cache when paging back.
  const thumb = useThumbs(
    shown.flatMap((g) => g.files.map((f) => f.path)),
    LARGE_PX,
  );

  function goPage(next: number) {
    setPage(next);
    listRef.current?.scrollIntoView({ block: "start" });
  }

  async function trashSelected() {
    const paths: string[] = [];
    for (const g of groups ?? [])
      for (const p of selection[keyOf(g)] ?? []) paths.push(p);
    if (paths.length === 0) return;
    try {
      await invoke<string>("trash_files", { paths, reason: "dedup" });
      const removed = new Set(paths);
      const remaining = (groups ?? [])
        .map((g) => ({
          ...g,
          files: g.files.filter((f) => !removed.has(f.path)),
        }))
        .filter((g) => g.files.length > 1);
      setGroups(remaining);
      const sel: Record<string, Set<string>> = {};
      for (const g of remaining)
        sel[keyOf(g)] = defaultRemoval(pathsOf(g), gone);
      setSelection(sel);
      setPage((p) =>
        Math.min(p, Math.max(0, Math.ceil(remaining.length / PER_PAGE) - 1)),
      );
      setConfirming(false);
      setDone(
        `Moved ${paths.length} ${paths.length === 1 ? "photo" : "photos"} to Trash. Restore anytime from Trash.`,
      );
    } catch (e) {
      setError(`Could not move files: ${errorText(e)}`);
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
          {groups && groups.length > 0 && !loaded && (
            <ExportButton onExport={save} busy={saving} kind="similar_images" />
          )}
          <OpenSavedButton onOpen={onOpenSaved} busy={openBusy} />
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

      <SnapshotNote error={saveError} done={saved} />

      {root && !loaded && (
        <p className="font-mono text-xs text-ink-soft">
          <span className="text-ink-faint">Target </span>
          {root}
        </p>
      )}

      {progress && (
        <ScanProgress progress={progress} label="Comparing images" />
      )}

      {loaded && groups && (
        <SnapshotBanner
          loaded={loaded}
          summary={`${groups.length} ${groups.length === 1 ? "set" : "sets"}`}
          onClose={() => {
            setLoaded(null);
            setGroups(null);
            setSelection({});
            setCoverage(null);
            setStopped(false);
          }}
        />
      )}

      {stopped && (
        <StoppedNotice>
          {groups && groups.length > 0
            ? "You stopped this scan. These are only the sets it had compared by then, so there may be more look-alikes in that folder."
            : "You stopped this scan before it found any look-alikes. Scan again to compare the whole folder."}
        </StoppedNotice>
      )}

      {coverage && !loaded && (
        <ContentCoverageNote
          roots={coverage.roots}
          unreadable={coverage.unreadable}
          noun="look-alike set"
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
                  const sel = selection[keyOf(g)] ?? new Set<string>();
                  const missing = g.files.filter((f) => gone(f.path)).length;
                  const keeping = g.files.length - sel.size - missing;
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
                              {missing > 0 && (
                                <span className="text-ochre">
                                  {" "}
                                  · {missing} missing
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="text-right text-xs text-ink-soft">
                          Keep{" "}
                          <span className="font-semibold text-ink">
                            {keeping}
                          </span>
                          , remove{" "}
                          <span className="font-semibold text-brick">
                            {sel.size}
                          </span>
                        </div>
                      </div>
                      {/* 140px keeps two copies side by side at 360px wide,
                          which is the whole point of laying them out as a
                          grid instead of a list. */}
                      <ul className="grid gap-3 p-3 [grid-template-columns:repeat(auto-fill,minmax(140px,1fr))]">
                        {g.files.map((f) => (
                          <PhotoCard
                            key={f.path}
                            file={f}
                            src={thumb(f.path)}
                            remove={sel.has(f.path)}
                            missing={gone(f.path)}
                            changed={
                              loaded != null &&
                              isChanged(loaded.checked, f.path)
                            }
                            onToggle={() => toggle(keyOf(g), f.path)}
                            files={files}
                          />
                        ))}
                      </ul>
                    </div>
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

// One copy, as a card. The picture is the decision here, so it leads and is
// shown whole rather than cropped: a tighter crop is exactly the difference
// between two frames the reader is trying to tell apart.
function PhotoCard({
  file,
  src,
  remove,
  missing,
  changed,
  onToggle,
  files,
}: {
  file: SimilarFile;
  src: string | null | undefined;
  remove: boolean;
  missing: boolean;
  changed: boolean;
  onToggle: () => void;
  files: ReturnType<typeof useFileActions>;
}) {
  const cut = Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\"));
  const name = file.path.slice(cut + 1);
  const dir = file.path.slice(0, cut);
  // A card is narrow, and truncating the head of the path throws away the one
  // part that tells two copies apart. The folder these files sit in does that
  // in a word; the whole path stays in the tooltip.
  const folder = dir.slice(
    Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\")) + 1,
  );
  return (
    <li
      className={
        "overflow-hidden rounded-md border transition-colors " +
        (missing
          ? "border-line bg-surface-2/60"
          : remove
            ? "border-brick/60 bg-brick-soft/30"
            : "border-line bg-surface")
      }
    >
      <div className="relative">
        <Thumb
          src={src}
          fit="contain"
          className={
            "h-28 w-full border-b border-line " + (missing ? "opacity-40" : "")
          }
        />
        <span className="absolute right-1.5 top-1.5">
          {missing ? (
            <MissingTag />
          ) : (
            // Opaque, because it sits on top of a photograph. The colour is
            // carried by the text and the edge, which keeps it readable in both
            // themes rather than white on a mid-tone fill.
            <span
              className={
                "rounded-[3px] border bg-surface px-1.5 py-0.5 text-xs font-medium " +
                (remove
                  ? "border-brick/50 text-brick"
                  : "border-teal-line text-teal")
              }
            >
              {remove ? "Remove" : "Keep"}
            </span>
          )}
        </span>
      </div>
      <div
        onDoubleClick={() => files.open(file.path)}
        className="flex items-start gap-2 px-2.5 py-2"
      >
        <label
          className={
            "flex min-w-0 flex-1 items-start gap-2 " +
            (missing ? "cursor-default" : "cursor-pointer")
          }
        >
          <span
            className={
              "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[3px] border transition-colors " +
              (missing
                ? "border-line bg-surface-2"
                : remove
                  ? "border-brick bg-brick text-white"
                  : "border-line-strong bg-surface")
            }
          >
            <input
              type="checkbox"
              checked={remove}
              disabled={missing}
              onChange={onToggle}
              aria-label={missing ? `${name} is missing` : `Remove ${name}`}
              className="sr-only"
            />
            {remove && !missing && <IconCheck className="h-3 w-3" />}
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={
                "block line-clamp-2 text-xs [overflow-wrap:anywhere] " +
                (missing ? "text-ink-faint line-through" : "text-ink")
              }
              title={name}
            >
              {name}
            </span>
            <span
              className="block truncate font-mono text-[11px] text-ink-faint"
              title={file.path}
            >
              in {folder}
            </span>
            <span className="mt-1 block font-mono text-[11px] text-ink-soft">
              {formatSize(file.size)}
              {file.modified_ns ? ` · ${formatDate(file.modified_ns)}` : ""}
            </span>
            {changed && (
              <span className="mt-1 block">
                <ChangedTag />
              </span>
            )}
          </span>
        </label>
        <RevealButton
          name={name}
          onReveal={() => files.reveal(file.path)}
          className="-mr-1"
        />
      </div>
      {files.failed?.path === file.path && (
        <FileActionError message={files.failed.message} />
      )}
    </li>
  );
}
