import { useCallback, useState } from "react";
import { invoke } from "../bridge";
import { IconReveal } from "./icons";

// Opening a file is how the reader settles a set the app cannot settle for
// them, so a failure has to land next to the row they pressed rather than in a
// banner that may be a thousand rows away.
export function useFileActions() {
  const [failed, setFailed] = useState<{
    path: string;
    message: string;
  } | null>(null);
  const reveal = useCallback(async (path: string) => {
    setFailed(null);
    try {
      await invoke("reveal_file", { path });
    } catch (e) {
      setFailed({
        path,
        message: `Could not show this file in its folder. ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, []);
  const open = useCallback(async (path: string) => {
    setFailed(null);
    try {
      await invoke("open_file", { path });
    } catch (e) {
      setFailed({
        path,
        message: `Could not open this file. ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, []);
  return { failed, reveal, open };
}

// Always on screen, at every width. Deciding what to delete usually means
// looking at the file first, and a control that only appears under a mouse
// pointer is not there at all on a touch screen.
export default function RevealButton({
  name,
  onReveal,
  className,
}: {
  name: string;
  onReveal: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onReveal}
      // The row opens the file on a double click, which is not what pressing
      // this twice should mean.
      onDoubleClick={(e) => e.stopPropagation()}
      title="Show in folder"
      aria-label={`Show ${name} in its folder`}
      className={
        "grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal " +
        (className ?? "")
      }
    >
      <IconReveal className="h-4 w-4" />
    </button>
  );
}

// The failure for one row, under that row.
export function FileActionError({ message }: { message: string }) {
  return (
    <p className="border-b border-line/60 bg-brick-soft px-4 py-2 text-xs text-brick last:border-b-0">
      {message}
    </p>
  );
}
