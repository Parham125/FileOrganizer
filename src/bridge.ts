import type {
  AgentResult,
  Chat,
  ChatMessage,
  ChatSummary,
  ContentHit,
  DupGroup,
  ExtStat,
  KeyStorage,
  Move,
  PendingAction,
  Progress,
  ReasoningEffort,
  Rule,
  RuleFilter,
  RuleRun,
  SearchHit,
  SearchOpts,
  SimilarGroup,
  StorageStats,
  TrashItem,
} from "./types";

// Single seam between the UI and the desktop runtime. Inside Tauri we delegate
// to the real commands; in a plain browser (pnpm dev) we serve believable mock
// data so every view is usable and screenshot-able without the desktop shell.

const IN_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type UnlistenFn = () => void;
type Handler<T> = (payload: T) => void;

export type Bridge = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  listen: <T>(event: string, handler: Handler<T>) => Promise<UnlistenFn>;
  pickFolder: () => Promise<string | null>;
};

async function realBridge(): Promise<Bridge> {
  const core = await import("@tauri-apps/api/core");
  const event = await import("@tauri-apps/api/event");
  const dialog = await import("@tauri-apps/plugin-dialog");
  return {
    invoke: (cmd, args) => core.invoke(cmd, args),
    listen: (evt, handler) =>
      event.listen(evt, (e) => handler(e.payload as never)),
    pickFolder: async () => {
      const dir = await dialog.open({ directory: true, multiple: false });
      return typeof dir === "string" ? dir : null;
    },
  };
}

// ---- Mock runtime ---------------------------------------------------------

