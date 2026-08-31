import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, pickFolder } from "../bridge";
import { formatRelative, formatSize } from "../format";
import type {
  Rule,
  RuleAction,
  RuleFilter,
  RuleRun,
  SearchHit,
} from "../types";
import PageHeader from "../components/PageHeader";
import Segmented from "../components/Segmented";
import {
  IconCheck,
  IconFolder,
  IconPlay,
  IconRestore,
  IconReveal,
  IconRules,
  IconTrash,
  IconX,
} from "../components/icons";

const MB = 1_048_576;
const PREVIEW_LIMIT = 500;
const PREVIEW_SHOWN = 20;

// A rule reads as one sentence. Anything the user typed is a "data" token and
// gets set in mono ochre, so the variable parts stand out from the connectives.
type Token = { text: string; data?: boolean };

type Draft = {
  id: string | null;
  name: string;
  nameContains: string;
  ext: string;
  minMb: string;
  maxMb: string;
  olderDays: string;
  inFolder: string;
  action: "Trash" | "MoveTo";
  folder: string;
};

const BLANK: Draft = {
  id: null,
  name: "",
  nameContains: "",
  ext: "",
  minMb: "",
  maxMb: "",
  olderDays: "",
  inFolder: "",
  action: "Trash",
  folder: "",
};

function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+\//, "~/");
}

function num(v: string): number | null {
  const n = Number(v.trim());
  return v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
}

function buildFilter(d: Draft): RuleFilter {
  const min = num(d.minMb);
  const max = num(d.maxMb);
  const days = num(d.olderDays);
  return {
    name_contains: d.nameContains.trim() || null,
    ext: d.ext.trim().replace(/^\./, "") || null,
    min_size: min != null ? Math.round(min * MB) : null,
    max_size: max != null ? Math.round(max * MB) : null,
    older_than_days: days != null ? Math.round(days) : null,
    in_folder: d.inFolder.trim() || null,
  };
}

function buildAction(d: Draft): RuleAction {
  return d.action === "Trash"
    ? { type: "Trash" }
    : { type: "MoveTo", folder: d.folder };
}

function toDraft(r: Rule): Draft {
  return {
    id: r.id,
    name: r.name,
    nameContains: r.filter.name_contains ?? "",
    ext: r.filter.ext ?? "",
    minMb:
      r.filter.min_size != null
        ? String(+(r.filter.min_size / MB).toFixed(2))
        : "",
    maxMb:
      r.filter.max_size != null
        ? String(+(r.filter.max_size / MB).toFixed(2))
        : "",
    olderDays:
      r.filter.older_than_days != null ? String(r.filter.older_than_days) : "",
    inFolder: r.filter.in_folder ?? "",
    action: r.action.type,
    folder: r.action.type === "MoveTo" ? r.action.folder : "",
  };
}

function isCatchAll(f: RuleFilter): boolean {
  return (
    !f.name_contains &&
    !f.ext &&
    f.min_size == null &&
    f.max_size == null &&
    f.older_than_days == null &&
    !f.in_folder
  );
}

function describeFilter(f: RuleFilter): Token[] {
  if (isCatchAll(f)) return [{ text: "every indexed file" }];
  const out: Token[] = [];
  if (f.ext)
    out.push({
      text: f.ext.replace(/^\./, "").toUpperCase() + "s",
      data: true,
    });
  else out.push({ text: "files" });
  if (f.name_contains) {
    out.push({ text: " named like " });
    out.push({ text: `"${f.name_contains}"`, data: true });
  }
  if (f.in_folder) {
    out.push({ text: " in " });
    out.push({ text: shortPath(f.in_folder), data: true });
  }
  if (f.min_size != null && f.max_size != null) {
    out.push({ text: " between " });
    out.push({ text: formatSize(f.min_size), data: true });
    out.push({ text: " and " });
    out.push({ text: formatSize(f.max_size), data: true });
  } else if (f.min_size != null) {
    out.push({ text: " over " });
    out.push({ text: formatSize(f.min_size), data: true });
  } else if (f.max_size != null) {
    out.push({ text: " under " });
    out.push({ text: formatSize(f.max_size), data: true });
  }
  if (f.older_than_days != null) {
    out.push({ text: ", not changed in " });
    out.push({ text: `${f.older_than_days} days`, data: true });
  }
  return out;
}

