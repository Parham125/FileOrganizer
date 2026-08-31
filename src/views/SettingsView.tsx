import { useEffect, useState } from "react";
import { invoke } from "../bridge";
import ModelSelector from "../ModelSelector";
import PageHeader from "../components/PageHeader";
import Segmented from "../components/Segmented";
import { IconCheck, IconKey } from "../components/icons";
import type { HashAlgo, KeyStorage, ReasoningEffort, Theme } from "../types";

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

function ApiKeyControl() {
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
  }, []);

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

  useEffect(() => {
    invoke<ReasoningEffort>("get_reasoning_effort")
      .then(setEffort)
      .catch(() => setEffort("medium"));
  }, []);

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
          <ApiKeyControl />
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
      </div>
    </div>
  );
}