function rid(): string {
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const DAY = 86_400_000;
function daysAgoNs(days: number): number {
  return (Date.now() - days * DAY) * 1e6;
}

function makeFiles(): SearchHit[] {
  const raw: [string, number, number][] = [
    ["/Users/you/Documents/Q3 board deck.key", 48_200_000, 2],
    ["/Users/you/Documents/2026 tax return.pdf", 1_840_000, 6],
    ["/Users/you/Documents/apartment lease signed.pdf", 920_000, 41],
    ["/Users/you/Documents/Invoices/invoice-2214.pdf", 214_000, 9],
    ["/Users/you/Documents/Invoices/invoice-2215.pdf", 221_000, 4],
    ["/Users/you/Documents/notes/roadmap.md", 18_400, 1],
    ["/Users/you/Documents/notes/standup.md", 6_200, 0],
    ["/Users/you/Downloads/setup-arm64.dmg", 512_000_000, 12],
    ["/Users/you/Downloads/dataset-v3.csv", 88_500_000, 3],
    ["/Users/you/Downloads/dataset-v2.csv", 84_100_000, 19],
    ["/Users/you/Downloads/invoice-2214.pdf", 214_000, 9],
    ["/Users/you/Downloads/screenshot 2026-08-24.png", 3_400_000, 6],
    ["/Users/you/Downloads/font-plex.zip", 12_900_000, 33],
    ["/Users/you/Pictures/2026/reykjavik-0431.raw", 61_800_000, 22],
    ["/Users/you/Pictures/2026/reykjavik-0432.raw", 62_100_000, 22],
    ["/Users/you/Pictures/2026/reykjavik-0433.jpg", 8_900_000, 22],
    ["/Users/you/Pictures/profile.png", 640_000, 88],
    ["/Users/you/Pictures/wallpapers/ridge.jpg", 5_100_000, 54],
    ["/Users/you/Music/demos/first-take.wav", 41_300_000, 15],
    ["/Users/you/Music/demos/first-take-master.wav", 42_800_000, 7],
    ["/Users/you/Music/library/track-01.flac", 33_600_000, 120],
    ["/Users/you/Projects/fileorganizer/README.md", 2_100, 0],
    ["/Users/you/Projects/fileorganizer/Cargo.toml", 1_460, 1],
    ["/Users/you/Projects/fileorganizer/src/main.rs", 9_800, 0],
    ["/Users/you/Projects/atlas/schema.sql", 24_500, 5],
    ["/Users/you/Projects/atlas/dump-2026-07.sql", 340_000_000, 27],
    ["/Users/you/Projects/atlas/node_modules.tar", 720_000_000, 14],
    ["/Users/you/Desktop/meeting recording.mov", 1_240_000_000, 4],
    ["/Users/you/Desktop/todo.txt", 840, 0],
    ["/Users/you/Desktop/receipt.pdf", 96_000, 2],
    ["/Users/you/Archive/2019/old-invoice-2214.pdf", 214_000, 980],
    ["/Users/you/Archive/photos/scan-0001.tiff", 22_400_000, 610],
    ["/Users/you/Archive/photos/scan-0002.tiff", 22_400_000, 610],
    ["/Users/you/.cache/build/artifact.bin", 158_000_000, 1],
  ];
  return raw.map(([path, size, days]) => ({
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    size,
    modified_ns: daysAgoNs(days),
  }));
}

function makeExtStats(): ExtStat[] {
  const raw: [string, number, number][] = [
    ["mp4", 1_204, 138_200_000_000],
    ["raw", 3_180, 79_600_000_000],
    ["mov", 212, 66_400_000_000],
    ["zip", 946, 41_800_000_000],
    ["wav", 1_502, 31_800_000_000],
    ["flac", 2_744, 22_900_000_000],
    ["tar", 88, 19_100_000_000],
    ["jpg", 6_910, 15_300_000_000],
    ["sql", 143, 10_400_000_000],
    ["pdf", 2_318, 6_900_000_000],
    ["png", 3_502, 4_400_000_000],
    ["csv", 407, 3_900_000_000],
  ];
  return raw.map(([ext, count, total_size]) => ({ ext, count, total_size }));
}

function makeLargest(): SearchHit[] {
  const raw: [string, number, number][] = [
    ["/Users/you/Movies/Renders/reykjavik-cut-final.mov", 18_400_000_000, 3],
    ["/Users/you/Movies/Renders/reykjavik-cut-v3.mov", 16_900_000_000, 11],
    ["/Users/you/Movies/Footage/a7s-c0044.mp4", 12_600_000_000, 24],
    ["/Users/you/Movies/Footage/a7s-c0043.mp4", 11_800_000_000, 24],
    ["/Users/you/Movies/Footage/a7s-c0041.mp4", 9_400_000_000, 25],
    ["/Users/you/Backups/atlas-2026-08-full.tar", 8_700_000_000, 2],
    ["/Users/you/Movies/Renders/product-tour-master.mov", 7_900_000_000, 18],
    ["/Users/you/Backups/atlas-2026-07-full.tar", 7_100_000_000, 33],
    ["/Users/you/Movies/Footage/interview-cam-b.mp4", 6_400_000_000, 46],
    ["/Users/you/Movies/Footage/interview-cam-a.mp4", 6_100_000_000, 46],
    ["/Users/you/Pictures/2026/reykjavik-raw-bundle.zip", 5_800_000_000, 21],
    ["/Users/you/Music/sessions/album-stems.zip", 4_900_000_000, 58],
    ["/Users/you/Movies/Renders/teaser-30s-prores.mov", 4_200_000_000, 9],
    ["/Users/you/Projects/atlas/dump-2026-08.sql", 3_800_000_000, 1],
    ["/Users/you/VMs/ubuntu-dev.qcow2", 3_400_000_000, 6],
    ["/Users/you/Music/sessions/first-take-multitrack.wav", 2_900_000_000, 15],
    ["/Users/you/Downloads/xcode_16.4.xip", 2_600_000_000, 72],
    ["/Users/you/Pictures/2026/lightroom-catalog.lrcat", 2_200_000_000, 0],
    ["/Users/you/Movies/Footage/drone-0087.mp4", 1_900_000_000, 37],
    ["/Users/you/Backups/photos-archive-2019.tar", 1_700_000_000, 214],
    ["/Users/you/Desktop/meeting recording.mov", 1_240_000_000, 4],
    ["/Users/you/Music/sessions/mixdown-24bit.wav", 1_100_000_000, 7],
    ["/Users/you/Projects/atlas/node_modules.tar", 720_000_000, 14],
    ["/Users/you/Downloads/setup-arm64.dmg", 512_000_000, 12],
    ["/Users/you/Projects/atlas/dump-2026-07.sql", 340_000_000, 27],
  ];
  return raw.map(([path, size, days]) => ({
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    size,
    modified_ns: daysAgoNs(days),
  }));
}

function makeDupGroups(): DupGroup[] {
  return [
    {
      hash: "a19f4c07b2e18d3f",
      size: 214_000,
      paths: [
        "/Users/you/Downloads/invoice-2214.pdf",
        "/Users/you/Documents/Invoices/invoice-2214.pdf",
        "/Users/you/Archive/2019/old-invoice-2214.pdf",
      ],
    },
    {
      hash: "77be0aa9c5d41120",
      size: 22_400_000,
      paths: [
        "/Users/you/Archive/photos/scan-0001.tiff",
        "/Users/you/Archive/photos/scan-0002.tiff",
      ],
    },
    {
      hash: "e3c881504af7d962",
      size: 5_100_000,
      paths: [
        "/Users/you/Pictures/wallpapers/ridge.jpg",
        "/Users/you/Downloads/ridge.jpg",
        "/Users/you/Desktop/ridge copy.jpg",
        "/Users/you/Pictures/2026/backup/ridge.jpg",
      ],
    },
    {
      hash: "1044bdf9a7e0c635",
      size: 41_300_000,
      paths: [
        "/Users/you/Music/demos/first-take.wav",
        "/Users/you/Music/demos/backup/first-take.wav",
      ],
    },
  ];
}

function makeSimilarGroups(): SimilarGroup[] {
  return [
    {
      distance: 4,
      paths: [
        "/Users/you/Pictures/2026/reykjavik-0431.jpg",
        "/Users/you/Pictures/2026/reykjavik-0432.jpg",
        "/Users/you/Pictures/2026/reykjavik-0433.jpg",
      ],
    },
    {
      distance: 2,
      paths: [
        "/Users/you/Pictures/exports/sunset-final.jpg",
        "/Users/you/Desktop/sunset-final copy.jpg",
      ],
    },
  ];
}

function makeContentHits(query: string): ContentHit[] {
  const q = query.trim() || "budget";
  const around: [string, string, string][] = [
    [
      "/Users/you/Documents/Q3 board deck.key",
      "Revenue held flat while the ",
      " for cloud spend grew nineteen percent quarter over quarter.",
    ],
    [
      "/Users/you/Documents/2026 tax return.pdf",
      "Schedule C lists a home office ",
      " deduction of 1,240 dollars against reported income.",
    ],
    [
      "/Users/you/Documents/notes/roadmap.md",
      "Milestone two depends on the ",
      " sign-off before any hiring can start in the spring.",
    ],
    [
      "/Users/you/Documents/apartment lease signed.pdf",
      "The tenant agrees the monthly ",
      " covers water and heat but not electricity or internet.",
    ],
    [
      "/Users/you/Projects/atlas/schema.sql",
      "-- table tracks each department ",
      " line item and its remaining allocation for the year.",
    ],
  ];
  return around.map(([path, pre, post]) => ({
    path,
    snippet: `${pre}[${q}]${post}`,
  }));
}

function makeRules(): Rule[] {
  return [
    {
      id: rid(),
      name: "Old invoices",
      filter: { ext: "pdf", name_contains: "invoice", older_than_days: 90 },
      action: { type: "MoveTo", folder: "/Users/you/Documents/Invoices" },
      created_ns: daysAgoNs(64),
      last_run_ns: daysAgoNs(3),
      last_run_count: 12,
    },
    {
      id: rid(),
      name: "Big downloads",
      filter: { min_size: 52_428_800, in_folder: "/Users/you/Downloads" },
      action: { type: "Trash" },
      created_ns: daysAgoNs(21),
      last_run_ns: null,
      last_run_count: 0,
    },
  ];
}

// Mirrors match_rule in the rules crate so the preview reacts to every edit.
function matchFilter(files: SearchHit[], f: RuleFilter): SearchHit[] {
  const cutoff =
    f.older_than_days != null ? daysAgoNs(f.older_than_days) : null;
  return files.filter((file) => {
    if (f.name_contains) {
      const needle = f.name_contains.toLowerCase();
      if (!file.name.toLowerCase().includes(needle)) return false;
    }
    if (f.ext) {
      const e = f.ext.replace(/^\./, "").toLowerCase();
      if (!file.name.toLowerCase().endsWith("." + e)) return false;
    }
    if (f.min_size != null && file.size < f.min_size) return false;
    if (f.max_size != null && file.size > f.max_size) return false;
    if (
      cutoff != null &&
      (file.modified_ns == null || file.modified_ns > cutoff)
    )
      return false;
    if (f.in_folder) {
      const dir = f.in_folder.replace(/\/$/, "");
      if (!file.path.startsWith(dir + "/")) return false;
    }
    return true;
  });
}

function makeTrash(): TrashItem[] {
  const op1 = "op_" + rid();
  const op2 = "op_" + rid();
  return [
    {
      id: rid(),
      op_id: op1,
      original_path: "/Users/you/Downloads/dataset-v1.csv",
      size: 79_400_000,
      deleted_ns: daysAgoNs(1),
      reason: "dedup",
      restored: false,
    },
    {
      id: rid(),
      op_id: op1,
      original_path: "/Users/you/Downloads/dataset-v1-copy.csv",
      size: 79_400_000,
      deleted_ns: daysAgoNs(1),
      reason: "dedup",
      restored: false,
    },
    {
      id: rid(),
      op_id: op2,
      original_path: "/Users/you/Desktop/untitled-3.sketch",
      size: 4_200_000,
      deleted_ns: daysAgoNs(4),
      reason: "manual",
      restored: true,
    },
  ];
}

function makeMoves(root: string): Move[] {
  const base = root.replace(/\/$/, "");
  const m = (rel: string, sub: string, name: string): Move => ({
    from: `${base}/${rel}`,
    to: `${base}/${sub}/${name}`,
  });
  return [
    m("invoice-2214.pdf", "Documents/Invoices", "invoice-2214.pdf"),
    m("invoice-2215.pdf", "Documents/Invoices", "invoice-2215.pdf"),
    m("receipt.pdf", "Documents/Invoices", "receipt.pdf"),
    m("2026 tax return.pdf", "Documents/Taxes", "2026 tax return.pdf"),
    m(
      "apartment lease signed.pdf",
      "Documents/Contracts",
      "apartment lease signed.pdf",
    ),
    m(
      "screenshot 2026-08-24.png",
      "Images/Screenshots",
      "screenshot 2026-08-24.png",
    ),
    m("reykjavik-0433.jpg", "Images/Photos", "reykjavik-0433.jpg"),
    m("ridge.jpg", "Images/Photos", "ridge.jpg"),
  ];
}

// OpenAI-format transcript pieces so the assistant view can render tool activity.
// A model often says something before it calls a tool, so the assistant message
// can carry that prose alongside the call.
function toolTurn(
  name: string,
  args: object,
  result: string,
  prose?: string,
): ChatMessage[] {
  const id = "call_" + rid();
  return [
    {
      role: "assistant",
      content: prose ?? null,
      tool_calls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    { role: "tool", tool_call_id: id, name, content: result },
  ];
}

// The title a chat carries in the list: the first thing the user actually asked,
// trimmed to one line.
function chatTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user" && m.content);
  const text = String(first?.content ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!text) return "New chat";
  return text.length > 64 ? text.slice(0, 63).trimEnd() + "…" : text;
}

// Tool traffic is bookkeeping, so the count reflects what the reader can see.
function visibleCount(messages: ChatMessage[]): number {
  return messages.filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.content,
  ).length;
}

