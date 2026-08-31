// Paging over result groups. The range and the total sit next to the controls
// so the reader always knows how much of the scan they are looking at.
export default function Pager({
  page,
  pages,
  from,
  to,
  total,
  unit,
  onPage,
}: {
  page: number;
  pages: number;
  from: number;
  to: number;
  total: number;
  unit: string;
  onPage: (p: number) => void;
}) {
  const step =
    "rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:border-line-strong disabled:opacity-40 disabled:hover:border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal";
  return (
    <nav
      aria-label={`${unit} pages`}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-line bg-surface px-4 py-2.5"
    >
      <p className="text-xs text-ink-soft">
        {unit}{" "}
        <span className="font-mono text-ink">
          {from.toLocaleString()}-{to.toLocaleString()}
        </span>{" "}
        of <span className="font-mono text-ink">{total.toLocaleString()}</span>
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={page === 0}
          className={step}
        >
          Previous
        </button>
        <span className="text-xs text-ink-soft" aria-live="polite">
          Page <span className="font-mono text-ink">{page + 1}</span> of{" "}
          <span className="font-mono text-ink">{pages}</span>
        </span>
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={page >= pages - 1}
          className={step}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
