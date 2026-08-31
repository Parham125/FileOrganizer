import { IconStop } from "./icons";

// Ochre, not brick: a stopped run is not an error, it just did less than a
// finished one.
export default function StoppedNotice({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-ochre/40 bg-ochre-soft px-3.5 py-2.5 text-sm text-ochre">
      <IconStop className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
