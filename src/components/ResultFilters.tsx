import { useCallback, useEffect, useMemo, useState } from "react";
import { useResultMinMb } from "../store";
import { IconSearch, IconX } from "./icons";

// Narrowing what is on screen, over results that are already loaded. It never
// touches the selection: a file hidden here keeps whatever the user picked,
// which is why the views report what the filter is covering up.
export type GroupFilter<T> = {
  text: string;
  setText: (v: string) => void;
  // null is "every extension". Files with no extension are their own choice, so
  // the empty string has to stay a real value here.
  ext: string | null;
  setExt: (v: string | null) => void;
  // The debounced text the list is actually filtered by, so a fast typist does
  // not re-filter thousands of groups on every keystroke.
  query: string;
  // Smallest file the list shows, in MB. 0 shows every size.
  minMb: number;
  setMinMb: (v: number) => void;
  // False when the results carry no sizes, which hides the size control rather
  // than offering one that cannot answer.
  hasSize: boolean;
  active: boolean;
  clear: () => void;
  exts: { ext: string; count: number }[];
  filtered: T[] | null;
  total: number;
  shown: number;
  // Whether one file survived the filter. Sets can now be shown with some of
  // their files held back, so the views count by path and not by group.
  shows: (path: string) => boolean;
};

// Whole steps rather than a free number: the point is to skip past the small
// stuff, and nobody needs a 37 MB floor.
const SIZE_STEPS: { mb: number; label: string }[] = [
  { mb: 0, label: "Any size" },
  { mb: 1, label: "Over 1 MB" },
  { mb: 10, label: "Over 10 MB" },
  { mb: 100, label: "Over 100 MB" },
  { mb: 1024, label: "Over 1 GB" },
];

function sizeLabel(mb: number): string {
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;
}

function extOf(path: string): string {
  const name = path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1,
  );
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// pathsOf and the two size accessors have to be stable across renders, so
// define them outside the component. sizesOf answers in the same order as
// pathsOf; keepOnly rebuilds a group from the files that survived.
export function useGroupFilter<T>(
  groups: T[] | null,
  pathsOf: (g: T) => string[],
  sizesOf?: (g: T) => number[],
  keepOnly?: (g: T, paths: Set<string>) => T,
): GroupFilter<T> {
  const [text, setText] = useState("");
  const [ext, setExt] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [minMb, setMinMb] = useResultMinMb();
  const hasSize = sizesOf != null && keepOnly != null;
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim().toLowerCase()), 220);
    return () => clearTimeout(t);
  }, [text]);
  // Only the extensions actually sitting in these results, so the choice can
  // never come back empty.
  const exts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of groups ?? []) {
      const seen = new Set(pathsOf(g).map(extOf));
      for (const e of seen) counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([e, count]) => ({ ext: e, count }))
      .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
  }, [groups, pathsOf]);
  const floor = hasSize && minMb > 0 ? minMb * 1024 * 1024 : 0;
  const active = query !== "" || ext !== null || floor > 0;
  // Size runs first and can shrink a set: a set left holding one file is not a
  // duplicate set, so it leaves the list entirely. Name and extension then read
  // the files that are still standing.
  const filtered = useMemo(() => {
    if (!groups || !active) return groups;
    const out: T[] = [];
    for (const g of groups) {
      let group = g;
      if (floor > 0 && sizesOf && keepOnly) {
        const all = pathsOf(g);
        const sizes = sizesOf(g);
        const keep = new Set(all.filter((_, i) => (sizes[i] ?? 0) >= floor));
        if (keep.size < 2) continue;
        if (keep.size < all.length) group = keepOnly(g, keep);
      }
      const paths = pathsOf(group);
      if (query && !paths.some((p) => p.toLowerCase().includes(query)))
        continue;
      if (ext !== null && !paths.some((p) => extOf(p) === ext)) continue;
      out.push(group);
    }
    return out;
  }, [groups, pathsOf, sizesOf, keepOnly, query, ext, floor, active]);
  const visible = useMemo(() => {
    if (!active) return null;
    const s = new Set<string>();
    for (const g of filtered ?? []) for (const p of pathsOf(g)) s.add(p);
    return s;
  }, [filtered, pathsOf, active]);
  const shows = useCallback(
    (path: string) => visible === null || visible.has(path),
    [visible],
  );
  return {
    text,
    setText,
    ext,
    setExt,
    query,
    minMb,
    setMinMb,
    hasSize,
    active,
    clear: () => {
      setText("");
      setQuery("");
      setExt(null);
      setMinMb(0);
    },
    exts,
    filtered,
    total: groups?.length ?? 0,
    shown: filtered?.length ?? 0,
    shows,
  };
}

