import { useEffect, useRef, useState } from "react";
// Type-only: the runtime import stays dynamic so `pnpm dev` in a plain browser,
// where the plugin has nothing to talk to, still loads the app.
import type { Update } from "@tauri-apps/plugin-updater";
import { invoke, isDesktop } from "../bridge";
import { useUpdatePrefs } from "../store";

const RELEASES_URL =
  "https://github.com/Parham125/FileOrganizer/releases/latest";

// The macOS bundles are not Apple-signed or notarized, so replacing the .app in
// place lands a fresh quarantine flag on it and Gatekeeper refuses to launch the
// result. On macOS we only announce the version and send the user to the release
// page; the in-place install is Windows only.
const IS_MAC =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

// No update endpoint, no network, malformed manifest: stay quiet. A failed
// background check is silent by design, since someone who is offline or behind a
// proxy should never see an error they did not ask for. The check Settings runs
// on request reports its own failures.
async function quietCheck(): Promise<Update | null> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    return await check();
  } catch {
    return null;
  }
}

export default function UpdateBanner() {
  const { autoUpdate, updateOnStartup, updateWhileRunning, updateIntervalMin } =
    useUpdatePrefs();
  const [update, setUpdate] = useState<Update | null>(null);
  // The version string, not a flag: dismissing 1.2.0 must survive every later
  // tick for 1.2.0 while still letting 1.3.0 through.
  const [dismissed, setDismissed] = useState("");
  const [percent, setPercent] = useState<number | null>(null);
  // Read by the interval without rebuilding it, which a percent dependency would
  // do on every progress event.
  const downloading = useRef(false);
  useEffect(() => {
    if (!isDesktop || !autoUpdate || !updateOnStartup) return;
    let cancelled = false;
    void (async () => {
      const found = await quietCheck();
      if (found && !cancelled) setUpdate(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [autoUpdate, updateOnStartup]);
  useEffect(() => {
    if (!isDesktop || !autoUpdate || !updateWhileRunning) return;
    let cancelled = false;
    const timer = setInterval(
      () => {
        if (downloading.current) return;
        void (async () => {
          const found = await quietCheck();
          if (found && !cancelled) setUpdate(found);
        })();
      },
      updateIntervalMin * 60 * 1000,
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [autoUpdate, updateWhileRunning, updateIntervalMin]);
  if (!update || !autoUpdate || update.version === dismissed) return null;
  async function install() {
    if (!update) return;
    downloading.current = true;
    setPercent(0);
    let total = 0;
    let got = 0;
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          got += e.data.chunkLength;
          if (total > 0)
            setPercent(Math.min(99, Math.round((got / total) * 100)));
        } else if (e.event === "Finished") setPercent(100);
      });
    } catch {
      // The installer refused or the download broke. Fall back to the page
      // rather than leaving a stuck progress label on screen.
      setPercent(null);
      void invoke("open_file", { path: RELEASES_URL }).catch(() => {});
    } finally {
      // A download that finishes without relaunching the app, which the Linux
      // AppImage path can do, would otherwise leave this true and stop every
      // later check for the rest of the session.
      downloading.current = false;
    }
  }
  const busy = percent !== null;
  return (
    // z-0 keeps this under the result views' action footers, which are z-10 at
    // the same screen edge. A check that fires mid-selection must never land on
    // top of the trash confirmation; the banner comes back when the footer goes.
    <div className="fixed inset-x-0 bottom-0 z-0 border-t border-teal-line bg-teal-soft">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-2.5 md:px-8">
        <span className="min-w-0 flex-1 truncate text-sm text-ink">
          Version {update.version} is available.
          {IS_MAC ? " Download it from the releases page." : ""}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            IS_MAC
              ? void invoke("open_file", { path: RELEASES_URL }).catch(() => {})
              : void install()
          }
          className="inline-flex shrink-0 items-center rounded-md bg-teal px-2.5 py-1 text-xs font-medium text-white tabular-nums transition-colors hover:brightness-95 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        >
          {busy
            ? percent === 100
              ? "Installing"
              : `Downloading ${percent}%`
            : IS_MAC
              ? "Open releases"
              : "Install and restart"}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(update.version)}
          className="shrink-0 rounded-md border border-teal-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        >
          Later
        </button>
      </div>
    </div>
  );
}