function makeChats(): Chat[] {
  const raw: [number, number, ChatMessage[]][] = [
    [
      0.12,
      0.08,
      [
        { role: "user", content: "Find duplicate photos in Downloads" },
        ...toolTurn(
          "find_duplicates",
          { root: "/Users/you/Downloads" },
          "Found 2 duplicate sets, 10.2 MB reclaimable.",
        ),
        {
          role: "assistant",
          content:
            "Two photos in `~/Downloads` are byte-for-byte copies of files you already keep in `~/Pictures`:\n\n- `ridge.jpg` matches `Pictures/wallpapers/ridge.jpg`\n- `reykjavik-0433.jpg` matches `Pictures/2026/reykjavik-0433.jpg`\n\nTrashing both frees 10.2 MB and everything stays restorable from the Trash view.",
        },
        { role: "user", content: "Trash the Downloads copies" },
        ...toolTurn("trash_files", { count: 2 }, "Moved 2 files to Trash."),
        {
          role: "assistant",
          content:
            "Done. Both copies are in Trash and the originals in `~/Pictures` are untouched.",
        },
      ],
    ],
    [
      0.9,
      0.7,
      [
        { role: "user", content: "Where did my Reykjavik photos end up?" },
        ...toolTurn(
          "list_folder",
          { path: "/Users/you/Pictures" },
          "4 folders, 812 files.",
          "Let me start with what is actually in `~/Pictures`.",
        ),
        ...toolTurn(
          "find_duplicates",
          { root: "/Users/you/Pictures/2026" },
          "1 duplicate set across Pictures and Downloads.",
          "They are in `Pictures/2026`, but three of the same names show up in Downloads too. Checking whether those are real copies.",
        ),
        {
          role: "assistant",
          content:
            "All 41 Reykjavik shots live in `~/Pictures/2026`. The Downloads folder has one true copy, `reykjavik-0433.jpg`, at 8.9 MB.\n\nThe two `.raw` files with matching names are different exposures, not copies, so I left them alone.",
        },
      ],
    ],
    [
      1.4,
      1.35,
      [
        { role: "user", content: "What's taking up the most space?" },
        ...toolTurn("storage_stats", {}, "460.1 GB across 24,817 files."),
        {
          role: "assistant",
          content:
            "Video is 62 percent of your 460 GB. `~/Movies/Renders` alone holds 47 GB, and the three largest files are all older cuts of the same edit:\n\n- `reykjavik-cut-final.mov`, 18.4 GB\n- `reykjavik-cut-v3.mov`, 16.9 GB\n- `product-tour-master.mov`, 7.9 GB\n\nThe v3 cut has not been opened in eleven days, so that is the safest 16.9 GB to reclaim.",
        },
      ],
    ],
    [
      6.2,
      5.9,
      [
        { role: "user", content: "Archive old invoices" },
        ...toolTurn(
          "search_files",
          { name_contains: "invoice", older_than_days: 90 },
          "9 invoice PDFs older than 90 days.",
        ),
        {
          role: "assistant",
          content:
            "Nine invoice PDFs are older than 90 days and scattered across Downloads, Desktop, and Documents. Moving them into `Documents/Invoices/2025` keeps them searchable without cluttering those folders.",
        },
        { role: "user", content: "Do it, but leave the 2026 ones alone" },
        ...toolTurn("move_files", { count: 9 }, "Moved 9 files."),
        {
          role: "assistant",
          content:
            "Moved all nine. The 2026 invoices stayed where they were. You can undo the whole move from the Trash view.",
        },
      ],
    ],
  ];
  return raw.map(([created, updated, messages]) => ({
    id: rid(),
    title: chatTitle(messages),
    created_ns: daysAgoNs(created),
    updated_ns: daysAgoNs(updated),
    messages,
  }));
}

