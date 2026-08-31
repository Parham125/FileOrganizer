import { useCallback, useEffect, useState } from "react";
import type { ScanMode, Theme } from "./types";

export function useLocalStorageState<T>(
  key: string,
  initial: T,
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // storage unavailable (private window); keep in-memory state
      }
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
