import { useState } from "react";
import { invoke } from "../bridge";
import type { Progress } from "../types";
import ProgressBar from "./ProgressBar";
import { IconStop } from "./icons";

// The progress card for every long operation. Stop is deliberately not brick:
// stopping keeps whatever the run already finished, it destroys nothing.
export default function ScanProgress({
  progress,
  label,
}: {
  progress: Progress;
  label: string;
}) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  async function stop() {
    setError("");
    setStopping(true);
    try {
      const running = await invoke<boolean>("cancel_scan");
      if (!running) {
        setStopping(false);
        setError("Nothing left to stop, this run is already finishing.");
      }
    } catch (e) {
      setStopping(false);
      setError(`Could not stop: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <ProgressBar
            progress={progress}
            label={stopping ? "Stopping" : label}
          />
        </div>
        <button
          type="button"
          onClick={stop}
          disabled={stopping}
          className="inline-flex shrink-0 items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-line-strong disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        >
          {stopping ? (
            <span className="h-4 w-4 rounded-full border-2 border-ink-faint/40 border-t-ink-faint fo-spin" />
          ) : (
            <IconStop className="h-4 w-4" />
          )}
          {stopping ? "Stopping" : "Stop"}
        </button>
      </div>
      {error && <p className="mt-2.5 text-xs text-brick">{error}</p>}
    </div>
  );
}
