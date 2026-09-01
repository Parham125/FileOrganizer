import { useCallback } from "react";
import { useLocalStorageState } from "../store";

// Ordering for result lists. Sorting only reorders what is already on screen,
// so nothing is re-scanned and the selection is untouched, the same contract
// the filters in ResultFilters keep.

export type SortDir = "asc" | "desc";

// naturalDir is the direction that reads as "most interesting first" for this
// key, so picking a key lands on the useful order instead of alphabetical-ish
// noise the user then has to flip.
export type SortOption<K extends string> = {
  value: K;
  label: string;
  naturalDir: SortDir;
};

export type Sort<K extends string> = {
  key: K;
  dir: SortDir;
  setKey: (k: K) => void;
  toggleDir: () => void;
  options: SortOption<K>[];
};

// Stored per list, so the Duplicates order does not follow the user into
// Search where the keys mean something else.
export function useSort<K extends string>(
  storageKey: string,
  options: SortOption<K>[],
  initial: K,
): Sort<K> {
  const first = options.find((o) => o.value === initial) ?? options[0];
  const [state, setState] = useLocalStorageState<{ key: K; dir: SortDir }>(
    `fo.sort.${storageKey}`,
    { key: first.value, dir: first.naturalDir },
  );
  // A key that no longer exists (an option renamed between versions) would
  // otherwise sort by nothing at all and look like a broken control.
  const known = options.some((o) => o.value === state.key);
  const key = known ? state.key : first.value;
  const dir = known ? state.dir : first.naturalDir;
  const setKey = useCallback(
    (k: K) => {
      const opt = options.find((o) => o.value === k);
      setState({ key: k, dir: opt?.naturalDir ?? "desc" });
    },
    [options, setState],
  );
  const toggleDir = useCallback(
    () => setState({ key, dir: dir === "asc" ? "desc" : "asc" }),
    [key, dir, setState],
  );
  return { key, dir, setKey, toggleDir, options };
}

// Stable across equal values, so a second key never reshuffles rows that tie on
// the first one. Strings compare with localeCompare and numbers subtract, which
// keeps "size" and "name" in the same call.
export function sorted<T>(
  items: T[],
  value: (item: T) => number | string,
  dir: SortDir,
): T[] {
  const keyed = items.map((item, i) => ({ item, i, v: value(item) }));
  keyed.sort((a, b) => {
    let d = 0;
    if (typeof a.v === "string" || typeof b.v === "string")
      d = String(a.v).localeCompare(String(b.v), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    else d = a.v - b.v;
    if (d === 0) return a.i - b.i;
    return dir === "asc" ? d : -d;
  });
  return keyed.map((k) => k.item);
}

// Matches the control styling in ResultFilters so the two rows sit together.
const selectClass =
  "rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-teal focus-visible:ring-2 focus-visible:ring-teal/30";

export default function SortPicker<K extends string>({
  sort,
  label = "Sort by",
}: {
  sort: Sort<K>;
  label?: string;
}) {
  const dirLabel = sort.dir === "asc" ? "Ascending" : "Descending";
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-ink-soft">{label}</span>
      <select
        value={sort.key}
        onChange={(e) => sort.setKey(e.target.value as K)}
        aria-label="Sort results by"
        className={selectClass}
      >
        {sort.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={sort.toggleDir}
        aria-label={`${dirLabel} order, click to reverse`}
        title={dirLabel}
        className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={
            "h-3.5 w-3.5 transition-transform " +
            (sort.dir === "asc" ? "rotate-180" : "")
          }
          aria-hidden="true"
        >
          <path d="M12 5v14" />
          <path d="m6 13 6 6 6-6" />
        </svg>
      </button>
    </div>
  );
}
