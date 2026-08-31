import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke, listen } from "../bridge";
import type {
  AgentResult,
  AgentStep,
  Chat,
  ChatMessage,
  ChatSummary,
  PendingAction,
} from "../types";
import PageHeader from "../components/PageHeader";
import Markdown from "../components/Markdown";
import ChatHistory from "../components/ChatHistory";
import {
  IconAssistant,
  IconCheck,
  IconHistory,
  IconSend,
  IconSpark,
} from "../components/icons";

// Two voices for the same tool: what it is doing now, and what it did.
const TOOL_RUNNING: Record<string, string> = {
  search_files: "Searching files",
  list_folder: "Reading a folder",
  find_duplicates: "Scanning for duplicates",
  index_stats: "Checking the index",
  trash_files: "Preparing to move files to Trash",
  move_files: "Preparing to move files",
};

const TOOL_LABELS: Record<string, string> = {
  search_files: "Searched files",
  list_folder: "Read a folder",
  find_duplicates: "Scanned for duplicates",
  index_stats: "Checked the index",
  trash_files: "Moved files to Trash",
  move_files: "Moved files",
};

type LiveStep = { id: string; name: string; done: boolean };

// A turn is stamped with the chat it began in, so its result is saved there
// even when the reader has moved on to another chat by the time it lands.
type Turn = { token: number; chat: string | null };

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

