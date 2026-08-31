// What a scan could and could not reach. The two notes are deliberately in
// different registers: a scan that opens files comes back short when a drive is
// unplugged, while a scan that only reads names covers that drive perfectly
// well, and telling the second one off in ochre would train people to ignore
// the first.

function RootList({ roots }: { roots: string[] }) {
  return (
    <ul className="mt-1.5 space-y-1">
      {roots.map((p) => (
        <li key={p} className="truncate font-mono text-xs" title={p}>
          {p}
        </li>
      ))}
    </ul>
  );
}

export function ContentCoverageNote({
  roots,
  unreadable,
  noun,
}: {
  roots: string[];
  unreadable: number;
  noun: string;
}) {
  if (roots.length === 0 && unreadable === 0) return null;
  return (
    <div className="rounded-lg border border-ochre/40 bg-ochre-soft px-4 py-3 text-ochre">
      <p className="text-sm font-semibold">
        This scan did not cover everything
      </p>
      {roots.length > 0 && (
        <>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed">
            {roots.length === 1
              ? "This drive was"
              : `These ${roots.length} drives were`}{" "}
            not connected, so nothing on {roots.length === 1 ? "it" : "them"}{" "}
            was read:
          </p>
          <RootList roots={roots} />
        </>
      )}
      {unreadable > 0 && (
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed">
          <span className="font-mono font-medium">
            {unreadable.toLocaleString()}
          </span>{" "}
          {unreadable === 1 ? "file" : "files"} could not be opened, usually a
          permission the app does not have.
        </p>
      )}
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed">
        Any {noun} involving those files is missing from this list.
        {roots.length > 0
          ? " Reconnect the drive and scan again for the full picture."
          : ""}
      </p>
    </div>
  );
}

export function NameCoverageNote({ roots }: { roots: string[] }) {
  if (roots.length === 0) return null;
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-4 py-3 text-ink-soft">
      <p className="text-sm leading-relaxed">
        Includes{" "}
        <span className="font-mono font-medium text-ink">{roots.length}</span>{" "}
        {roots.length === 1 ? "drive that is" : "drives that are"} not
        connected. Names come from the index, so nothing had to be opened to
        match them.
      </p>
      <RootList roots={roots} />
    </div>
  );
}
