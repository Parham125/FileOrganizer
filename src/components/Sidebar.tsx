import type { ViewId } from "../types";
import Logo from "./Logo";
import {
  IconAssistant,
  IconDuplicates,
  IconMoon,
  IconOrganize,
  IconSearch,
  IconSettings,
  IconSun,
  IconTrash,
} from "./icons";

const NAV: { id: ViewId; label: string; Icon: (p: { className?: string }) => React.ReactElement }[] =
  [
    { id: "search", label: "Search", Icon: IconSearch },
    { id: "duplicates", label: "Duplicates", Icon: IconDuplicates },
    { id: "organize", label: "Organize", Icon: IconOrganize },
    { id: "assistant", label: "Assistant", Icon: IconAssistant },
    { id: "trash", label: "Trash", Icon: IconTrash },
    { id: "settings", label: "Settings", Icon: IconSettings },
  ];

export default function Sidebar({
  view,
  onView,
  indexed,
  isDark,
  onToggleTheme,
}: {
  view: ViewId;
  onView: (v: ViewId) => void;
  indexed: number;
  isDark: boolean;
  onToggleTheme: () => void;
}) {
  return (
    <aside className="flex shrink-0 flex-row items-stretch gap-1 border-b border-line bg-surface-2 px-2 py-2 md:w-56 md:flex-col md:gap-0.5 md:border-b-0 md:border-r md:px-3 md:py-4">
      <div className="mr-2 hidden items-center gap-2 px-2 pb-4 md:flex">
        <Logo className="h-7 w-7" />
        <span className="text-[15px] font-semibold tracking-tight">
          FileOrganizer
        </span>
      </div>

      <nav className="flex flex-1 flex-row gap-1 md:flex-col md:gap-0.5">
        {NAV.map(({ id, label, Icon }) => {
          const active = view === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onView(id)}
              aria-current={active ? "page" : undefined}
              className={
                "group relative flex flex-1 items-center justify-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal md:flex-none md:justify-start " +
                (active
                  ? "bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                  : "text-ink-soft hover:bg-surface/60 hover:text-ink")
              }
            >
              {active && (
                <span className="absolute left-0 top-1/2 hidden h-6 w-[3px] -translate-y-1/2 rounded-r-sm bg-teal md:block" />
              )}
              <Icon className="h-[18px] w-[18px] shrink-0" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          );
        })}
      </nav>

      <div className="hidden md:mt-auto md:block md:pt-4">
        <div className="rounded-md border border-line bg-surface px-3 py-2.5">
          <div className="text-xs text-ink-faint">Files indexed</div>
          <div className="font-mono text-sm font-medium tabular-nums text-ink">
            {indexed.toLocaleString()}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onToggleTheme}
        aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
        className="ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-md text-ink-soft hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal md:ml-0 md:mt-2 md:w-full"
      >
        {isDark ? <IconSun /> : <IconMoon />}
      </button>
    </aside>
  );
}
