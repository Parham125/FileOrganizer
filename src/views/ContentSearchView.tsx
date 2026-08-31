import { useEffect, useRef, useState } from "react";
import { invoke, listen, pickFolder } from "../bridge";
import type { ContentHit, IndexResult, Progress } from "../types";
import ScanProgress from "../components/ScanProgress";
import StoppedNotice from "../components/StoppedNotice";
import { IconCheck, IconFolder, IconSearch } from "../components/icons";

// Snippets arrive with matched terms wrapped in square brackets, like
// "the annual [budget] was". Render those spans emphasized and drop the
// literal brackets so the reader never sees them.
function renderSnippet(snippet: string) {
  const out: React.ReactNode[] = [];
  const re = /\[([^\]]+)\]/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > last) out.push(snippet.slice(last, m.index));
    out.push(
      <mark
        key={key++}
        className="rounded-[2px] bg-teal-soft px-0.5 font-semibold text-teal"
      >
        {m[1]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (last < snippet.length) out.push(snippet.slice(last));
  return out;
}

export default function ContentSearchView() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ContentHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const [stopped, setStopped] = useState("");

  const queryRef = useRef(query);
  queryRef.current = query;
  // How far the pass got, so a stopped run can say what it actually read.
  const readRef = useRef(0);

  useEffect(() => {
    const un = listen<Progress>("content:progress", (p) => {
      readRef.current = p.done;
      setProgress(p);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  async function runSearch() {
    const q = queryRef.current.trim();
    if (count == null || !q) {
      setHits([]);
      setSearched(q.length > 0);
      return;
    }
    try {
      const res = await invoke<ContentHit[]>("search_content", {
        query: q,
        limit: 50,
      });
      setHits(res);
      setSearched(true);
      setError("");
    } catch (e) {
      setError(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  useEffect(() => {
    const t = setTimeout(runSearch, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, count]);

  async function indexContents() {
    setError("");
    setStopped("");
    const dir = await pickFolder();
    if (!dir) return;
    setIndexing(true);
    setProgress({ done: 0, total: 0 });
    readRef.current = 0;
    try {
      const res = await invoke<IndexResult>("index_content", { root: dir });
      setCount(res.count);
      if (res.cancelled)
        setStopped(
          `You stopped indexing after ${readRef.current.toLocaleString()} ${readRef.current === 1 ? "document" : "documents"}. Those are searchable now. Index the folder again to read the rest.`,
        );
    } catch (e) {
      setError(
        `Could not index contents: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setIndexing(false);
      setProgress(null);
    }
  }

  const notIndexed = count == null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          {notIndexed ? (
            <span className="text-ink-soft">
              Text inside documents is indexed separately from filenames.
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-teal-line bg-teal-soft px-2 py-0.5 text-xs font-medium text-teal">
              <IconCheck className="h-3.5 w-3.5" />
              {count.toLocaleString()} documents indexed
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={indexContents}
          disabled={indexing}
          className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-line-strong disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        >
          {indexing ? (
            <span className="h-4 w-4 rounded-full border-2 border-ink-faint/40 border-t-ink-faint fo-spin" />
          ) : (
            <IconFolder className="h-4 w-4" />
          )}
          {indexing
            ? "Indexing"
            : count == null
              ? "Index contents"
              : "Index another folder"}
        </button>
      </div>

      {progress && (
        <ScanProgress progress={progress} label="Reading documents" />
      )}

      {stopped && <StoppedNotice>{stopped}</StoppedNotice>}

      {error && (
        <div className="rounded-md border border-brick/40 bg-brick-soft px-3.5 py-2.5 text-sm text-brick">
          {error}
        </div>
      )}

      <div className="relative">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-ink-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={notIndexed}
          placeholder={
            notIndexed
              ? "Index a folder to search inside documents"
              : "Search words inside your documents"
          }
          className="w-full rounded-md border border-line bg-surface py-2.5 pl-10 pr-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-teal focus-visible:ring-2 focus-visible:ring-teal/30 disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {notIndexed ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <p className="text-sm font-medium text-ink">
              Contents not indexed yet
            </p>
            <p className="max-w-xs text-sm text-ink-soft">
              Index a folder once to read the text inside its documents. After
              that, searches run instantly.
            </p>
          </div>
        ) : hits.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <p className="text-sm font-medium text-ink">
              {searched
                ? "No matches inside your documents"
                : "Search your indexed documents"}
            </p>
            <p className="max-w-xs text-sm text-ink-soft">
              {searched
                ? "Try a different word or phrase."
                : "Type a word above to find it inside your files."}
            </p>
          </div>
        ) : (
          <ul>
            {hits.map((h) => {
              const name = h.path.slice(h.path.lastIndexOf("/") + 1);
              const dir = h.path.slice(0, h.path.lastIndexOf("/"));
              return (
                <li
                  key={h.path}
                  onDoubleClick={() =>
                    invoke("open_file", { path: h.path }).catch(() => {})
                  }
                  className="border-b border-line/70 px-4 py-3 last:border-b-0 hover:bg-surface-2/40"
                >
                  <div className="truncate text-sm font-semibold text-ink">
                    {name}
                  </div>
                  <div className="truncate font-mono text-xs text-ink-faint">
                    {dir}
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
                    {renderSnippet(h.snippet)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
