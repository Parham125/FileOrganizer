import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "../bridge";
import type { AgentResult, ChatMessage, PendingAction } from "../types";
import PageHeader from "../components/PageHeader";
import {
  IconAssistant,
  IconCheck,
  IconSend,
  IconSpark,
} from "../components/icons";

const TOOL_LABELS: Record<string, string> = {
  search: "Searched files",
  scan_duplicates: "Scanned for duplicates",
  list_trash: "Checked the Trash",
  index_stats: "Checked the index",
  index_folder: "Indexed a folder",
  trash_files: "Moved files to Trash",
  reveal_file: "Revealed a file",
  open_file: "Opened a file",
};

const EXAMPLES = [
  "Find duplicate photos in Downloads",
  "What's taking up the most space?",
];

// The exact files a proposed action would touch, so the user approves with full
// knowledge of what is affected (not just the summary line).
function actionPaths(p: PendingAction): string[] {
  if (p.name === "trash_files") {
    const paths = p.args?.paths;
    return Array.isArray(paths) ? paths.map((x) => String(x)) : [];
  }
  if (p.name === "move_files") {
    const moves = p.args?.moves;
    return Array.isArray(moves)
      ? moves.map((m) => `${m?.from ?? "?"}  →  ${m?.to ?? "?"}`)
      : [];
  }
  return [];
}

function ActivityNote({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-1 text-xs text-ink-faint">
      <span className="h-1 w-1 rounded-full bg-ink-faint" />
      {label}
    </div>
  );
}

