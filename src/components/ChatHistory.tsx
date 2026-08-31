import { useState } from "react";
import type { ChatSummary } from "../types";
import { formatRelative } from "../format";
import { IconPencil, IconTrash, IconX } from "../components/icons";

// The saved-chat list. It lives inside the assistant card rather than as a
// second app sidebar, so the chat keeps the full width the moment it is closed.
export default function ChatHistory({
  chats,
  currentId,
  branched,
  loading,
  loadingId,
  error,
  onOpen,
  onRename,
  onDelete,
  onClearAll,
  onClose,
}: {
  chats: ChatSummary[];
  currentId: string | null;
  // Chats branched off during this session. Nothing is stored for it, so the
  // tag is only a hint while the reader is still in the session that made them.
  branched: string[];
  loading: boolean;
  loadingId: string | null;
  error: string;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onClose: () => void;
}) {
  const [renameId, setRenameId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  function startRename(c: ChatSummary) {
    setConfirmId(null);
    setRenameId(c.id);
    setDraft(c.title);
  }

  function commitRename() {
    const title = draft.trim();
    if (renameId && title) onRename(renameId, title);
    setRenameId(null);
  }

  return (
    <aside
      aria-label="Saved chats"
      className="absolute inset-0 z-10 flex flex-col bg-surface sm:static sm:z-auto sm:w-64 sm:shrink-0 sm:border-r sm:border-line sm:bg-surface-2/70"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <h2 className="text-sm font-medium text-ink">Saved chats</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close saved chats"
          className="grid h-7 w-7 place-items-center rounded-md text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        >
          <IconX className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p className="border-b border-line px-3 py-2.5 text-xs text-brick">
            {error}
          </p>
        )}
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-ink-soft">
            <span className="h-3.5 w-3.5 rounded-full border-2 border-teal/30 border-t-teal fo-spin" />
            Loading chats
          </div>
        ) : chats.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <p className="text-sm font-medium text-ink">No saved chats yet</p>
            <p className="mt-1 text-xs text-ink-soft">
              Ask the assistant something and this chat shows up here.
            </p>
          </div>
        ) : (
          <ul>
            {chats.map((c) => {
              const active = c.id === currentId;
              if (renameId === c.id)
                return (
                  <li
                    key={c.id}
                    className="border-b border-line/60 px-3 py-2.5 last:border-b-0"
                  >
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename();
                        } else if (e.key === "Escape") setRenameId(null);
                      }}
                      aria-label="Chat name"
                      className="w-full rounded-md border border-teal bg-surface px-2 py-1.5 text-sm text-ink outline-none ring-2 ring-teal/30"
                    />
                    <div className="mt-2 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={commitRename}
                        disabled={!draft.trim()}
                        className="rounded-md bg-teal px-2.5 py-1 text-xs font-medium text-white transition-colors hover:brightness-95 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                      >
                        Save name
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenameId(null)}
                        className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                      >
                        Cancel
                      </button>
                    </div>
                  </li>
                );
              if (confirmId === c.id)
                return (
                  <li
                    key={c.id}
                    className="border-b border-line/60 px-3 py-2.5 last:border-b-0"
                  >
                    <p className="text-xs text-ink-soft">
                      Delete this chat? Your files are not affected.
                    </p>
                    <div className="mt-2 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setConfirmId(null)}
                        className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmId(null);
                          onDelete(c.id);
                        }}
                        className="rounded-md bg-brick px-2.5 py-1 text-xs font-medium text-white transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
                      >
                        Delete chat
                      </button>
                    </div>
                  </li>
                );
              return (
                <li
                  key={c.id}
                  className={
                    "group relative border-b border-line/60 last:border-b-0 " +
                    (active ? "bg-teal-soft" : "hover:bg-surface-2/70")
                  }
                >
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 w-[2px] bg-teal"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => onOpen(c.id)}
                    aria-current={active ? "true" : undefined}
                    title={c.title}
                    className="block w-full px-3 py-2.5 pr-14 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal"
                  >
                    <span
                      className={
                        "block truncate text-sm " +
                        (active ? "font-medium text-teal" : "text-ink")
                      }
                    >
                      {c.title}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-faint">
                      {loadingId === c.id && (
                        <span className="h-3 w-3 shrink-0 rounded-full border-2 border-teal/30 border-t-teal fo-spin" />
                      )}
                      {formatRelative(c.updated_ns)} · {c.message_count}{" "}
                      {c.message_count === 1 ? "message" : "messages"}
                      {branched.includes(c.id) && " · branched"}
                    </span>
                  </button>
                  {/* Always reachable on touch; on a pointer device they stay
                      out of the way until the row is hovered or tabbed into. */}
                  <div className="absolute right-2 top-2 flex items-center gap-0.5 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={() => startRename(c)}
                      aria-label={`Rename ${c.title}`}
                      className="grid h-6 w-6 place-items-center rounded-md text-ink-faint transition-colors hover:bg-surface hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                    >
                      <IconPencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRenameId(null);
                        setConfirmId(c.id);
                      }}
                      aria-label={`Delete ${c.title}`}
                      className="grid h-6 w-6 place-items-center rounded-md text-ink-faint transition-colors hover:bg-brick-soft hover:text-brick focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {chats.length > 0 && (
        <div className="border-t border-line px-3 py-2.5">
          {confirmClear ? (
            <div>
              <p className="text-xs text-ink-soft">
                Delete all {chats.length} saved chats?
              </p>
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                >
                  Keep them
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmClear(false);
                    onClearAll();
                  }}
                  className="rounded-md bg-brick px-2.5 py-1 text-xs font-medium text-white transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
                >
                  Delete all
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="rounded-md px-2 py-1 text-xs font-medium text-brick transition-colors hover:bg-brick-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
