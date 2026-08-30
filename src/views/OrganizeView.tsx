import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, listen, pickFolder } from "../bridge";
import type { Move } from "../types";
import PageHeader from "../components/PageHeader";
import {
  IconCheck,
  IconFolder,
  IconOrganize,
  IconSpark,
} from "../components/icons";

type Group = { dest: string; label: string; moves: Move[] };

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function parent(p: string): string {
  return p.slice(0, p.lastIndexOf("/"));
}

export default function OrganizeView({
  model,
  onGoSettings,
}: {
  model: string;
  onGoSettings: () => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [moves, setMoves] = useState<Move[] | null>(null);
  const [status, setStatus] = useState("");
  const [proposing, setProposing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [needsKey, setNeedsKey] = useState(false);
  const statusRef = useRef("");

  useEffect(() => {
    const un = listen<string>("ai:progress", (s) => {
      statusRef.current = s;
      setStatus(s);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const groups = useMemo<Group[]>(() => {
    if (!moves) return [];
    const map = new Map<string, Move[]>();
    for (const mv of moves) {
      const dest = parent(mv.to);
      const arr = map.get(dest) ?? [];
      arr.push(mv);
      map.set(dest, arr);
    }
    const base = root ? root.replace(/\/$/, "") + "/" : "";
    return [...map.entries()]
      .map(([dest, moves]) => ({
        dest,
        label: base && dest.startsWith(base) ? dest.slice(base.length) : dest,
        moves,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [moves, root]);

  async function chooseFolder() {
    const dir = await pickFolder();
    if (dir) {
      setRoot(dir);
      setMoves(null);
      setApplied(null);
      setError("");
    }
  }

  async function propose() {
    if (!root) {
      setError("Pick a folder to organize first.");
      return;
    }
    setError("");
    setNeedsKey(false);
    setApplied(null);
    setMoves(null);
    setProposing(true);
    setStatus("Starting");
    try {
      const res = await invoke<Move[]>("ai_propose_organization", { root, model });
      setMoves(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no api key/i.test(msg)) setNeedsKey(true);
      else setError(`Could not build a plan: ${msg}`);
    } finally {
      setProposing(false);
      setStatus("");
    }
  }

  async function apply() {
    if (!moves) return;
    setApplying(true);
    setError("");
    try {
      await invoke<string>("ai_apply_organization", { moves });
      setApplied(moves.length);
      setMoves(null);
    } catch (e) {
      setError(`Could not apply the plan: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organize"
        subtitle="Point the model at a messy folder. It proposes a tidy structure and you approve it before anything moves."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={chooseFolder}
              className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
            >
              <IconFolder className="h-4 w-4" />
              {root ? "Change folder" : "Pick folder"}
            </button>
            <button
              type="button"
              onClick={propose}
              disabled={proposing || !root}
              className="inline-flex items-center gap-2 rounded-md bg-teal px-3.5 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
            >
              {proposing ? (
                <span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white fo-spin" />
              ) : (
                <IconSpark className="h-4 w-4" />
              )}
              {proposing ? "Thinking" : "Propose organization"}
            </button>
          </div>
        }
      />

      {root && (
        <p className="font-mono text-xs text-ink-soft">
          <span className="text-ink-faint">Target </span>
          {root}
        </p>
      )}

      {proposing && (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3.5">
          <span className="h-4 w-4 shrink-0 rounded-full border-2 border-teal/30 border-t-teal fo-spin" />
          <span className="text-sm text-ink-soft">{status || "Working"}</span>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-brick/40 bg-brick-soft px-3.5 py-2.5 text-sm text-brick">
          {error}
        </div>
      )}

      {needsKey && (
        <div className="flex flex-col gap-2 rounded-lg border border-ochre/40 bg-ochre-soft px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <p className="font-medium text-ink">Add an API key to use Organize</p>
            <p className="mt-0.5 text-ink-soft">
              Organize runs on your OpenRouter key. Add it in Settings, then come back.
            </p>
          </div>
          <button
            type="button"
            onClick={onGoSettings}
            className="shrink-0 self-start rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal sm:self-auto"
          >
            Open Settings
          </button>
        </div>
      )}

      {applied != null && (
        <div className="flex items-start gap-2 rounded-md border border-teal-line bg-teal-soft px-3.5 py-2.5 text-sm text-teal">
          <IconCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Moved {applied} {applied === 1 ? "file" : "files"} into the new folders.
            This is reversible: restore anything from Trash, or use Undo last delete.
          </span>
        </div>
      )}

      {!root && !proposing && !needsKey && applied == null && (
        <div className="rounded-lg border border-line bg-surface px-6 py-16 text-center">
          <IconOrganize className="mx-auto mb-3 h-7 w-7 text-ink-faint" />
          <p className="text-sm font-medium text-ink">Pick a folder to start</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-soft">
            Downloads and Desktop are good first targets. Nothing moves until you
            approve the plan.
          </p>
        </div>
      )}

      {moves && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <span className="text-ink-soft">
              <span className="font-semibold text-ink">{moves.length}</span> files
            </span>
            <span className="text-ink-soft">
              into <span className="font-semibold text-ink">{groups.length}</span>{" "}
              {groups.length === 1 ? "folder" : "folders"}
            </span>
          </div>

          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.dest} className="rounded-lg border border-line bg-surface">
                <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
                  <IconFolder className="h-4 w-4 shrink-0 text-ochre" />
                  <span className="font-mono text-sm font-medium text-ink">
                    {g.label}
                  </span>
                  <span className="text-xs text-ink-faint">
                    {g.moves.length} {g.moves.length === 1 ? "file" : "files"}
                  </span>
                </div>
                <ul>
                  {g.moves.map((mv) => (
                    <li
                      key={mv.from}
                      className="flex items-center gap-3 border-b border-line/60 px-4 py-2.5 last:border-b-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-ink">
                          {basename(mv.to)}
                        </div>
                        <div className="truncate font-mono text-xs text-ink-faint">
                          from {parent(mv.from) || "/"}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-xs text-teal">
                        {g.label}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-4 py-3">
            <span className="text-sm text-ink-soft">
              Files move into new subfolders of the target. You can undo it from
              Trash.
            </span>
            <button
              type="button"
              onClick={apply}
              disabled={applying}
              className="inline-flex items-center gap-2 rounded-md bg-teal px-3.5 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              {applying && (
                <span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white fo-spin" />
              )}
              {applying ? "Applying" : "Apply plan"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
