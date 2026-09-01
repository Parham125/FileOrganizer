import { useState } from "react";

// Removing a whole set, which is the one action here that leaves nothing on
// disk. The confirm therefore sits inline in the set header the moment it is
// pressed, says both halves of the truth (nothing is kept, and the app's Trash
// can put it back), and reports its own failure where the press happened.
//
// open/onOpen are controlled by the view so only one set can be asking at a
// time. onTrash does the invoke and the reconciling; this component only owns
// the confirm, the spinner, and the error.
export default function TrashSetButton({
  paths,
  noun,
  nounPlural,
  note,
  open,
  onOpen,
  onTrash,
}: {
  paths: string[];
  noun: string;
  nounPlural?: string;
  // Anything the view knows that the plain question does not cover: that these
  // are look-alikes rather than copies, or that one of them changed on disk
  // since the results were saved. Shown as part of the question, because it
  // changes what the user is agreeing to.
  note?: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  onTrash: (paths: string[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const n = paths.length;
  const word = n === 1 ? noun : (nounPlural ?? `${noun}s`);
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await onTrash(paths);
      onOpen(false);
    } catch (e) {
      setError(
        `Could not move ${word} to Trash: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return (
      <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
        <button
          type="button"
          onClick={() => {
            setError("");
            onOpen(true);
          }}
          className="rounded-md px-2 py-1.5 text-xs font-medium text-brick transition-colors hover:bg-brick-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
        >
          Trash all {n}
        </button>
        {error && (
          <p className="basis-full text-right text-xs text-brick">{error}</p>
        )}
      </div>
    );
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
      <span className="text-xs text-ink-soft">
        Trash all {n} {word}? Nothing from this set stays on disk. They go to
        the app's Trash, so you can restore them.
        {note && <span className="text-ochre"> {note}</span>}
      </span>
      <button
        type="button"
        onClick={() => onOpen(false)}
        disabled={busy}
        className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink transition-colors hover:border-line-strong disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
      >
        Keep
      </button>
      <button
        type="button"
        onClick={confirm}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md bg-brick px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
      >
        {busy && (
          <span className="h-3.5 w-3.5 rounded-full border-2 border-white/40 border-t-white fo-spin" />
        )}
        {busy ? "Moving" : `Move all ${n} to Trash`}
      </button>
      {error && (
        <p className="basis-full text-right text-xs text-brick">{error}</p>
      )}
    </div>
  );
}
