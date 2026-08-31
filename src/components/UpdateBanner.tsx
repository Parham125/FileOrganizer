import { useEffect, useState } from "react";
// Type-only: the runtime import stays dynamic so `pnpm dev` in a plain browser,
// where the plugin has nothing to talk to, still loads the app.
import type { Update } from "@tauri-apps/plugin-updater";
import { invoke, isDesktop } from "../bridge";

const RELEASES_URL =
  "https://github.com/Parham125/FileOrganizer/releases/latest";

// The macOS bundles are not Apple-signed or notarized, so replacing the .app in
// place lands a fresh quarantine flag on it and Gatekeeper refuses to launch the
// result. On macOS we only announce the version and send the user to the release
// page; the in-place install is Windows only.
const IS_MAC =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

// A failed check is silent by design: someone who is offline or behind a proxy
// should never see an error they did not ask for.
export default function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    void (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const found = await check();
        if (found && !cancelled) setUpdate(found);
      } catch {
        // No update endpoint, no network, malformed manifest: stay quiet.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  if (!update || dismissed) return null;
  async function install() {
    if (!update) return;
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
    }
  }
  const busy = percent !== null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-teal-line bg-teal-soft">
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
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded-md border border-teal-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        >
          Later
        </button>
      </div>
    </div>
  );
}
