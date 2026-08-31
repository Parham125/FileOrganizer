import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, listen, pickFolder } from "../bridge";
import { formatDate, formatSize } from "../format";
import type {
  NameGroup,
  NameScanResult,
  NameStrategy,
  Progress,
  ScanMode,
} from "../types";
import Pager from "../components/Pager";
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
import Stack from "../components/Stack";
import StoppedNotice from "../components/StoppedNotice";
import { IconCheck, IconChevron, IconFolder } from "../components/icons";

const PER_PAGE = 25;

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

function keepOnly(g: NameGroup, paths: Set<string>): NameGroup {
  const files = g.files.filter((f) => paths.has(f.path));
  return {
    ...g,
    files,
    all_same_size: files.every((f) => f.size === files[0].size),
  };
}

export default function SimilarNamesView({
  scanMode,
  onScanMode,
  onExact,
}: {
  scanMode: ScanMode;
  onScanMode: (m: ScanMode) => void;
  onExact: () => void;
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
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [stopped, setStopped] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const filter = useGroupFilter(groups, pathsOf, sizesOf, keepOnly);
  const files = useFileActions();

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
  }, [filter.query, filter.ext, filter.minMb]);

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
    setStopped(false);
    setScanning(true);
    setProgress({ done: 0, total: 0 });
    setGroups(null);
    setSelection({});
    setPage(0);
    try {
      const res = await invoke<NameScanResult>("scan_similar_names", {
        root: scope === "indexed" ? null : root,
        strategy,
        mode: scanMode,
      });
      setScanned(scope);
      setGroups(res.groups);
      setGroupCount(res.group_count);
      setStopped(res.cancelled);
      // Nothing is preselected on purpose. These files only share a name, so
      // there is no copy the app can safely call redundant.
      setSelection({});
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
      if (sel.size >= g.files.length) invalid++;
      sets++;
      count += sel.size;
      for (const f of g.files) if (sel.has(f.path)) bytes += f.size;
      for (const p of sel) if (!filter.shows(p)) hidden++;
    }
    return { count, bytes, invalid, sets, hidden };
  }, [groups, selection, filter.shows]);

  const nothingIndexed = roots !== null && roots.length === 0;
  const listed = filter.filtered?.length ?? 0;
  const pages = Math.max(1, Math.ceil(listed / PER_PAGE));
  const from = page * PER_PAGE;
  const shown = filter.filtered
    ? filter.filtered.slice(from, from + PER_PAGE)
    : [];
  const media = strategy === "media";

  async function trashSelected() {
    const paths: string[] = [];
    for (const g of groups ?? [])
      for (const p of selection[keyOf(g)] ?? []) paths.push(p);
    if (paths.length === 0) return;
    const freed = summary.bytes;
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
      setGroupCount(remaining.length);
      setPage((p) =>
        Math.min(p, Math.max(0, Math.ceil(remaining.length / PER_PAGE) - 1)),
      );
      setSelection({});
      setConfirming(false);
      setDone(
        `Moved ${paths.length} ${paths.length === 1 ? "file" : "files"} to Trash and freed ${formatSize(freed)}. Restore anytime from Trash.`,
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
                {shown.map((g) => (
                  <NameGroupCard
                    key={keyOf(g)}
                    group={g}
                    selected={selection[keyOf(g)] ?? new Set<string>()}
                    onToggle={(p) => toggle(keyOf(g), p)}
                    files={files}
                  />
                ))}
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
                  Move {summary.count} {summary.count === 1 ? "file" : "files"}{" "}
                  to Trash and free{" "}
                  <span className="font-mono text-ochre">
                    {formatSize(summary.bytes)}
                  </span>
                  ? These were matched by name, so open anything you are unsure
                  about first. You can restore them later.
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

// One name set. Size is the whole judgement here, so where the files differ
// every row carries a bar drawn against the biggest file in the set.
function NameGroupCard({
  group,
  selected,
  onToggle,
  files,
}: {
  group: NameGroup;
  selected: Set<string>;
  onToggle: (path: string) => void;
  files: ReturnType<typeof useFileActions>;
}) {
  const media = group.strategy === "media";
  const largest = Math.max(...group.files.map((f) => f.size), 1);
  const smallest = Math.min(...group.files.map((f) => f.size));
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
              {group.files.length} files{" "}
              {media ? "share this title across containers" : "share this name"}
            </div>
          </div>
        </div>
        {group.all_same_size ? (
          <span className="shrink-0 text-xs text-ink-soft">
            All {formatSize(largest)}, size matches
          </span>
        ) : (
          <span className="shrink-0 rounded-[3px] border border-ochre/40 bg-ochre-soft px-1.5 py-0.5 text-xs font-medium text-ochre">
            {formatSize(smallest)} to {formatSize(largest)}
          </span>
        )}
      </div>
      <ul>
        {group.files.map((f) => {
          const remove = selected.has(f.path);
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
                className="flex items-start gap-2 border-b border-line/60 px-4 py-3 last:border-b-0 hover:bg-surface-2/50"
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                  <span
                    className={
                      "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[3px] border transition-colors " +
                      (remove
                        ? "border-brick bg-brick text-white"
                        : "border-line-strong bg-surface")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={remove}
                      onChange={() => onToggle(f.path)}
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
                  {remove && (
                    <span className="block text-xs text-brick">Remove</span>
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
