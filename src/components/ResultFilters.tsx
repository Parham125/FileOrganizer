import { useEffect, useMemo, useState } from "react";
import { IconSearch, IconX } from "./icons";

// Narrowing what is on screen, over results that are already loaded. It never
// touches the selection: a group hidden here keeps every file the user picked,
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
  active: boolean;
  clear: () => void;
  exts: { ext: string; count: number }[];
  filtered: T[] | null;
  total: number;
  shown: number;
};

function extOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// pathsOf has to be stable across renders, so define it outside the component.
export function useGroupFilter<T>(
  groups: T[] | null,
  pathsOf: (g: T) => string[],
): GroupFilter<T> {
  const [text, setText] = useState("");
  const [ext, setExt] = useState<string | null>(null);
  const [query, setQuery] = useState("");
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
  const active = query !== "" || ext !== null;
  const filtered = useMemo(() => {
    if (!groups || !active) return groups;
    return groups.filter((g) => {
      const paths = pathsOf(g);
      if (query && !paths.some((p) => p.toLowerCase().includes(query)))
        return false;
      if (ext !== null && !paths.some((p) => extOf(p) === ext)) return false;
      return true;
    });
  }, [groups, pathsOf, query, ext, active]);
  return {
    text,
    setText,
    ext,
    setExt,
    query,
    active,
    clear: () => {
      setText("");
      setQuery("");
      setExt(null);
    },
    exts,
    filtered,
    total: groups?.length ?? 0,
    shown: filtered?.length ?? 0,
  };
}

function extLabel(ext: string): string {
  return ext === "" ? "no extension" : `.${ext}`;
}

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
        className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-teal focus-visible:ring-2 focus-visible:ring-teal/30"
      >
        <option value="">All extensions</option>
        {filter.exts.map((e, i) => (
          <option key={e.ext} value={i}>
            {extLabel(e.ext)} ({e.count.toLocaleString()})
          </option>
        ))}
      </select>
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
  return (
    <div className="rounded-lg border border-line bg-surface px-6 py-14 text-center">
      <p className="text-sm font-medium text-ink">
        Nothing matches this filter
      </p>
      <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-ink-soft">
        None of the {filter.total.toLocaleString()} {unit} hold a file
        {filter.query && (
          <>
            {" "}
            with <span className="font-mono text-ink">{filter.query}</span> in
            its path
          </>
        )}
        {filter.query && filter.ext !== null && " and"}
        {filter.ext !== null && (
          <>
            {" "}
            ending in{" "}
            <span className="font-mono text-ink">{extLabel(filter.ext)}</span>
          </>
        )}
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
