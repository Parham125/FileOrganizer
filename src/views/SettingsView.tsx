import { useEffect, useState } from "react";
import { invoke, isDesktop } from "../bridge";
import ModelSelector from "../ModelSelector";
import PageHeader from "../components/PageHeader";
import Segmented from "../components/Segmented";
import { IconCheck, IconKey, IconReveal } from "../components/icons";
import { formatSize } from "../format";
import { useUpdatePrefs } from "../store";
import { forgetThumbs } from "../thumbs";
import type {
  AppDataSummary,
  HashAlgo,
  KeyStorage,
  ReasoningEffort,
  Theme,
} from "../types";

// The behaviour behind each store, in the user's terms. The keychain line names
// the one thing that actually annoys people about it rather than burying it.
const STORAGE_NOTE: Record<KeyStorage, string> = {
  keychain:
    "Safest option. On an unsigned build macOS asks for your password once each time you open the app.",
  file: "No password prompts. The key sits in the app's data folder, readable only by your account.",
};

function Row({
  title,
  desc,
  top,
  children,
}: {
  title: string;
  desc: string;
  top?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        "flex flex-col gap-3 border-b border-line px-5 py-5 last:border-b-0 sm:flex-row sm:justify-between sm:gap-8 " +
        (top ? "sm:items-start" : "sm:items-center")
      }
    >
      <div className="max-w-md">
        <h2 className="text-sm font-medium text-ink">{title}</h2>
        <p className="mt-0.5 text-sm text-ink-soft">{desc}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// Anything under an hour hammers a manifest that only moves on release day.
const UPDATE_INTERVALS = [
  { min: 15, label: "Every 15 minutes" },
  { min: 30, label: "Every 30 minutes" },
  { min: 60, label: "Every hour" },
  { min: 180, label: "Every 3 hours" },
  { min: 360, label: "Every 6 hours" },
  { min: 1440, label: "Once a day" },
];

function CheckOption({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={
        "flex items-center gap-2 text-sm text-ink " +
        (disabled ? "cursor-not-allowed" : "cursor-pointer")
      }
    >
      <span
        className={
          "grid h-4 w-4 shrink-0 place-items-center rounded-[3px] border transition-colors " +
          (checked
            ? "border-teal bg-teal text-white"
            : "border-line-strong bg-surface")
        }
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-label={label}
          className="sr-only"
        />
        {checked && <IconCheck className="h-3 w-3" />}
      </span>
      {label}
    </label>
  );
}

function UpdateControl() {
  const {
    autoUpdate,
    setAutoUpdate,
    updateOnStartup,
    setUpdateOnStartup,
    updateWhileRunning,
    setUpdateWhileRunning,
    updateIntervalMin,
    setUpdateIntervalMin,
  } = useUpdatePrefs();
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<string>("app_version")
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  // The background check stays silent, but this one was asked for, so a failure
  // says what went wrong instead of looking like nothing happened.
  async function checkNow() {
    setChecking(true);
    setNote("");
    setError("");
    try {
      if (!isDesktop) throw new Error("this only works in the desktop app");
      const { check } = await import("@tauri-apps/plugin-updater");
      const found = await check();
      setNote(
        found
          ? `Version ${found.version} is available.`
          : "You are on the latest version.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="w-full max-w-sm sm:w-80">
      <Segmented<"on" | "off">
        ariaLabel="Check for updates"
        value={autoUpdate ? "on" : "off"}
        onChange={(v) => setAutoUpdate(v === "on")}
        options={[
          { value: "on", label: "On" },
          { value: "off", label: "Off" },
        ]}
      />
      <div
        className={
          "mt-3 space-y-2.5 " + (autoUpdate ? "" : "opacity-50 select-none")
        }
      >
        <CheckOption
          label="When the app starts"
          checked={updateOnStartup}
          disabled={!autoUpdate}
          onChange={setUpdateOnStartup}
        />
        <CheckOption
          label="While the app is open"
          checked={updateWhileRunning}
          disabled={!autoUpdate}
          onChange={setUpdateWhileRunning}
        />
        <select
          value={String(updateIntervalMin)}
          onChange={(e) => setUpdateIntervalMin(Number(e.target.value))}
          disabled={!autoUpdate || !updateWhileRunning}
          aria-label="How often to check for updates"
          className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-teal disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-teal/30"
        >
          {UPDATE_INTERVALS.map((s) => (
            <option key={s.min} value={s.min}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="font-mono text-xs tabular-nums text-ink-soft">
          {version ? `Version ${version}` : "Reading version"}
        </span>
        <button
          type="button"
          onClick={checkNow}
          disabled={checking}
          className="shrink-0 rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:border-line-strong disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        >
          {checking ? "Checking" : "Check now"}
        </button>
      </div>
      {note && <p className="mt-2 text-xs text-ink-soft">{note}</p>}
      {error && (
        <p className="mt-2 text-xs text-brick">
          The check did not finish: {error}
        </p>
      )}
    </div>
  );
}

// reload counts resets done in the Stored data row below. A reset takes the key
// with it, so the saved indicator is read back from the runtime rather than left
// claiming a key that no longer exists.
function ApiKeyControl({ reload }: { reload: number }) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [storage, setStorage] = useState<KeyStorage | null>(null);
  const [moving, setMoving] = useState(false);
  const [storageError, setStorageError] = useState("");

  useEffect(() => {
    invoke<boolean>("has_api_key")
      .then(setSaved)
      .catch(() => setSaved(false));
    invoke<KeyStorage>("get_key_storage")
      .then(setStorage)
      .catch(() => setStorage("keychain"));
  }, [reload]);

  // Switching moves the key rather than copying it, so the saved indicator is
  // read back from the runtime once the move lands instead of being assumed.
  async function switchStorage(next: KeyStorage) {
    if (next === storage || moving) return;
    setMoving(true);
    setStorageError("");
    try {
      await invoke("set_key_storage", { storage: next });
      setStorage(next);
    } catch (e) {
      setStorageError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaved(await invoke<boolean>("has_api_key").catch(() => saved));
      setMoving(false);
    }
  }

  async function save() {
    if (!key.trim()) return;
    setBusy(true);
    setError("");
    try {
      await invoke("set_api_key", { key: key.trim() });
      setKey("");
      setSaved(await invoke<boolean>("has_api_key"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await invoke("clear_api_key");
      setSaved(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm sm:w-80">
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span
          className={
            "inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-0.5 font-medium " +
            (saved
              ? "border-teal-line bg-teal-soft text-teal"
              : "border-line bg-surface-2 text-ink-soft")
          }
        >
          {saved ? (
            <IconCheck className="h-3.5 w-3.5" />
          ) : (
            <IconKey className="h-3.5 w-3.5" />
          )}
          {moving
            ? "Moving key"
            : saved === null
              ? "Checking"
              : saved
                ? "Key saved"
                : "No key set"}
        </span>
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={saved ? "Replace key" : "sk-or-..."}
          aria-label="OpenRouter API key"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-ink outline-none placeholder:font-sans placeholder:text-ink-faint focus:border-teal focus-visible:ring-2 focus-visible:ring-teal/30"
        />
        <button
          type="button"
          onClick={save}
          disabled={busy || !key.trim()}
          className="shrink-0 rounded-md bg-teal px-3.5 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          Save
        </button>
      </div>
      {saved && (
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="mt-2 rounded-md px-2 py-1 text-xs font-medium text-brick hover:bg-brick-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
        >
          Remove key
        </button>
      )}
      {error && <p className="mt-2 text-xs text-brick">{error}</p>}
      <div className="mt-4 border-t border-line pt-4">
        <div className="mb-2 text-sm font-medium text-ink">
          Where the key is stored
        </div>
        <Segmented<KeyStorage>
          ariaLabel="Where the key is stored"
          value={storage ?? "keychain"}
          onChange={switchStorage}
          options={[
            { value: "keychain", label: "System keychain" },
            { value: "file", label: "Settings file" },
          ]}
        />
        <p className="mt-2 text-sm text-ink-soft">
          {STORAGE_NOTE[storage ?? "keychain"]}
        </p>
        {storage === "file" && (
          <p className="mt-2.5 border-l-2 border-ochre pl-2.5 text-sm text-ochre">
            Your key sits unencrypted on disk while this is selected.
          </p>
        )}
        {storageError && (
          <p className="mt-2 text-xs text-brick">
            The key was not moved: {storageError}
          </p>
        )}
      </div>
    </div>
  );
}

// The folder name at the end is what identifies this path, so a long one loses
// the middle folders rather than its tail. The full path stays in the title
// attribute. Windows paths split on their own separator.
function shortPath(path: string, max = 40): string {
  if (path.length <= max) return path;
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep);
  if (parts.length > 4) {
    const short = [...parts.slice(0, 3), "…", parts[parts.length - 1]].join(
      sep,
    );
    if (short.length < path.length) return short;
  }
  return path.slice(0, 10) + "…" + path.slice(-(max - 11));
}

function StoredDataControl({ onReset }: { onReset: () => void }) {
  const [summary, setSummary] = useState<AppDataSummary | null>(null);
  const [loadError, setLoadError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [clearing, setClearing] = useState(false);
  const [thumbNote, setThumbNote] = useState("");

  async function load() {
    try {
      setSummary(await invoke<AppDataSummary>("app_data_summary"));
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // The runtime refuses a reset while its Trash still holds real files. The same
  // count drives the note and the disabled button, so the user reads the reason
  // before they reach for the action instead of after it fails.
  const trashed = summary?.trashed_files ?? 0;
  const blocked = trashed > 0;
  const blockedReason = `${trashed} ${trashed === 1 ? "file is" : "files are"} still in the app's Trash. Restore or empty it first.`;

  async function reveal() {
    if (!summary) return;
    setError("");
    try {
      await invoke("reveal_file", { path: summary.dir });
    } catch (e) {
      setError(
        `Could not open the folder: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Safe at any moment: the next result list simply regenerates the previews it
  // needs. The app's own copy goes too, so the UI stops showing thumbnails it
  // no longer has on disk.
  async function clearThumbs() {
    setClearing(true);
    setThumbNote("");
    try {
      const freed = await invoke<number>("clear_thumbnail_cache");
      forgetThumbs();
      setThumbNote(
        `Cleared ${formatSize(freed)}. Previews come back as you browse results.`,
      );
      await load();
    } catch (e) {
      setThumbNote(
        `Nothing was cleared: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setClearing(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError("");
    setDone("");
    try {
      await invoke("reset_app_data");
      setDone("Stored data deleted, including your saved API key.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      await load();
      onReset();
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm sm:w-80">
      <div className="rounded-md border border-line bg-surface-2 px-3 py-2.5">
        <div
          className="truncate font-mono text-xs text-ink"
          title={summary?.dir ?? undefined}
        >
          {summary
            ? shortPath(summary.dir)
            : loadError
              ? "Folder could not be read"
              : "Reading folder"}
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="font-mono text-xs tabular-nums text-ink-soft">
            {summary ? `${formatSize(summary.bytes)} on disk` : "Checking size"}
          </span>
          <button
            type="button"
            onClick={reveal}
            disabled={!summary}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:border-line-strong disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          >
            <IconReveal className="h-3.5 w-3.5" />
            Open folder
          </button>
        </div>
      </div>
      {/* Its own card because it is its own folder, and because clearing it is
          harmless in a way that deleting the data folder is not. */}
      <div className="mt-2.5 rounded-md border border-line bg-surface-2 px-3 py-2.5">
        <div
          className="truncate font-mono text-xs text-ink"
          title={summary?.thumbs_dir ?? undefined}
        >
          {summary ? shortPath(summary.thumbs_dir) : "Reading folder"}
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="font-mono text-xs tabular-nums text-ink-soft">
            {summary
              ? `${formatSize(summary.thumbs_bytes)} in thumbnails`
              : "Checking size"}
          </span>
          <button
            type="button"
            onClick={clearThumbs}
            disabled={!summary || clearing}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:border-line-strong disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          >
            {clearing && (
              <span className="h-3.5 w-3.5 rounded-full border-2 border-line-strong border-t-ink-soft fo-spin" />
            )}
            {clearing ? "Clearing" : "Clear cache"}
          </button>
        </div>
      </div>
      {thumbNote && <p className="mt-2 text-xs text-ink-soft">{thumbNote}</p>}
      {blocked && (
        <p className="mt-2.5 border-l-2 border-ochre pl-2.5 text-sm text-ochre">
          {blockedReason} Deleting now would take them with it.
        </p>
      )}
      {confirming ? (
        <div className="mt-3">
          <p className="text-xs text-ink-soft">
            Delete everything the app has stored? This cannot be undone.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                void reset();
              }}
              disabled={busy}
              className="rounded-md bg-brick px-2.5 py-1.5 text-xs font-medium text-white hover:brightness-95 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              Delete
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setDone("");
            setError("");
            setConfirming(true);
          }}
          disabled={blocked || busy || !summary}
          title={blocked ? blockedReason : undefined}
          className="mt-3 rounded-md border border-brick/50 px-2.5 py-1.5 text-xs font-medium text-brick hover:bg-brick-soft disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick"
        >
          {busy ? "Deleting" : "Delete stored data"}
        </button>
      )}
      {done && <p className="mt-2 text-xs text-teal">{done}</p>}
      {error && (
        <p className="mt-2 text-xs text-brick">Nothing was deleted: {error}</p>
      )}
      {loadError && !error && (
        <p className="mt-2 text-xs text-brick">
          The folder could not be read: {loadError}
        </p>
      )}
    </div>
  );
}

export default function SettingsView({
  model,
  onModel,
  algo,
  onAlgo,
  theme,
  onTheme,
}: {
  model: string;
  onModel: (m: string) => void;
  algo: HashAlgo;
  onAlgo: (a: HashAlgo) => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
}) {
  const [effort, setEffort] = useState<ReasoningEffort | null>(null);
  const [effortError, setEffortError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    invoke<ReasoningEffort>("get_reasoning_effort")
      .then(setEffort)
      .catch(() => setEffort("medium"));
  }, [reload]);

  async function changeEffort(next: ReasoningEffort) {
    const prev = effort;
    setEffort(next);
    setEffortError("");
    try {
      await invoke("set_reasoning_effort", { effort: next });
    } catch (e) {
      setEffort(prev);
      setEffortError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        subtitle="Preferences are saved on this device and take effect right away."
      />

      <div className="rounded-lg border border-line bg-surface">
        <Row
          title="Appearance"
          desc="Match your system, or lock the app to light or dark."
        >
          <Segmented<Theme>
            ariaLabel="Appearance"
            value={theme}
            onChange={onTheme}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "System" },
            ]}
          />
        </Row>

        <Row
          top
          title="Updates"
          desc="Check GitHub for a new version. Nothing installs on its own: a new version shows up as a bar at the bottom that you can take or dismiss."
        >
          <UpdateControl />
        </Row>

        <Row
          title="Duplicate hashing"
          desc="BLAKE3 is fast and the default. SHA-256 is slower but a widely recognized standard."
        >
          <Segmented<HashAlgo>
            ariaLabel="Hash algorithm"
            value={algo}
            onChange={onAlgo}
            options={[
              { value: "blake3", label: "BLAKE3" },
              { value: "sha256", label: "SHA-256" },
            ]}
          />
        </Row>

        <Row
          top
          title="OpenRouter API key"
          desc="Powers Organize and Assistant. Sent only to OpenRouter, never shown back to you, and it never leaves this device otherwise."
        >
          <ApiKeyControl reload={reload} />
        </Row>

        <Row
          title="AI model"
          desc="Used by both Organize and Assistant. Pick the model your key has access to on OpenRouter."
        >
          <ModelSelector value={model} onChange={onModel} />
        </Row>

        <Row
          title="Reasoning"
          desc="How long the assistant works a problem through before answering. More reasoning plans multi-step jobs better, but it spends more tokens on your key and takes longer to reply."
        >
          <div>
            <Segmented<ReasoningEffort>
              ariaLabel="Reasoning effort"
              value={effort ?? "medium"}
              onChange={changeEffort}
              options={[
                { value: "off", label: "Off" },
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ]}
            />
            {effortError && (
              <p className="mt-2 max-w-xs text-xs text-brick">
                Reasoning was not changed: {effortError}
              </p>
            )}
          </div>
        </Row>

        <Row
          top
          title="Stored data"
          desc="The app keeps its index, chat history, rules and settings in a folder on this device. Thumbnails sit in a separate cache you can clear on its own. Deleting either leaves your own files alone."
        >
          <StoredDataControl onReset={() => setReload((n) => n + 1)} />
        </Row>
      </div>
    </div>
  );
}