function ActivityNote({ label, live }: { label: string; live?: boolean }) {
  return (
    <div
      className={
        "flex items-center gap-2 px-1 text-xs " +
        (live ? "text-ink-soft" : "text-ink-faint")
      }
    >
      <span
        className={
          "h-1.5 w-1.5 shrink-0 " +
          (live ? "bg-teal fo-pulse" : "border border-ink-faint bg-transparent")
        }
      />
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
  const [stream, setStream] = useState("");
  const [steps, setSteps] = useState<LiveStep[]>([]);
  const [awaiting, setAwaiting] = useState(false);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [chatsError, setChatsError] = useState("");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Only a turn we started listens to the event stream, and autoscroll lets go
  // the moment the reader scrolls up to read something further back.
  const liveRef = useRef(false);
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  // Every turn carries a token. Switching chats or starting a new one bumps it,
  // so a reply still in flight can never land in the chat the reader moved to.
  const turnRef = useRef(0);
  const chatIdRef = useRef<string | null>(null);

  const hasChat = messages.some(
    (m) => (m.role === "user" || m.role === "assistant") && m.content,
  );

  useEffect(() => {
    let dropped = false;
    const offs: (() => void)[] = [];
    const keep = (p: Promise<() => void>) =>
      void p.then((off) => (dropped ? off() : offs.push(off)));
    keep(
      listen<string>("ai:delta", (frag) => {
        if (liveRef.current) setStream((s) => s + frag);
      }),
    );
    keep(
      listen<AgentStep>("ai:step", (step) => {
        if (!liveRef.current) return;
        if (step.kind === "tool" && step.name) {
          const name = step.name;
          setSteps((prev) => [
            ...prev,
            { id: `${name}-${prev.length}`, name, done: false },
          ]);
        } else if (step.kind === "tool_done" && step.name) {
          const name = step.name;
          setSteps((prev) => {
            const i = prev.findIndex((s) => s.name === name && !s.done);
            if (i < 0) return prev;
            const next = [...prev];
            next[i] = { ...next[i], done: true };
            return next;
          });
        } else if (step.kind === "awaiting_approval") {
          setAwaiting(true);
        }
      }),
    );
    keep(
      listen("ai:done", () => {
        if (liveRef.current)
          setSteps((prev) => prev.map((s) => ({ ...s, done: true })));
      }),
    );
    return () => {
      dropped = true;
      offs.forEach((off) => off());
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
  }, [messages, pending, thinking, stream, steps, awaiting]);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 128) + "px";
  }, [input]);

  async function refreshChats() {
    try {
      const list = await invoke<ChatSummary[]>("list_chats", { limit: 100 });
      setChats(list);
      setChatsError("");
    } catch (e) {
      setChatsError(
        `Could not load saved chats: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setChatsLoading(false);
    }
  }

  useEffect(() => {
    void refreshChats();
  }, []);

  // Every turn starts from an empty buffer, and the resolved transcript replaces
  // the streamed copy in the same commit, so the reply never renders twice.
  function startTurn(): Turn {
    setStream("");
    setSteps([]);
    setAwaiting(false);
    setThinking(true);
    setError("");
    setSaveError("");
    setPending([]);
    stickRef.current = true;
    liveRef.current = true;
    return { token: ++turnRef.current, chat: chatIdRef.current };
  }

  // Drops whatever turn is in flight without touching the transcript, so the
  // chat the reader is leaving stops writing into the view.
  function abandonTurn() {
    turnRef.current++;
    liveRef.current = false;
    setStream("");
    setSteps([]);
    setAwaiting(false);
    setThinking(false);
  }

  // A turn the reader walked away from still finishes and still saves, it just
  // stops touching the view it no longer owns.
  function endTurn(r: AgentResult, turn: Turn) {
    if (turn.token === turnRef.current) {
      liveRef.current = false;
      setStream("");
      setSteps([]);
      setAwaiting(false);
      setMessages(r.messages);
      setPending(r.pending);
      setDone(r.done);
      setApprovals(Object.fromEntries(r.pending.map((p) => [p.id, true])));
    }
    void persist(r.messages, turn);
  }

  // One save per resolved turn, written to the chat the turn started in. It only
  // repoints the view at that chat while the reader is still sitting in it.
  async function persist(msgs: ChatMessage[], turn: Turn) {
    const worth = msgs.some(
      (m) => (m.role === "user" || m.role === "assistant") && m.content,
    );
    if (!worth) return;
    try {
      const saved = await invoke<Chat>("save_chat", {
        id: turn.chat,
        messages: msgs,
      });
      if (turn.token === turnRef.current) {
        chatIdRef.current = saved.id;
        setChatId(saved.id);
      }
      void refreshChats();
    } catch (e) {
      if (turn.token !== turnRef.current) return;
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  async function openChat(id: string) {
    if (id === chatIdRef.current && !thinking) {
      setHistoryOpen(false);
      return;
    }
    abandonTurn();
    setLoadingId(id);
    try {
      const chat = await invoke<Chat | null>("get_chat", { id });
      if (!chat) {
        setChatsError("That chat is no longer saved.");
        void refreshChats();
        return;
      }
      chatIdRef.current = chat.id;
      setChatId(chat.id);
      setMessages(chat.messages);
      setPending([]);
      setApprovals({});
      setDone(true);
      setError("");
      setNeedsKey(false);
      setSaveError("");
      setChatsError("");
      setInput("");
      stickRef.current = true;
      if (window.matchMedia("(max-width: 639px)").matches)
        setHistoryOpen(false);
    } catch (e) {
      setChatsError(
        `Could not open that chat: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setLoadingId(null);
    }
  }

  async function renameChat(id: string, title: string) {
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    try {
      await invoke("rename_chat", { id, title });
      void refreshChats();
    } catch (e) {
      setChatsError(
        `Could not rename that chat: ${e instanceof Error ? e.message : String(e)}`,
      );
      void refreshChats();
    }
  }

  async function deleteChat(id: string) {
    try {
      await invoke("delete_chat", { id });
      if (chatIdRef.current === id) newChat();
      void refreshChats();
    } catch (e) {
      setChatsError(
        `Could not delete that chat: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function clearChats() {
    try {
      await invoke("clear_chats");
      newChat();
      void refreshChats();
    } catch (e) {
      setChatsError(
        `Could not clear saved chats: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || thinking) return;
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setNeedsKey(false);
    const turn = startTurn();
    try {
      const r = await invoke<AgentResult>("ai_agent", {
        messages: next,
        model,
      });
      endTurn(r, turn);
    } catch (e) {
      if (turn.token !== turnRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      liveRef.current = false;
      setStream("");
      setSteps([]);
      setAwaiting(false);
      setNeedsKey(/no api key/i.test(msg));
      setError(msg);
    } finally {
      if (turn.token === turnRef.current) setThinking(false);
    }
  }

  async function applyApprovals() {
    if (pending.length === 0) return;
    const decisions = pending.map((p) => ({
      id: p.id,
      approved: approvals[p.id] !== false,
    }));
    const turn = startTurn();
    try {
      const r = await invoke<AgentResult>("ai_agent_continue", {
        messages,
        approvals: decisions,
        model,
      });
      endTurn(r, turn);
    } catch (e) {
      if (turn.token !== turnRef.current) return;
      liveRef.current = false;
      setStream("");
      setSteps([]);
      setAwaiting(false);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (turn.token === turnRef.current) setThinking(false);
    }
  }

  function newChat() {
    abandonTurn();
    chatIdRef.current = null;
    setChatId(null);
    setMessages([]);
    setPending([]);
    setApprovals({});
    setDone(true);
    setError("");
    setNeedsKey(false);
    setSaveError("");
    setInput("");
  }

  const approvedCount = pending.filter((p) => approvals[p.id] !== false).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Assistant"
        subtitle="Ask about your files in plain language. The assistant can search, dedupe, and tidy up, and always asks before it changes anything."
        actions={
          <>
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              aria-expanded={historyOpen}
              className={
                "inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal " +
                (historyOpen
                  ? "border-teal-line bg-teal-soft text-teal"
                  : "border-line bg-surface text-ink hover:border-line-strong")
              }
            >
              <IconHistory className="h-4 w-4" />
              History
            </button>
            {hasChat && (
              <button
                type="button"
                onClick={newChat}
                className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
              >
                New chat
              </button>
            )}
          </>
        }
      />

      <div className="relative flex h-[64vh] min-h-[440px] overflow-hidden rounded-lg border border-line bg-surface">
        {historyOpen && (
          <ChatHistory
            chats={chats}
            currentId={chatId}
            loading={chatsLoading}
            loadingId={loadingId}
            error={chatsError}
            onOpen={openChat}
            onRename={renameChat}
            onDelete={deleteChat}
            onClearAll={clearChats}
            onClose={() => setHistoryOpen(false)}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            onScroll={(e) => {
              // Only a scroll upward hands control back to the reader: growing
              // text alone must not look like they scrolled away.
              const el = e.currentTarget;
              if (el.scrollTop < lastTopRef.current - 4)
                stickRef.current = false;
              else if (el.scrollHeight - el.scrollTop - el.clientHeight < 48)
                stickRef.current = true;
              lastTopRef.current = el.scrollTop;
            }}
            className="flex-1 space-y-4 overflow-y-auto px-4 py-5"
          >
            {!hasChat && !thinking ? (
              <div className="flex h-full flex-col items-center justify-center px-4 text-center">
                <IconAssistant className="mb-3 h-8 w-8 text-ink-faint" />
                <p className="text-sm font-medium text-ink">
                  What do you want to sort out?
                </p>
                <p className="mt-1 max-w-sm text-sm text-ink-soft">
                  Try one of these, or type your own. Nothing is deleted without
                  your go-ahead.
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
                            label={
                              TOOL_LABELS[tc.function.name] ?? "Used a tool"
                            }
                          />
                        ))}
                      </div>
                    );
                  if (m.role === "assistant" && m.content)
                    return (
                      <div key={i} className="flex justify-start">
                        <div className="min-w-0 max-w-[92%] rounded-lg rounded-bl-sm border border-line bg-surface-2 px-3.5 py-2.5 sm:max-w-[85%]">
                          <Markdown text={m.content} />
                        </div>
                      </div>
                    );
                  return null;
                })}

                {thinking && (
                  <div className="space-y-2">
                    {steps.map((s) => (
                      <ActivityNote
                        key={s.id}
                        live={!s.done}
                        label={
                          s.done
                            ? (TOOL_LABELS[s.name] ?? "Used a tool")
                            : (TOOL_RUNNING[s.name] ?? "Working")
                        }
                      />
                    ))}
                    {awaiting && (
                      <ActivityNote live label="Waiting on your go-ahead" />
                    )}
                    {stream ? (
                      <div className="flex justify-start">
                        <div className="fo-streaming min-w-0 max-w-[92%] rounded-lg rounded-bl-sm border border-line bg-surface-2 px-3.5 py-2.5 sm:max-w-[85%]">
                          <Markdown text={stream} />
                        </div>
                      </div>
                    ) : (
                      steps.every((s) => s.done) &&
                      !awaiting && (
                        <div className="flex items-center gap-2 px-1 text-sm text-ink-soft">
                          <span className="h-3.5 w-3.5 rounded-full border-2 border-teal/30 border-t-teal fo-spin" />
                          Thinking
                        </div>
                      )
                    )}
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
            {saveError ? (
              <p className="mt-1.5 px-1 text-xs text-brick">
                This chat was not saved to history: {saveError}
              </p>
            ) : (
              <p className="mt-1.5 px-1 text-xs text-ink-faint">
                Enter to send, Shift plus Enter for a new line.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
