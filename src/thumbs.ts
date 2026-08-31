import { useEffect, useState } from "react";
import { invoke } from "./bridge";
import type { Thumb } from "./types";

// Previews for the rows on screen and nothing else. The target is often a slow
// external drive, so a thumbnail is only ever asked for once per path and size:
// everything already answered lives in the module cache below and survives
// paging, filtering and switching views.

// What the thumbnail backend can decode. Anything else never leaves the app.
const IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "webp",
  "tiff",
  "tif",
]);

// The command truncates past this, so the caller has to chunk.
const PER_CALL = 200;
// Leading previews next to a filename, at 2x for a 40 to 48px box.
export const SMALL_PX = 96;
// The comparison grid in Similar images, where the picture is the decision.
export const LARGE_PX = 256;
// Roughly 4k previews of a few KB each. Past this the oldest go, so a long
// session over a big drive cannot grow without end.
const MAX_ENTRIES = 4000;

// path|maxPx -> data URI, or null once the backend answered with nothing to
// show. Module level on purpose: paging back to a set must not refetch it.
const cache = new Map<string, string | null>();
// The batch each pending path is riding in, so two lists asking for the same
// row at the same time produce one request.
const inflight = new Map<string, Promise<void>>();

export function isImage(path: string): boolean {
  const dot = path.lastIndexOf(".");
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (dot <= cut + 1) return false;
  return IMAGE_EXTS.has(path.slice(dot + 1).toLowerCase());
}

function keyOf(path: string, maxPx: number): string {
  return `${path}|${maxPx}`;
}

function remember(key: string, uri: string | null) {
  cache.set(key, uri);
  if (cache.size <= MAX_ENTRIES) return;
  const drop = cache.size - MAX_ENTRIES;
  let i = 0;
  for (const k of cache.keys()) {
    if (i++ >= drop) break;
    cache.delete(k);
  }
}

// Every path in a batch is resolved either way, so a path the backend skipped
// or a failed call cannot leave a row asking for the same preview forever.
async function fetchBatch(paths: string[], maxPx: number): Promise<void> {
  const run = (async () => {
    try {
      const out = await invoke<Thumb[]>("get_thumbnails", { paths, maxPx });
      for (const t of out) remember(keyOf(t.path, maxPx), t.data_uri);
    } catch {
      // A failed batch leaves the placeholder. There is no per-row error to
      // show here: the row is about the file, not about its preview.
    }
    for (const p of paths) {
      const k = keyOf(p, maxPx);
      if (!cache.has(k)) remember(k, null);
    }
  })();
  for (const p of paths) inflight.set(keyOf(p, maxPx), run);
  try {
    await run;
  } finally {
    for (const p of paths)
      if (inflight.get(keyOf(p, maxPx)) === run)
        inflight.delete(keyOf(p, maxPx));
  }
}

// Previews for exactly the paths handed in, which the views build from the rows
// they are rendering right now. Returns a reader: a data URI once one arrives,
// null when there is nothing to show, undefined while it is still coming.
export function useThumbs(
  paths: string[],
  maxPx: number = SMALL_PX,
): (path: string) => string | null | undefined {
  const [, bump] = useState(0);
  // One string so the effect runs on a real change of the visible rows rather
  // than on every render of a freshly sliced array.
  const wanted = paths.filter(isImage).join("\n");
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    const todo: string[] = [];
    const waits: Promise<void>[] = [];
    const seen = new Set<string>();
    for (const path of wanted.split("\n")) {
      const k = keyOf(path, maxPx);
      if (cache.has(k) || seen.has(k)) continue;
      seen.add(k);
      const busy = inflight.get(k);
      if (busy) waits.push(busy);
      else todo.push(path);
    }
    for (let i = 0; i < todo.length; i += PER_CALL)
      waits.push(fetchBatch(todo.slice(i, i + PER_CALL), maxPx));
    // Per batch, so a long page fills in as the previews land instead of all at
    // once when the last one is done.
    for (const w of waits)
      void w.then(() => {
        if (live) bump((n) => n + 1);
      });
    return () => {
      live = false;
    };
  }, [wanted, maxPx]);
  return (path: string) => cache.get(keyOf(path, maxPx));
}

// Called after the disk cache is emptied in Settings, so the app stops showing
// previews it no longer has.
export function forgetThumbs() {
  cache.clear();
}