function describeAction(a: RuleAction): Token[] {
  if (a.type === "Trash") return [{ text: "Move to Trash" }];
  return [
    { text: "Move to " },
    {
      text: a.folder ? shortPath(a.folder) : "a folder you pick",
      data: !!a.folder,
    },
  ];
}

function lastRunLine(r: Rule): string {
  if (r.last_run_ns == null) return "Never run";
  const when = formatRelative(r.last_run_ns);
  if (r.last_run_count === 0) return `Ran ${when}, nothing matched`;
  return `Ran on ${r.last_run_count} ${r.last_run_count === 1 ? "file" : "files"}, ${when}`;
}

function Sentence({
  tokens,
  capitalize,
}: {
  tokens: Token[];
  capitalize?: boolean;
}) {
  return (
    <>
      {tokens.map((t, i) => {
        const text =
          capitalize && i === 0
            ? t.text.charAt(0).toUpperCase() + t.text.slice(1)
            : t.text;
        return t.data ? (
          <span key={i} className="font-mono text-[0.92em] text-ochre">
            {text}
          </span>
        ) : (
          <span key={i}>{text}</span>
        );
      })}
    </>
  );
}

const inputCls =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-teal focus-visible:ring-2 focus-visible:ring-teal/30";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-soft">
        {label}
        {hint && (
          <span className="ml-1.5 font-normal text-ink-faint">{hint}</span>
        )}
      </span>
      {children}
    </label>
  );
}

type RunReport = {
  count: number;
  action: RuleAction;
  name: string;
  undone: boolean;
};