export default function AssistantView({
  model,
  onGoSettings,
}: {
  model: string;
  onGoSettings: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [approvals, setApprovals] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState(true);
  const [thinking, setThinking] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [needsKey, setNeedsKey] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const hasChat = messages.some(
    (m) => (m.role === "user" || m.role === "assistant") && m.content,
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, thinking]);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 128) + "px";
  }, [input]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || thinking) return;
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setThinking(true);
    setError("");
    setNeedsKey(false);
    setPending([]);
    try {
      const r = await invoke<AgentResult>("ai_agent", { messages: next, model });
      setMessages(r.messages);
      setPending(r.pending);
      setDone(r.done);
      setApprovals(Object.fromEntries(r.pending.map((p) => [p.id, true])));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNeedsKey(/no api key/i.test(msg));
      setError(msg);
    } finally {
      setThinking(false);
    }
  }

  async function applyApprovals() {
    if (pending.length === 0) return;
    const decisions = pending.map((p) => ({
      id: p.id,
      approved: approvals[p.id] !== false,
    }));
    setThinking(true);
    setError("");
    setPending([]);
    try {
      const r = await invoke<AgentResult>("ai_agent_continue", {
        messages,
        approvals: decisions,
        model,
      });
      setMessages(r.messages);
      setPending(r.pending);
      setDone(r.done);
      setApprovals(Object.fromEntries(r.pending.map((p) => [p.id, true])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setThinking(false);
    }
  }

  function newChat() {
    setMessages([]);
    setPending([]);
    setApprovals({});
    setDone(true);
    setError("");
    setNeedsKey(false);
    setInput("");
  }

  const approvedCount = pending.filter((p) => approvals[p.id] !== false).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Assistant"
        subtitle="Ask about your files in plain language. The assistant can search, dedupe, and tidy up, and always asks before it changes anything."
        actions={
          hasChat ? (
            <button
              type="button"
              onClick={newChat}
              className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
            >
              New chat
            </button>
          ) : undefined
        }
      />

      <div className="flex h-[64vh] min-h-[440px] flex-col overflow-hidden rounded-lg border border-line bg-surface">
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-5">
          {!hasChat && !thinking ? (
            <div className="flex h-full flex-col items-center justify-center px-4 text-center">
              <IconAssistant className="mb-3 h-8 w-8 text-ink-faint" />
              <p className="text-sm font-medium text-ink">
                What do you want to sort out?
              </p>
              <p className="mt-1 max-w-sm text-sm text-ink-soft">
                Try one of these, or type your own. Nothing is deleted without your
                go-ahead.
              </p>
              <div className="mt-4 flex flex-col items-stretch gap-2 sm:flex-row sm:justify-center">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => send(ex)}
                    className="rounded-md border border-line bg-surface-2 px-3.5 py-2 text-sm text-ink transition-colors hover:border-teal-line hover:bg-teal-soft hover:text-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((m, i) => {
                if (m.role === "user")
                  return (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[80%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-teal px-3.5 py-2.5 text-sm text-white">
                        {m.content}
                      </div>
                    </div>
                  );
                if (m.role === "assistant" && m.tool_calls)
                  return (
                    <div key={i} className="space-y-1">
                      {m.tool_calls.map((tc) => (
                        <ActivityNote
                          key={tc.id}
                          label={TOOL_LABELS[tc.function.name] ?? "Used a tool"}
                        />
                      ))}
                    </div>
                  );
                if (m.role === "assistant" && m.content)
                  return (
                    <div key={i} className="flex justify-start">
                      <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-bl-sm border border-line bg-surface-2 px-3.5 py-2.5 text-sm text-ink">
                        {m.content}
                      </div>
                    </div>
                  );
                return null;
              })}

              {thinking && (
                <div className="flex items-center gap-2 px-1 text-sm text-ink-soft">
                  <span className="h-3.5 w-3.5 rounded-full border-2 border-teal/30 border-t-teal fo-spin" />
                  Thinking
                </div>
              )}

              {!done && pending.length > 0 && !thinking && (
                <div className="overflow-hidden rounded-lg border border-ochre/40 bg-ochre-soft/50">
                  <div className="flex items-center gap-2 border-b border-ochre/30 px-4 py-2.5">
                    <IconSpark className="h-4 w-4 shrink-0 text-ochre" />
                    <span className="text-sm font-medium text-ink">
                      Approve before I run{" "}
                      {pending.length === 1 ? "this" : "these"}
                    </span>
                  </div>
                  <ul>
                    {pending.map((p) => {
                      const approved = approvals[p.id] !== false;
                      const lines = actionPaths(p);
                      return (
                        <li
                          key={p.id}
                          className="flex flex-col gap-2.5 border-b border-ochre/20 px-4 py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between"
                        >
                          <div className="min-w-0">
                            <div
                              className={
                                "text-sm " +
                                (approved
                                  ? "text-ink"
                                  : "text-ink-faint line-through")
                              }
                            >
                              {p.summary}
                            </div>
                            {lines.length > 0 && (
                              <ul className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto">
                                {lines.slice(0, 12).map((line, i) => (
                                  <li
                                    key={i}
                                    className="truncate font-mono text-xs text-ink-faint"
                                    title={line}
                                  >
                                    {line}
                                  </li>
                                ))}
                                {lines.length > 12 && (
                                  <li className="text-xs text-ink-faint">
                                    +{lines.length - 12} more
                                  </li>
                                )}
                              </ul>
                            )}
                            {!approved && (
                              <div className="mt-1 text-xs font-medium text-ink-faint">
                                Will skip
                              </div>
                            )}
                          </div>
                          <div className="inline-flex shrink-0 self-start rounded-md border border-line bg-surface p-1 sm:self-auto">
                            {[
                              { v: true, label: "Approve" },
                              { v: false, label: "Skip" },
                            ].map((o) => {
                              const active = approved === o.v;
                              return (
                                <button
                                  key={o.label}
                                  type="button"
                                  onClick={() =>
                                    setApprovals((prev) => ({
                                      ...prev,
                                      [p.id]: o.v,
                                    }))
                                  }
                                  className={
                                    "rounded-[5px] px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal " +
                                    (active
                                      ? o.v
                                        ? "bg-teal text-white"
                                        : "bg-surface-2 text-ink"
                                      : "text-ink-soft hover:text-ink")
                                  }
                                >
                                  {o.label}
                                </button>
                              );
                            })}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ochre/30 px-4 py-3">
                    <span className="text-xs text-ink-soft">
                      {approvedCount} of {pending.length} will run
                    </span>
                    <button
                      type="button"
                      onClick={applyApprovals}
                      className="inline-flex items-center gap-1.5 rounded-md bg-teal px-3.5 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                    >
                      <IconCheck className="h-4 w-4" />
                      {approvedCount > 0 ? "Apply approved" : "Skip all"}
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-md border border-brick/40 bg-brick-soft px-3.5 py-2.5 text-sm text-brick">
                  {needsKey ? (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <span>
                        Add your OpenRouter API key in Settings to use the
                        assistant.
                      </span>
                      <button
                        type="button"
                        onClick={onGoSettings}
                        className="shrink-0 self-start rounded-md border border-brick/40 bg-surface px-3 py-1.5 text-sm font-medium text-brick hover:bg-brick-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick sm:self-auto"
                      >
                        Open Settings
                      </button>
                    </div>
                  ) : (
                    `Something went wrong: ${error}`
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="border-t border-line bg-surface-2/40 p-3">
          <div className="flex items-end gap-2 rounded-md border border-line bg-surface px-3 py-2 focus-within:border-teal focus-within:ring-2 focus-within:ring-teal/30">
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={1}
              placeholder="Ask about your files"
              aria-label="Message the assistant"
              className="max-h-32 min-h-6 flex-1 resize-none bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            />
            <button
              type="button"
              onClick={() => send(input)}
              disabled={!input.trim() || thinking}
              aria-label="Send message"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-teal text-white transition-colors hover:brightness-95 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              <IconSend className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-1.5 px-1 text-xs text-ink-faint">
            Enter to send, Shift plus Enter for a new line.
          </p>
        </div>
      </div>
    </div>
  );
}
