import { useEffect, useRef, useState } from "react";
import { MODELS, type ModelOption } from "./models";
import ProviderMark from "./components/ProviderMark";
import { IconCheck } from "./components/icons";

export default function ModelSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = MODELS.find((m) => m.id === value) ?? (MODELS[0] as ModelOption);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative w-full max-w-sm text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2.5 text-left text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
      >
        <span className="flex items-center gap-2.5">
          <ProviderMark provider={selected.provider} />
          <span className="font-medium">{selected.label}</span>
        </span>
        <svg
          viewBox="0 0 24 24"
          className={"h-4 w-4 text-ink-faint transition-transform " + (open ? "rotate-180" : "")}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1.5 w-full overflow-hidden rounded-md border border-line bg-surface shadow-lg shadow-black/5"
        >
          {MODELS.map((m) => {
            const isSel = m.id === value;
            return (
              <li key={m.id} role="option" aria-selected={isSel}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                >
                  <ProviderMark provider={m.provider} />
                  <span className="flex-1 font-medium text-ink">{m.label}</span>
                  <span className="text-xs text-ink-faint">{m.provider}</span>
                  {isSel && <IconCheck className="h-4 w-4 text-teal" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