function mockBridge(): Bridge {
  const bus = new Map<string, Set<Handler<unknown>>>();
  const emit = (evt: string, payload: unknown) =>
    bus.get(evt)?.forEach((h) => h(payload));
  const files = makeFiles();
  const byExt = makeExtStats();
  let largest = makeLargest();
  let storedSize = 460_100_000_000;
  let indexed = 24_817;
  let contentIndexed = 0;
  let watching = false;
  let hasKey = true;
  let effort: ReasoningEffort = "medium";
  let keyStorage: KeyStorage = "keychain";
  const trash: TrashItem[] = makeTrash();
  const opOrder: string[] = [...new Set(trash.map((t) => t.op_id))];
  const rules: Rule[] = makeRules();
  const chats: Chat[] = makeChats();
  // What each rule run took out of the mock index, so undo can put it back.
  const undoable = new Map<string, { file: SearchHit; from: string }[]>();

  function ramp(evt: string, total: number, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const steps = 24;
      let i = 0;
      const tick = () => {
        i++;
        const done = Math.round((i / steps) * total);
        emit(evt, { done, total } as Progress);
        if (i >= steps) resolve();
        else setTimeout(tick, ms / steps);
      };
      emit(evt, { done: 0, total } as Progress);
      setTimeout(tick, ms / steps);
    });
  }

  function rampText(evt: string, steps: string[], ms: number): Promise<void> {
    return new Promise((resolve) => {
      let i = 0;
      const tick = () => {
        emit(evt, steps[i]);
        i++;
        if (i >= steps.length) resolve();
        else setTimeout(tick, ms / steps.length);
      };
      tick();
    });
  }

  // Mirrors the desktop agent loop: a thinking beat, the reasoning the model
  // works through when effort is on, whatever it says before it reaches for a
  // tool, each read tool opening and closing, then the reply a word at a time.
  async function streamTurn(
    lead: string,
    tools: string[],
    text: string,
    think = "",
  ): Promise<void> {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    emit("ai:step", { kind: "thinking" });
    await wait(200);
    for (const frag of effort === "off" || !think
      ? []
      : think.split(/(?<=\s)/)) {
      emit("ai:reasoning", frag);
      await wait(10);
    }
    if (think) await wait(200);
    for (const frag of lead ? lead.split(/(?<=\s)/) : []) {
      emit("ai:delta", frag);
      await wait(14);
    }
    if (lead) await wait(180);
    for (const name of tools) {
      emit("ai:step", { kind: "tool", name });
      await wait(320);
      emit("ai:step", { kind: "tool_done", name });
      await wait(110);
    }
    emit("ai:step", { kind: "thinking" });
    await wait(150);
    for (const frag of text.split(/(?<=\s)/)) {
      emit("ai:delta", frag);
      await wait(14);
    }
  }

  const invoke = async <T>(
    cmd: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    switch (cmd) {
      case "app_version":
        return "0.1.0 (browser preview)" as T;
      case "index_stats":
        return indexed as T;
      case "storage_stats":
        return {
          files: indexed,
          total_size: storedSize,
          largest,
          by_ext: byExt,
        } as StorageStats as T;
      case "index_folder": {
        await ramp("index:progress", 8_421, 1400);
        indexed += 8_421;
        return indexed as T;
      }
      case "start_watch":
        watching = true;
        void watching;
        return undefined as T;
      case "search": {
        const q = String(args.query ?? "")
          .trim()
          .toLowerCase();
        const opts = (args.opts ?? {}) as SearchOpts;
        let out = files.filter((f) => {
          if (
            q &&
            !f.name.toLowerCase().includes(q) &&
            !f.path.toLowerCase().includes(q)
          )
            return false;
          if (opts.ext) {
            const e = opts.ext.replace(/^\./, "").toLowerCase();
            if (!f.name.toLowerCase().endsWith("." + e)) return false;
          }
          if (opts.min_size != null && f.size < opts.min_size) return false;
          if (opts.max_size != null && f.size > opts.max_size) return false;
          return true;
        });
        out = out.sort((a, b) => b.size - a.size);
        if (opts.limit) out = out.slice(0, opts.limit);
        return out as T;
      }
      case "scan_duplicates": {
        await ramp("dedup:progress", 1_204, 1300);
        return makeDupGroups() as T;
      }
      case "scan_similar_images": {
        await ramp("similar:progress", 3_190, 1300);
        return makeSimilarGroups() as T;
      }
      case "index_content": {
        await ramp("content:progress", 612, 1500);
        contentIndexed = 612;
        return contentIndexed as T;
      }
      case "search_content": {
        const q = String(args.query ?? "").trim();
        if (!q) return [] as ContentHit[] as T;
        const limit = (args.limit as number) ?? 20;
        return makeContentHits(q).slice(0, limit) as T;
      }
      case "trash_files": {
        const paths = (args.paths as string[]) ?? [];
        const reason = String(args.reason ?? "manual");
        const op = "op_" + rid();
        opOrder.unshift(op);
        for (const p of paths) {
          const size =
            files.find((f) => f.path === p)?.size ??
            largest.find((f) => f.path === p)?.size ??
            0;
          trash.unshift({
            id: rid(),
            op_id: op,
            original_path: p,
            size,
            deleted_ns: Date.now() * 1e6,
            reason,
            restored: false,
          });
          storedSize -= size;
          indexed -= 1;
        }
        largest = largest.filter((f) => !paths.includes(f.path));
        emit("index:changed", undefined);
        return op as T;
      }
      case "list_trash": {
        const limit = (args.limit as number) ?? trash.length;
        return trash.slice(0, limit) as T;
      }
      case "restore_op": {
        const op = String(args.op_id ?? args.opId);
        const restored: string[] = [];
        for (const t of trash)
          if (t.op_id === op && !t.restored) {
            t.restored = true;
            restored.push(t.original_path);
          }
        emit("index:changed", undefined);
        return restored as T;
      }
      case "restore_item": {
        const id = String(args.id);
        const it = trash.find((t) => t.id === id);
        if (it) it.restored = true;
        emit("index:changed", undefined);
        return (it?.original_path ?? "") as T;
      }
      case "undo_last": {
        const move = opOrder.find((o) => undoable.has(o));
        if (move && opOrder.indexOf(move) === 0) {
          const back = undoable.get(move)!;
          for (const { file, from } of back) {
            file.path = from;
            file.name = from.slice(from.lastIndexOf("/") + 1);
            if (!files.includes(file)) {
              files.push(file);
              indexed += 1;
              storedSize += file.size;
            }
          }
          undoable.delete(move);
          opOrder.shift();
          for (let i = trash.length - 1; i >= 0; i--)
            if (trash[i].op_id === move) trash.splice(i, 1);
          emit("index:changed", undefined);
          return back.map((b) => b.from) as T;
        }
        const op = opOrder.find((o) =>
          trash.some((t) => t.op_id === o && !t.restored),
        );
        const restored: string[] = [];
        if (op)
          for (const t of trash)
            if (t.op_id === op && !t.restored) {
              t.restored = true;
              restored.push(t.original_path);
            }
        emit("index:changed", undefined);
        return restored as T;
      }
      case "empty_trash": {
        trash.length = 0;
        opOrder.length = 0;
        emit("index:changed", undefined);
        return undefined as T;
      }
      case "open_file":
      case "reveal_file":
        return undefined as T;
      case "purge_trash_item": {
        const id = String(args.itemId ?? args.item_id);
        const idx = trash.findIndex((t) => t.id === id);
        if (idx >= 0) trash.splice(idx, 1);
        emit("index:changed", undefined);
        return undefined as T;
      }
      case "purge_trash_op": {
        const op = String(args.opId ?? args.op_id);
        for (let i = trash.length - 1; i >= 0; i--)
          if (trash[i].op_id === op) trash.splice(i, 1);
        emit("index:changed", undefined);
        return undefined as T;
      }
      case "list_rules":
        return [...rules] as T;
      case "create_rule": {
        const rule: Rule = {
          id: rid(),
          name: String(args.name ?? "Untitled rule"),
          filter: (args.filter ?? {}) as RuleFilter,
          action: (args.action ?? { type: "Trash" }) as Rule["action"],
          created_ns: Date.now() * 1e6,
          last_run_ns: null,
          last_run_count: 0,
        };
        rules.push(rule);
        return rule as T;
      }
      case "update_rule": {
        const next = args.rule as Rule;
        const i = rules.findIndex((r) => r.id === next.id);
        if (i >= 0) rules[i] = { ...rules[i], ...next };
        return undefined as T;
      }
      case "delete_rule": {
        const i = rules.findIndex((r) => r.id === String(args.id));
        if (i >= 0) rules.splice(i, 1);
        return undefined as T;
      }
      case "preview_rule": {
        const limit = (args.limit as number) ?? 500;
        return matchFilter(files, (args.filter ?? {}) as RuleFilter)
          .sort((a, b) => b.size - a.size)
          .slice(0, limit) as T;
      }
      case "run_rule": {
        const rule = rules.find((r) => r.id === String(args.id));
        if (!rule) throw new Error(`no rule with id ${args.id}`);
        const hits = matchFilter(files, rule.filter);
        const op = "op_" + rid();
        if (hits.length > 0) {
          opOrder.unshift(op);
          const back: { file: SearchHit; from: string }[] = [];
          for (const hit of hits) {
            back.push({ file: hit, from: hit.path });
            files.splice(files.indexOf(hit), 1);
            indexed -= 1;
            if (rule.action.type === "Trash") {
              storedSize -= hit.size;
              trash.unshift({
                id: rid(),
                op_id: op,
                original_path: hit.path,
                size: hit.size,
                deleted_ns: Date.now() * 1e6,
                reason: "rule",
                restored: false,
              });
            } else {
              const dir = rule.action.folder.replace(/\/$/, "");
              hit.path = `${dir}/${hit.name}`;
              files.push(hit);
              indexed += 1;
            }
          }
          undoable.set(op, back);
        }
        rule.last_run_ns = Date.now() * 1e6;
        rule.last_run_count = hits.length;
        emit("index:changed", undefined);
        return {
          op_id: hits.length > 0 ? op : "",
          count: hits.length,
        } as RuleRun as T;
      }
      case "set_api_key":
        hasKey = String(args.key ?? "").trim().length > 0;
        return undefined as T;
      case "has_api_key":
        return hasKey as T;
      case "clear_api_key":
        hasKey = false;
        return undefined as T;
      case "get_key_storage":
        return keyStorage as T;
      case "set_key_storage": {
        const next = String(args.storage ?? "");
        if (next !== "keychain" && next !== "file")
          throw new Error(`Unknown key storage: ${next}`);
        await new Promise((r) => setTimeout(r, 220));
        keyStorage = next;
        return undefined as T;
      }
      case "get_reasoning_effort":
        return effort as T;
      case "set_reasoning_effort": {
        const next = String(args.effort ?? "");
        if (!["off", "low", "medium", "high"].includes(next))
          throw new Error(`Unknown reasoning effort: ${next}`);
        effort = next as ReasoningEffort;
        return undefined as T;
      }
      case "ai_propose_organization": {
        if (!hasKey) throw new Error("No API key set");
        await rampText(
          "ai:progress",
          [
            "Reading folder contents",
            "Grouping 34 files by type and topic",
            "Drafting a folder structure",
            "Checking for naming conflicts",
          ],
          1600,
        );
        return makeMoves(String(args.root ?? "/Users/you/Downloads")) as T;
      }
      case "ai_apply_organization": {
        const op = "op_" + rid();
        opOrder.unshift(op);
        emit("index:changed", undefined);
        return op as T;
      }
      case "ai_agent": {
        if (!hasKey) throw new Error("No API key set");
        const incoming = (args.messages as ChatMessage[]) ?? [];
        const last =
          [...incoming].reverse().find((m) => m.role === "user")?.content ?? "";
        const text = String(last).toLowerCase();
        const wantsAction =
          /duplicate|trash|delete|remove|organi|clean|tidy|move/.test(text);
        if (wantsAction) {
          const paths = [
            "/Users/you/Downloads/invoice-2214.pdf",
            "/Users/you/Downloads/ridge.jpg",
            "/Users/you/Desktop/ridge copy.jpg",
          ];
          const reply = [
            "I hashed everything under `~/Downloads` and found **3 files** that are byte-for-byte copies of files you keep elsewhere. Trashing the extras frees 14.6 MB.",
            "",
            "| Keeping | Extra copy | Size |",
            "| --- | --- | --- |",
            "| `Documents/Invoices/invoice-2214.pdf` | `Downloads/invoice-2214.pdf` | 214 KB |",
            "| `Pictures/wallpapers/ridge.jpg` | `Downloads/ridge.jpg` | 5.1 MB |",
            "| `Pictures/wallpapers/ridge.jpg` | `Desktop/ridge copy.jpg` | 5.1 MB |",
            "",
            "Trash is reversible here, so anything you change your mind about comes back from the Trash view.",
          ].join("\n");
          const lead = "Hashing everything under `~/Downloads` first.";
          await streamTurn(
            lead,
            ["find_duplicates"],
            reply,
            "Name matches are not enough to call two files duplicates, so I want content hashes before I claim anything. Run find_duplicates over Downloads, then keep the copy in the folder that looks deliberate (Documents, Pictures) and offer the Downloads copy for Trash. Trashing is journalled and reversible, so staging it for approval is safe as long as I never touch the copy being kept.",
          );
          emit("ai:step", { kind: "awaiting_approval" });
          emit("ai:done", undefined);
          const messages: ChatMessage[] = [
            ...incoming,
            ...toolTurn(
              "find_duplicates",
              { root: "/Users/you/Downloads" },
              "Found 3 duplicate sets, 14.6 MB reclaimable.",
              lead,
            ),
            { role: "assistant", content: reply },
          ];
          const pending: PendingAction[] = [
            {
              id: "act_" + rid(),
              name: "trash_files",
              summary: "Move 3 duplicate files to Trash, reclaiming 14.6 MB",
              args: { paths, reason: "assistant" },
            },
          ];
          return {
            messages,
            pending,
            final_text: messages[messages.length - 1].content ?? null,
            done: false,
          } as AgentResult as T;
        }
        const reply = [
          "Across the **24,817 files** in the index, `~/Downloads` is the heaviest folder at 1.4 GB, and almost none of it has been opened in the last month.",
          "",
          "Three things stand out:",
          "",
          "- `setup-arm64.dmg` at 512 MB, an installer you already ran",
          "- `dataset-v2.csv` and `dataset-v3.csv`, near-identical exports",
          "- `meeting recording.mov` on the Desktop, 1.24 GB by itself",
          "",
          "The same list from a shell, if you want to check my work:",
          "",
          "```sh",
          "find ~/Downloads -type f -size +100M -mtime +30 \\",
          '  -exec du -h "{}" + | sort -rh | head',
          "```",
          "",
          "Say the word and I will stage the safe ones for Trash.",
        ].join("\n");
        const lead = "Let me check the index and the biggest files first.";
        await streamTurn(
          lead,
          ["index_stats", "search_files"],
          reply,
          "Walking the whole tree would be slow and I already have an index, so index_stats for the totals and then search_files with a size floor around 100 MB. Downloads is usually the heaviest folder but I should confirm that from the numbers rather than assume it. Size alone is not a reason to delete something, so pair it with last-opened dates and let the user decide.",
        );
        emit("ai:done", undefined);
        const messages: ChatMessage[] = [
          ...incoming,
          ...toolTurn("index_stats", {}, "24,817 files indexed.", lead),
          ...toolTurn(
            "search_files",
            { min_size: 104_857_600 },
            "12 files over 100 MB.",
          ),
          { role: "assistant", content: reply },
        ];
        return {
          messages,
          pending: [],
          final_text: reply,
          done: true,
        } as AgentResult as T;
      }
      case "ai_agent_continue": {
        const incoming = (args.messages as ChatMessage[]) ?? [];
        const approvals =
          (args.approvals as { id: string; approved: boolean }[]) ?? [];
        const approved = approvals.filter((a) => a.approved).length;
        const skipped = approvals.length - approved;
        let final_text: string;
        if (approved > 0 && skipped > 0)
          final_text = `Done. I moved ${approved} file${approved === 1 ? "" : "s"} to Trash and left the ${skipped} you skipped in place. Restore anything from the Trash view.`;
        else if (approved > 0)
          final_text = `Done. I moved ${approved} file${approved === 1 ? "" : "s"} to Trash. You can restore them anytime from the Trash view.`;
        else
          final_text =
            "No problem, I left everything where it is. Nothing was changed.";
        await streamTurn(
          "",
          approved > 0 ? ["trash_files"] : [],
          final_text,
          "Only the approved paths go through. The skipped ones stay exactly where they are, and I should say so plainly instead of glossing over them.",
        );
        emit("ai:done", undefined);
        const messages: ChatMessage[] = [...incoming];
        if (approved > 0) {
          const op = "op_" + rid();
          opOrder.unshift(op);
          messages.push(
            ...toolTurn(
              "trash_files",
              { count: approved },
              `Moved ${approved} files to Trash.`,
            ),
          );
          emit("index:changed", undefined);
        }
        messages.push({ role: "assistant", content: final_text });
        return {
          messages,
          pending: [],
          final_text,
          done: true,
        } as AgentResult as T;
      }
      case "list_chats": {
        const limit = (args.limit as number) ?? 100;
        return chats
          .slice()
          .sort((a, b) => b.updated_ns - a.updated_ns)
          .slice(0, limit)
          .map(
            (c) =>
              ({
                id: c.id,
                title: c.title,
                created_ns: c.created_ns,
                updated_ns: c.updated_ns,
                message_count: visibleCount(c.messages),
              }) as ChatSummary,
          ) as T;
      }
      case "get_chat": {
        const c = chats.find((x) => x.id === String(args.id));
        return (c ? { ...c, messages: [...c.messages] } : null) as T;
      }
      case "save_chat": {
        const messages = (args.messages as ChatMessage[]) ?? [];
        const id = args.id == null ? null : String(args.id);
        const now = Date.now() * 1e6;
        const existing = id ? chats.find((c) => c.id === id) : undefined;
        if (existing) {
          existing.messages = [...messages];
          existing.title = chatTitle(messages);
          existing.updated_ns = now;
          return { ...existing } as T;
        }
        const chat: Chat = {
          id: rid(),
          title: chatTitle(messages),
          created_ns: now,
          updated_ns: now,
          messages: [...messages],
        };
        chats.push(chat);
        return { ...chat } as T;
      }
      case "rename_chat": {
        const c = chats.find((x) => x.id === String(args.id));
        if (c) c.title = String(args.title ?? "").trim() || c.title;
        return undefined as T;
      }
      case "delete_chat": {
        const i = chats.findIndex((c) => c.id === String(args.id));
        if (i >= 0) chats.splice(i, 1);
        return undefined as T;
      }
      case "clear_chats": {
        chats.length = 0;
        return undefined as T;
      }
      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  };

  return {
    invoke,
    listen: async (evt, handler) => {
      let set = bus.get(evt);
      if (!set) bus.set(evt, (set = new Set()));
      const h = handler as Handler<unknown>;
      set.add(h);
      return () => set!.delete(h);
    },
    pickFolder: async () => "/Users/you/Downloads",
  };
}

let cached: Bridge | null = null;
async function get(): Promise<Bridge> {
  if (cached) return cached;
  cached = IN_TAURI ? await realBridge() : mockBridge();
  return cached;
}

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return (await get()).invoke<T>(cmd, args);
}

export async function listen<T>(
  event: string,
  handler: Handler<T>,
): Promise<UnlistenFn> {
  return (await get()).listen<T>(event, handler);
}

export async function pickFolder(): Promise<string | null> {
  return (await get()).pickFolder();
}

export const isDesktop = IN_TAURI;
