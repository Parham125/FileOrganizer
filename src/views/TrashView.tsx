import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke, listen } from "../bridge";
import { formatRelative, formatSize } from "../format";
import type { TrashItem } from "../types";
import PageHeader from "../components/PageHeader";
import { IconRestore, IconTrash } from "../components/icons";

type OpGroup = { op_id: string; items: TrashItem[] };

export default function TrashView() {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmItem, setConfirmItem] = useState<string | null>(null);
  const [confirmOp, setConfirmOp] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    try {
      setItems(await invoke<TrashItem[]>("list_trash", { limit: 500 }));
      setError("");
    } catch (e) {
      setError(
        `Could not load Trash: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, []);

  useEffect(() => {
    refresh();
    const un = listen("index:changed", () => refresh());
    return () => {
      un.then((f) => f());
    };
  }, [refresh]);

  const ops = useMemo<OpGroup[]>(() => {
    const map = new Map<string, TrashItem[]>();
    for (const it of items) {
      const arr = map.get(it.op_id) ?? [];
      arr.push(it);
      map.set(it.op_id, arr);
    }
    return [...map.entries()].map(([op_id, items]) => ({ op_id, items }));
  }, [items]);

  const active = items.filter((i) => !i.restored);

  async function run(fn: () => Promise<unknown>, message: string) {
    try {
      await fn();
      setNote(message);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trash"
        subtitle="Everything removed lands here first. Restore any file, or empty the Trash when you are sure."
        actions={
          <button
            type="button"
            onClick={() =>
              run(
                () => invoke<string[]>("undo_last"),
                "Reverted your last change.",
              )
            }
            disabled={active.length === 0}
            className="inline-flex items-center gap-2 rounded-md bg-teal px-3.5 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            <IconRestore className="h-4 w-4" />
            Undo last change
          </button>
        }
      />

      {error && (
        <div className="rounded-md border border-brick/40 bg-brick-soft px-3.5 py-2.5 text-sm text-brick">
          {error}
        </div>
      )}
      {note && (
        <div className="rounded-md border border-teal-line bg-teal-soft px-3.5 py-2.5 text-sm text-teal">
          {note}
        </div>
      )}

      {ops.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface px-6 py-16 text-center">
          <p className="text-sm font-medium text-ink">Trash is empty</p>
          <p className="mt-1 text-sm text-ink-soft">
            Files you remove from Duplicates or elsewhere will show up here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {ops.map((op) => {
            const pending = op.items.filter((i) => !i.restored);
            const bytes = op.items.reduce((s, i) => s + i.size, 0);
            const first = op.items[0];
            return (
              <div
                key={op.op_id}
                className="rounded-lg border border-line bg-surface"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink">
                      {op.items.length}{" "}
                      {op.items.length === 1 ? "file" : "files"} removed
                      <span className="ml-2 text-xs font-normal text-ink-faint">
                        {first.reason === "dedup"
                          ? "from duplicates"
                          : "manually"}{" "}
                        · {formatRelative(first.deleted_ns)} ·{" "}
                        {formatSize(bytes)}
                      </span>
                    </div>
                  </div>
                  {confirmOp === op.op_id ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-ink-soft">
                        Delete {op.items.length} for good?
                      </span>
                      <button
                        type="button"
                        onClick={() => setConfirmOp(null)}
                        className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmOp(null);
                          run(
                            () => invoke("purge_trash_op", { opId: op.op_id }),
                            "Deleted those files for good.",
                          );
                        }}
                        className="rounded-md bg-brick px-2.5 py-1.5 text-xs font-medium text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
                      >
                        Delete permanently
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {pending.length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            run(
                              () =>
                                invoke<string[]>("restore_op", {
                                  opId: op.op_id,
                                }),
                              `Restored ${pending.length} ${pending.length === 1 ? "file" : "files"}.`,
                            )
                          }
                          className="inline-flex items-center gap-1.5 rounded-md border border-teal-line bg-teal-soft px-2.5 py-1.5 text-xs font-medium text-teal hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                        >
                          <IconRestore className="h-3.5 w-3.5" />
                          Restore all
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setConfirmOp(op.op_id)}
                        className="rounded-md px-2 py-1.5 text-xs font-medium text-brick hover:bg-brick-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
                      >
                        Remove forever
                      </button>
                    </div>
                  )}
                </div>
                <ul>
                  {op.items.map((it) => {
                    const name = it.original_path.slice(
                      it.original_path.lastIndexOf("/") + 1,
                    );
                    return (
                      <li
                        key={it.id}
                        className="flex items-center gap-3 border-b border-line/60 px-4 py-2.5 last:border-b-0"
                      >
                        <div className="min-w-0 flex-1">
                          <div
                            className={
                              "truncate text-sm " +
                              (it.restored
                                ? "text-ink-faint line-through"
                                : "text-ink")
                            }
                          >
                            {name}
                          </div>
                          <div className="truncate font-mono text-xs text-ink-faint">
                            {it.original_path}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-xs tabular-nums text-ink-soft">
                          {formatSize(it.size)}
                        </span>
                        {confirmItem === it.id ? (
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setConfirmItem(null)}
                              className="rounded-md border border-line bg-surface px-2 py-1 text-xs font-medium text-ink hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                            >
                              Keep
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmItem(null);
                                run(
                                  () =>
                                    invoke("purge_trash_item", {
                                      itemId: it.id,
                                    }),
                                  "Deleted that file for good.",
                                );
                              }}
                              className="rounded-md bg-brick px-2 py-1 text-xs font-medium text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
                            >
                              Delete
                            </button>
                          </div>
                        ) : it.restored ? (
                          <div className="flex shrink-0 items-center gap-1.5">
                            <span className="rounded-[4px] border border-line bg-surface-2 px-2 py-0.5 text-xs text-ink-soft">
                              Restored
                            </span>
                            <button
                              type="button"
                              onClick={() => setConfirmItem(it.id)}
                              aria-label="Remove this file forever"
                              className="rounded-md px-2 py-1 text-xs font-medium text-brick hover:bg-brick-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
                            >
                              Remove forever
                            </button>
                          </div>
                        ) : (
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                run(
                                  () =>
                                    invoke<string>("restore_item", {
                                      itemId: it.id,
                                    }),
                                  "File restored to its original folder.",
                                )
                              }
                              className="rounded-md px-2 py-1 text-xs font-medium text-teal hover:bg-teal-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                            >
                              Restore
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmItem(it.id)}
                              aria-label="Remove this file forever"
                              className="rounded-md px-2 py-1 text-xs font-medium text-brick hover:bg-brick-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
                            >
                              Remove forever
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {ops.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brick/30 bg-brick-soft/50 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-ink-soft">
            <IconTrash className="h-4 w-4 text-brick" />
            <span>Emptying the Trash deletes these files for good.</span>
          </div>
          {confirmEmpty ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmEmpty(false)}
                className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
              >
                Keep files
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmEmpty(false);
                  run(() => invoke("empty_trash"), "Trash emptied.");
                }}
                className="rounded-md bg-brick px-3.5 py-1.5 text-sm font-medium text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
              >
                Delete permanently
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmEmpty(true)}
              className="rounded-md border border-brick/50 px-3 py-1.5 text-sm font-medium text-brick hover:bg-brick-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
            >
              Empty trash
            </button>
          )}
        </div>
      )}
    </div>
  );
}
