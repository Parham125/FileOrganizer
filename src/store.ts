import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ScanMode, Theme } from "./types";

// One live value per storage key, shared by every mounted hook that asks for it.
// Without this each caller kept a private copy, so a preference changed in
// Settings never reached the components already rendered elsewhere (the update
// banner is mounted for the whole session and read its values once at launch).
// The browser storage event is no help: it does not fire in the document that
// wrote the value.
const values = new Map<string, unknown>();
const subscribers = new Map<string, Set<() => void>>();

function readKey<T>(key: string, initial: T): T {
  if (values.has(key)) return values.get(key) as T;
  let value = initial;
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) value = JSON.parse(raw) as T;
  } catch {
    // storage unavailable (private window); fall back to the initial value
  }
  values.set(key, value);
  return value;
}

export function useLocalStorageState<T>(
  key: string,
  initial: T,
): [T, (v: T) => void] {
  const value = useSyncExternalStore(
    useCallback(
      (notify: () => void) => {
        let subs = subscribers.get(key);
        if (!subs) subscribers.set(key, (subs = new Set()));
        subs.add(notify);
        return () => {
          subs.delete(notify);
          if (subs.size === 0) subscribers.delete(key);
        };
      },
      [key],
    ),
    // Cached, so repeat calls return the same reference and React sees no change.
    () => readKey(key, initial),
  );
  const set = useCallback(
    (v: T) => {
      values.set(key, v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // storage unavailable (private window); keep in-memory state
      }
      subscribers.get(key)?.forEach((notify) => notify());
    },
    [key],
  );
  return [value, set];
}

// Shared across Settings, Organize, and Assistant so they all use one model.
export function useModel(): [string, (m: string) => void] {
  return useLocalStorageState<string>("fo.model", "anthropic/claude-sonnet-5");
}

// Shared by both duplicate scans, since the disk they read does not change
// between them.
export function useScanMode(): [ScanMode, (m: ScanMode) => void] {
  return useLocalStorageState<ScanMode>("fo.scanMode", "auto");
}

// Floor for the indexed duplicate scan, in MB. Tiny files repeat across every
// drive and produce sets that free almost nothing, so the user sets this once.
export function useDupMinMb(): [number, (m: number) => void] {
  return useLocalStorageState<number>("fo.dupMinMb", 1);
}

// Floor for what the result lists show, in MB. Nothing is re-scanned when this
// moves, so it is shared by every duplicate mode and applies the moment it
// changes.
export function useResultMinMb(): [number, (m: number) => void] {
  return useLocalStorageState<number>("fo.resultMinMb", 0);
}

// The updater plugin runs in JS, so these live in localStorage next to the other
// UI preferences rather than in the settings file the Rust side owns. Settings
// and the banner both read this hook so they cannot drift apart.
export function useUpdatePrefs(): {
  autoUpdate: boolean;
  setAutoUpdate: (v: boolean) => void;
  updateOnStartup: boolean;
  setUpdateOnStartup: (v: boolean) => void;
  updateWhileRunning: boolean;
  setUpdateWhileRunning: (v: boolean) => void;
  updateIntervalMin: number;
  setUpdateIntervalMin: (v: number) => void;
} {
  const [autoUpdate, setAutoUpdate] = useLocalStorageState<boolean>(
    "fo.autoUpdate",
    true,
  );
  const [updateOnStartup, setUpdateOnStartup] = useLocalStorageState<boolean>(
    "fo.updateOnStartup",
    true,
  );
  const [updateWhileRunning, setUpdateWhileRunning] =
    useLocalStorageState<boolean>("fo.updateWhileRunning", true);
  const [updateIntervalMin, setUpdateIntervalMin] =
    useLocalStorageState<number>("fo.updateIntervalMin", 60);
  return {
    autoUpdate,
    setAutoUpdate,
    updateOnStartup,
    setUpdateOnStartup,
    updateWhileRunning,
    setUpdateWhileRunning,
    updateIntervalMin,
    setUpdateIntervalMin,
  };
}

export function useTheme(): [Theme, (t: Theme) => void, boolean] {
  const [theme, setTheme] = useLocalStorageState<Theme>("fo.theme", "system");
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      root.classList.toggle("dark", dark);
      setIsDark(dark);
    };
    apply();
    if (theme === "system") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);
  return [theme, setTheme, isDark];
}