function extLabel(ext: string): string {
  return ext === "" ? "no extension" : `.${ext}`;
}

const selectClass =
  "rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-teal focus-visible:ring-2 focus-visible:ring-teal/30";

export default function ResultFilters<T>({
  filter,
  unit,
}: {
  filter: GroupFilter<T>;
  unit: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface px-4 py-2.5">
      <div className="relative min-w-0 flex-1 basis-52">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
        <input
          value={filter.text}
          onChange={(e) => filter.setText(e.target.value)}
          placeholder="Name contains"
          aria-label="Filter by name or path"
          className="w-full rounded-md border border-line bg-surface py-1.5 pl-9 pr-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-teal focus-visible:ring-2 focus-visible:ring-teal/30"
        />
      </div>
      <select
        value={
          filter.ext === null
            ? ""
            : String(filter.exts.findIndex((e) => e.ext === filter.ext))
        }
        onChange={(e) =>
          filter.setExt(
            e.target.value === ""
              ? null
              : (filter.exts[Number(e.target.value)]?.ext ?? null),
          )
        }
        aria-label="Filter by extension"
        className={selectClass}
      >
        <option value="">All extensions</option>
        {filter.exts.map((e, i) => (
          <option key={e.ext} value={i}>
            {extLabel(e.ext)} ({e.count.toLocaleString()})
          </option>
        ))}
      </select>
      {filter.hasSize && (
        <select
          value={String(filter.minMb)}
          onChange={(e) => filter.setMinMb(Number(e.target.value))}
          aria-label="Show only files over this size"
          className={selectClass}
        >
          {SIZE_STEPS.map((s) => (
            <option key={s.mb} value={s.mb}>
              {s.label}
            </option>
          ))}
        </select>
      )}
      <p className="text-xs text-ink-soft" aria-live="polite">
        {filter.active ? (
          <>
            <span className="font-mono text-ink">
              {filter.shown.toLocaleString()}
            </span>{" "}
            of{" "}
            <span className="font-mono text-ink">
              {filter.total.toLocaleString()}
            </span>{" "}
            {unit}
          </>
        ) : (
          <>
            <span className="font-mono text-ink">
              {filter.total.toLocaleString()}
            </span>{" "}
            {unit}
          </>
        )}
      </p>
      {filter.active && (
        <button
          type="button"
          onClick={filter.clear}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        >
          <IconX className="h-3.5 w-3.5" />
          Clear filter
        </button>
      )}
    </div>
  );
}

// What the list turns into when the filter excludes everything. The way out is
// the point, so the button repeats the one in the filter row.
export function NoFilterMatch<T>({
  filter,
  unit,
}: {
  filter: GroupFilter<T>;
  unit: string;
}) {
  // Only the values the user chose are set in mono, the sentence around them
  // stays prose.
  const clauses: React.ReactNode[] = [];
  if (filter.minMb > 0)
    clauses.push(
      <>
        over{" "}
        <span className="font-mono text-ink">{sizeLabel(filter.minMb)}</span>
      </>,
    );
  if (filter.query)
    clauses.push(
      <>
        with <span className="font-mono text-ink">{filter.query}</span> in the
        path
      </>,
    );
  if (filter.ext !== null)
    clauses.push(
      <>
        ending in{" "}
        <span className="font-mono text-ink">{extLabel(filter.ext)}</span>
      </>,
    );
  return (
    <div className="rounded-lg border border-line bg-surface px-6 py-14 text-center">
      <p className="text-sm font-medium text-ink">
        Nothing matches this filter
      </p>
      <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-ink-soft">
        None of the {filter.total.toLocaleString()} {unit} keep{" "}
        {filter.minMb > 0 ? "two files" : "a file"}{" "}
        {clauses.map((c, i) => (
          <span key={i}>
            {i > 0 && " and "}
            {c}
          </span>
        ))}
        . Your selection is untouched.
      </p>
      <button
        type="button"
        onClick={filter.clear}
        className="mt-4 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
      >
        Clear filter
      </button>
    </div>
  );
}
