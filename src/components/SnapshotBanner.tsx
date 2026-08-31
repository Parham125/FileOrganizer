import { formatDate } from "../format";
import { KIND_LABEL } from "../snapshot";
import type { LoadedSnapshot } from "../snapshot";
import type { SnapshotKind } from "../types";
import { IconHistory } from "./icons";

// A saved list is drawn with a dashed edge for the same reason a name-matched
// set is: it is not something the app can vouch for right now. The date and the
// scope lead, because a scan worth reopening is usually one that took hours and
// the first question is always how old it is.
export default function SnapshotBanner({
  loaded,
  summary,
  onClose,
}: {
  loaded: LoadedSnapshot;
  summary: string;
  onClose: () => void;
}) {
  const { snap, checked } = loaded;
  const kind = (
    KIND_LABEL[snap.kind as SnapshotKind] ?? snap.kind
  ).toLowerCase();
  const scope = snap.scope ?? "everything indexed";
  const partial = checked.total > checked.checked;
  return (
    <div className="rounded-lg border border-dashed border-line-strong bg-surface-2 px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-80 items-start gap-2.5">
          <IconHistory className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">
              Saved snapshot from {formatDate(snap.created_ns)}
            </p>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-soft">
              {summary} of {kind} across{" "}
              <span className="font-mono text-xs text-ink">{scope}</span>.
              Nothing here was scanned again, so it shows the disk as it was
              then.
              {snap.note ? ` Saved with ${snap.note}.` : ""}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        >
          Close snapshot
        </button>
      </div>
      <p className="mt-2.5 border-t border-line pt-2.5 text-sm leading-relaxed">
        {checked.missing > 0 ? (
          <span className="text-ochre">
            <span className="font-mono font-medium">{checked.missing}</span> of{" "}
            <span className="font-mono font-medium">{checked.checked}</span>{" "}
            files are gone since this was saved. Those rows are marked and left
            out of the selection.
          </span>
        ) : (
          <span className="text-ink-soft">
            All{" "}
            <span className="font-mono text-ink">
              {checked.checked.toLocaleString()}
            </span>{" "}
            files are still where this snapshot left them.
          </span>
        )}
        {checked.changed > 0 && (
          <span className="text-ink-soft">
            {" "}
            <span className="font-mono text-ink">{checked.changed}</span>{" "}
            {checked.changed === 1 ? "file has" : "files have"} changed size
            since then and {checked.changed === 1 ? "is marked" : "are marked"}{" "}
            too.
          </span>
        )}
        {partial && (
          <span className="text-ink-soft">
            {" "}
            Only the first{" "}
            <span className="font-mono text-ink">
              {checked.checked.toLocaleString()}
            </span>{" "}
            of {checked.total.toLocaleString()} paths were checked.
          </span>
        )}
      </p>
    </div>
  );
}

// Row markers. Gone is ochre because it changes what the row can do; a file
// that was merely re-saved is still actionable, so it stays neutral.
export function MissingTag() {
  return (
    <span className="shrink-0 rounded-[3px] border border-ochre/40 bg-ochre-soft px-1.5 py-0.5 text-xs font-medium text-ochre">
      Missing
    </span>
  );
}

export function ChangedTag() {
  return (
    <span className="shrink-0 rounded-[3px] border border-line bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-ink-soft">
      Size changed
    </span>
  );
}

const secondary =
  "inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-line-strong disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal";

// Export sits with the scan controls rather than over the list: saving a result
// set is part of running one, not part of reading it.
export function ExportButton({
  onExport,
  busy,
  kind,
}: {
  onExport: () => void;
  busy: boolean;
  kind: SnapshotKind;
}) {
  return (
    <button
      type="button"
      onClick={onExport}
      disabled={busy}
      title={`Save these ${KIND_LABEL[kind].toLowerCase()} to a file`}
      className={secondary}
    >
      {busy && (
        <span className="h-4 w-4 rounded-full border-2 border-line-strong border-t-ink-soft fo-spin" />
      )}
      {busy ? "Saving" : "Export"}
    </button>
  );
}

export function OpenSavedButton({
  onOpen,
  busy,
}: {
  onOpen: () => void;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={busy}
      title="Open a results file you saved earlier"
      className={secondary}
    >
      {busy ? (
        <span className="h-4 w-4 rounded-full border-2 border-line-strong border-t-ink-soft fo-spin" />
      ) : (
        <IconHistory className="h-4 w-4" />
      )}
      {busy ? "Opening" : "Open saved"}
    </button>
  );
}

// Export and import both answer next to the buttons that started them.
export function SnapshotNote({ error, done }: { error: string; done: string }) {
  if (!error && !done) return null;
  return error ? (
    <div className="rounded-md border border-brick/40 bg-brick-soft px-3.5 py-2.5 text-sm text-brick">
      {error}
    </div>
  ) : (
    <p className="text-sm text-ink-soft">{done}</p>
  );
}