export default function RulesView() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [run, setRun] = useState<RunReport | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setRules(await invoke<Rule[]>("list_rules"));
      setError("");
    } catch (e) {
      setError(
        `Could not load your rules: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function runRule(rule: Rule) {
    setBusyId(rule.id);
    setError("");
    setRun(null);
    try {
      const res = await invoke<RuleRun>("run_rule", { id: rule.id });
      setRun({
        count: res.count,
        action: rule.action,
        name: rule.name,
        undone: false,
      });
      await refresh();
    } catch (e) {
      setError(
        `Could not run "${rule.name}": ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusyId(null);
    }
  }

  async function undoRun() {
    try {
      await invoke<string[]>("undo_last");
      setRun((r) => (r ? { ...r, undone: true } : r));
      await refresh();
    } catch (e) {
      setError(
        `Could not undo that run: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function removeRule(rule: Rule) {
    setConfirmId(null);
    try {
      await invoke("delete_rule", { id: rule.id });
      if (draft?.id === rule.id) setDraft(null);
      await refresh();
    } catch (e) {
      setError(
        `Could not delete "${rule.name}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const destination =
    run && run.action.type === "MoveTo"
      ? shortPath(run.action.folder)
      : "Trash";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rules"
        subtitle="Save a filter and one action, then run it whenever you want. Every run goes through Trash, so you can undo it."
        actions={
          <button
            type="button"
            onClick={() => {
              setDraft({ ...BLANK });
              setRun(null);
            }}
            disabled={draft != null && draft.id == null}
            className="inline-flex items-center gap-2 rounded-md bg-teal px-3.5 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            New rule
          </button>
        }
      />

      {error && (
        <div className="rounded-md border border-brick/40 bg-brick-soft px-3.5 py-2.5 text-sm text-brick">
          {error}
        </div>
      )}

      {run && run.count === 0 && (
        <div className="rounded-md border border-ochre/40 bg-ochre-soft px-3.5 py-2.5 text-sm text-ink-soft">
          <span className="font-medium text-ink">{run.name}</span> matched
          nothing this time, so no files moved.
        </div>
      )}

      {run && run.count > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-teal-line bg-teal-soft px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2 text-sm">
            <IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-teal" />
            <div>
              <p className="font-medium text-ink">
                {run.undone
                  ? `Put ${run.count} ${run.count === 1 ? "file" : "files"} back where they were.`
                  : `Moved ${run.count} ${run.count === 1 ? "file" : "files"} to ${destination}.`}
              </p>
              {!run.undone && (
                <p className="mt-0.5 text-ink-soft">
                  {run.action.type === "Trash"
                    ? "Nothing is gone. Restore any of it from Trash."
                    : "Undo puts every file back in its original folder."}
                </p>
              )}
            </div>
          </div>
          {!run.undone && (
            <button
              type="button"
              onClick={undoRun}
              className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-md border border-teal-line bg-surface px-3 py-2 text-sm font-medium text-teal transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal sm:self-auto"
            >
              <IconRestore className="h-4 w-4" />
              Undo this run
            </button>
          )}
        </div>
      )}

      {draft && draft.id == null && (
        <RuleEditor
          initial={draft}
          original={null}
          onCancel={() => setDraft(null)}
          onSaved={async () => {
            setDraft(null);
            await refresh();
          }}
          onError={setError}
        />
      )}

      {loaded && rules.length === 0 && !draft && (
        <div className="rounded-lg border border-line bg-surface px-6 py-14 text-center">
          <IconRules className="mx-auto mb-3 h-7 w-7 text-ink-faint" />
          <p className="text-sm font-medium text-ink">No rules yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">
            A rule is a filter plus one action you can re-run any time. Two that
            earn their keep:
          </p>
          <ul className="mx-auto mt-4 max-w-md space-y-2 text-left text-sm text-ink-soft">
            <li className="rounded-md border border-line bg-surface-2/50 px-3.5 py-2.5">
              Move <span className="font-mono text-ochre">PDFs</span> named like{" "}
              <span className="font-mono text-ochre">"invoice"</span> into
              Documents/Invoices.
            </li>
            <li className="rounded-md border border-line bg-surface-2/50 px-3.5 py-2.5">
              Send files in{" "}
              <span className="font-mono text-ochre">~/Downloads</span> over{" "}
              <span className="font-mono text-ochre">500 MB</span> that you have
              not changed in{" "}
              <span className="font-mono text-ochre">60 days</span> to Trash.
            </li>
          </ul>
          <button
            type="button"
            onClick={() => setDraft({ ...BLANK })}
            className="mt-5 rounded-md bg-teal px-3.5 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            Create your first rule
          </button>
        </div>
      )}

      {rules.length > 0 && (
        <div className="space-y-3">
          {rules.map((rule) =>
            draft && draft.id === rule.id ? (
              <RuleEditor
                key={rule.id}
                initial={draft}
                original={rule}
                onCancel={() => setDraft(null)}
                onSaved={async () => {
                  setDraft(null);
                  await refresh();
                }}
                onError={setError}
              />
            ) : (
              <article
                key={rule.id}
                className="relative overflow-hidden rounded-lg border border-line bg-surface"
              >
                <span
                  aria-hidden="true"
                  className={
                    "absolute inset-y-0 left-0 w-[3px] " +
                    (rule.action.type === "Trash" ? "bg-ochre" : "bg-teal")
                  }
                />
                <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between sm:gap-x-4">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold text-ink">
                      {rule.name}
                    </h2>
                    <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                      <Sentence
                        tokens={describeFilter(rule.filter)}
                        capitalize
                      />
                    </p>
                    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
                      <span className="inline-flex items-center gap-1.5">
                        {rule.action.type === "Trash" ? (
                          <IconTrash className="h-3.5 w-3.5 text-ochre" />
                        ) : (
                          <IconFolder className="h-3.5 w-3.5 text-teal" />
                        )}
                        <span className="text-ink-soft">
                          <Sentence tokens={describeAction(rule.action)} />
                        </span>
                      </span>
                      <span>
                        <span aria-hidden="true">· </span>
                        {lastRunLine(rule)}
                      </span>
                    </p>
                  </div>
                  {confirmId === rule.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-ink-soft">
                        Delete this rule? Your files stay where they are.
                      </span>
                      <button
                        type="button"
                        onClick={() => setConfirmId(null)}
                        className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                      >
                        Keep rule
                      </button>
                      <button
                        type="button"
                        onClick={() => removeRule(rule)}
                        className="rounded-md bg-brick px-2.5 py-1.5 text-xs font-medium text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
                      >
                        Delete rule
                      </button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => runRule(rule)}
                        disabled={busyId != null}
                        className="inline-flex items-center gap-1.5 rounded-md border border-teal-line bg-teal-soft px-2.5 py-1.5 text-xs font-medium text-teal transition-colors hover:brightness-95 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                      >
                        {busyId === rule.id ? (
                          <span className="h-3.5 w-3.5 rounded-full border-2 border-teal/30 border-t-teal fo-spin" />
                        ) : (
                          <IconPlay className="h-3.5 w-3.5" />
                        )}
                        {busyId === rule.id ? "Running" : "Run"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDraft(toDraft(rule));
                          setRun(null);
                        }}
                        className="rounded-md px-2.5 py-1.5 text-xs font-medium text-ink-soft hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmId(rule.id)}
                        className="rounded-md px-2.5 py-1.5 text-xs font-medium text-brick hover:bg-brick-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </article>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function RuleEditor({
  initial,
  original,
  onCancel,
  onSaved,
  onError,
}: {
  initial: Draft;
  original: Rule | null;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onError: (m: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [checking, setChecking] = useState(true);
  const [previewError, setPreviewError] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const seq = useRef(0);

  const filter = buildFilter(draft);
  const filterKey = JSON.stringify(filter);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  useEffect(() => {
    const mine = ++seq.current;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const res = await invoke<SearchHit[]>("preview_rule", {
          filter: JSON.parse(filterKey) as RuleFilter,
          limit: PREVIEW_LIMIT,
        });
        if (seq.current !== mine) return;
        setHits(res);
        setPreviewError("");
      } catch (e) {
        if (seq.current !== mine) return;
        setPreviewError(
          `Could not preview matches: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        if (seq.current === mine) setChecking(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [filterKey]);

  async function chooseFolder(target: "inFolder" | "folder") {
    const dir = await pickFolder();
    if (!dir) return;
    set(target === "folder" ? { folder: dir } : { inFolder: dir });
  }

  async function save() {
    if (!draft.name.trim()) {
      setFormError("Give the rule a name so you can recognize it later.");
      return;
    }
    if (draft.action === "MoveTo" && !draft.folder.trim()) {
      setFormError("Pick the folder these files should move into.");
      return;
    }
    setFormError("");
    setSaving(true);
    try {
      if (draft.id == null) {
        await invoke<Rule>("create_rule", {
          name: draft.name.trim(),
          filter,
          action: buildAction(draft),
        });
      } else if (original) {
        await invoke("update_rule", {
          rule: {
            ...original,
            name: draft.name.trim(),
            filter,
            action: buildAction(draft),
          },
        });
      }
      await onSaved();
    } catch (e) {
      onError(
        `Could not save the rule: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  const count = hits?.length ?? 0;
  const capped = count >= PREVIEW_LIMIT;

  return (
    <section className="overflow-hidden rounded-lg border border-teal-line bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">
          {draft.id == null ? "New rule" : "Edit rule"}
        </h2>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close the rule editor"
          className="rounded-md p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        >
          <IconX className="h-4 w-4" />
        </button>
      </header>

      <div className="space-y-5 px-4 py-4">
        <Field label="Rule name">
          <input
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Old invoices"
            className={inputCls}
          />
        </Field>

        <div className="space-y-2.5">
          <span className="block text-xs font-medium text-ink-soft">
            What it does
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<Draft["action"]>
              ariaLabel="Rule action"
              value={draft.action}
              onChange={(v) => set({ action: v })}
              options={[
                { value: "Trash", label: "Move to Trash" },
                { value: "MoveTo", label: "Move to folder" },
              ]}
            />
            {draft.action === "MoveTo" && (
              <button
                type="button"
                onClick={() => chooseFolder("folder")}
                className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
              >
                <IconFolder className="h-4 w-4 text-ink-faint" />
                <span className={draft.folder ? "font-mono text-xs" : ""}>
                  {draft.folder
                    ? shortPath(draft.folder)
                    : "Choose destination"}
                </span>
              </button>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <span className="block text-xs font-medium text-ink-soft">
            Which files it picks up
          </span>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name contains">
              <input
                value={draft.nameContains}
                onChange={(e) => set({ nameContains: e.target.value })}
                placeholder="invoice"
                className={inputCls}
              />
            </Field>
            <Field label="Extension">
              <input
                value={draft.ext}
                onChange={(e) => set({ ext: e.target.value })}
                placeholder="pdf"
                className={inputCls + " font-mono placeholder:font-sans"}
              />
            </Field>
            <Field label="Bigger than" hint="in MB">
              <input
                value={draft.minMb}
                onChange={(e) => set({ minMb: e.target.value })}
                inputMode="decimal"
                placeholder="100"
                className={
                  inputCls + " font-mono tabular-nums placeholder:font-sans"
                }
              />
            </Field>
            <Field label="Smaller than" hint="in MB">
              <input
                value={draft.maxMb}
                onChange={(e) => set({ maxMb: e.target.value })}
                inputMode="decimal"
                placeholder="No limit"
                className={
                  inputCls + " font-mono tabular-nums placeholder:font-sans"
                }
              />
            </Field>
            <Field label="Not changed in" hint="days">
              <input
                value={draft.olderDays}
                onChange={(e) => set({ olderDays: e.target.value })}
                inputMode="numeric"
                placeholder="90"
                className={
                  inputCls + " font-mono tabular-nums placeholder:font-sans"
                }
              />
            </Field>
            <div>
              <span className="mb-1.5 block text-xs font-medium text-ink-soft">
                In folder
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => chooseFolder("inFolder")}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-left text-sm text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                >
                  <IconFolder className="h-4 w-4 shrink-0 text-ink-faint" />
                  <span
                    className={
                      "truncate " +
                      (draft.inFolder ? "font-mono text-xs" : "text-ink-faint")
                    }
                  >
                    {draft.inFolder
                      ? shortPath(draft.inFolder)
                      : "Anywhere indexed"}
                  </span>
                </button>
                {draft.inFolder && (
                  <button
                    type="button"
                    onClick={() => set({ inFolder: "" })}
                    aria-label="Search anywhere instead of one folder"
                    className="shrink-0 rounded-md p-2 text-ink-faint hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                  >
                    <IconX className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-line bg-surface-2/40">
        <div
          aria-live="polite"
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3"
        >
          <p className="text-sm leading-relaxed text-ink-soft">
            Matches <Sentence tokens={describeFilter(filter)} />
          </p>
          <p className="shrink-0 font-mono text-base font-medium tabular-nums text-ink">
            {checking && hits == null
              ? "counting"
              : `${capped ? PREVIEW_LIMIT + "+" : count} ${count === 1 && !capped ? "file" : "files"}`}
          </p>
        </div>

        {isCatchAll(filter) && (
          <p className="border-t border-ochre/30 bg-ochre-soft px-4 py-2.5 text-sm text-ink-soft">
            With no filters set, this rule takes every file in your index.
            Narrow it before you run it.
          </p>
        )}

        {previewError && (
          <p className="border-t border-brick/30 bg-brick-soft px-4 py-2.5 text-sm text-brick">
            {previewError}
          </p>
        )}

        {!previewError && (
          <div className="border-t border-line">
            {hits != null && hits.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-ink-soft">
                Nothing matches yet. Loosen a filter, or index the folder you
                had in mind.
              </p>
            ) : (
              <ul
                className={
                  checking
                    ? "opacity-60 transition-opacity"
                    : "transition-opacity"
                }
              >
                {(hits ?? []).slice(0, PREVIEW_SHOWN).map((h) => (
                  <li
                    key={h.path}
                    className="group flex items-center gap-3 border-b border-line/60 px-4 py-2 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-ink">{h.name}</div>
                      <div className="truncate font-mono text-xs text-ink-faint">
                        {shortPath(h.path)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        invoke("reveal_file", { path: h.path }).catch(() => {})
                      }
                      aria-label={`Reveal ${h.name} in Finder`}
                      className="shrink-0 rounded-md p-1.5 text-ink-faint opacity-0 transition-opacity hover:bg-surface hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal group-hover:opacity-100"
                    >
                      <IconReveal className="h-4 w-4" />
                    </button>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-ink-soft">
                      {formatSize(h.size)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {count > PREVIEW_SHOWN && (
              <p className="border-t border-line px-4 py-2 text-xs text-ink-faint">
                Showing the {PREVIEW_SHOWN} largest of{" "}
                {capped ? `${PREVIEW_LIMIT}+` : count} matches.
              </p>
            )}
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
        <p className="text-xs text-ink-faint">
          Saving does not move anything. Run the rule when you are ready.
        </p>
        <div className="flex items-center gap-2">
          {formError && <span className="text-xs text-brick">{formError}</span>}
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-md bg-teal px-3.5 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            {draft.id == null ? "Save rule" : "Save changes"}
          </button>
        </div>
      </footer>
    </section>
  );
}
