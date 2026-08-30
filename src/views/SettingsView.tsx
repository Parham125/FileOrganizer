import { useEffect, useState } from "react";
import { invoke } from "../bridge";
import ModelSelector from "../ModelSelector";
import PageHeader from "../components/PageHeader";
import { IconCheck, IconKey } from "../components/icons";
import type { HashAlgo, Theme } from "../types";

function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string; hint?: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-md border border-line bg-surface-2 p-1"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={
              "rounded-[5px] px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal " +
              (active
                ? "bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                : "text-ink-soft hover:text-ink")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Row({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-line px-5 py-5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
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

  useEffect(() => {
    invoke<boolean>("has_api_key")
      .then(setSaved)
      .catch(() => setSaved(false));
  }, []);

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
          {saved ? <IconCheck className="h-3.5 w-3.5" /> : <IconKey className="h-3.5 w-3.5" />}
          {saved === null ? "Checking" : saved ? "Key saved" : "No key set"}
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
          title="OpenRouter API key"
          desc="Powers Organize and Assistant. Stored in your macOS keychain and sent only to OpenRouter. It never leaves this device otherwise, and is never shown back to you."
        >
          <ApiKeyControl />
        </Row>

        <Row
          title="AI model"
          desc="Used by both Organize and Assistant. Pick the model your key has access to on OpenRouter."
        >
          <ModelSelector value={model} onChange={onModel} />
        </Row>
      </div>
    </div>
  );
}
