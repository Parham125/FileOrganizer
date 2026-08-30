import type { Progress } from "../types";

export default function ProgressBar({
  progress,
  label,
}: {
  progress: Progress;
  label: string;
}) {
  const pct = progress.total > 0 ? (progress.done / progress.total) * 100 : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between font-mono text-xs text-ink-soft">
        <span>{label}</span>
        <span>
          {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-sm bg-surface-2">
        <div
          className="h-full rounded-sm bg-teal transition-[width] duration-200 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
