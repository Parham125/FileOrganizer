import type {
  AgentResult,
  ChatMessage,
  ContentHit,
  DupGroup,
  Move,
  PendingAction,
  Progress,
  SearchHit,
  SearchOpts,
  SimilarGroup,
  TrashItem,
} from "./types";

// Single seam between the UI and the desktop runtime. Inside Tauri we delegate
// to the real commands; in a plain browser (pnpm dev) we serve believable mock
// data so every view is usable and screenshot-able without the desktop shell.

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
    m("apartment lease signed.pdf", "Documents/Contracts", "apartment lease signed.pdf"),
    m("screenshot 2026-08-24.png", "Images/Screenshots", "screenshot 2026-08-24.png"),
    m("reykjavik-0433.jpg", "Images/Photos", "reykjavik-0433.jpg"),
    m("ridge.jpg", "Images/Photos", "ridge.jpg"),
  ];
}

// OpenAI-format transcript pieces so the assistant view can render tool activity.
function toolTurn(name: string, args: object, result: string): ChatMessage[] {
  const id = "call_" + rid();
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
      ],
    },
    { role: "tool", tool_call_id: id, name, content: result },
  ];
}

function mockBridge(): Bridge {
  const bus = new Map<string, Set<Handler<unknown>>>();
  const emit = (evt: string, payload: unknown) =>
    bus.get(evt)?.forEach((h) => h(payload));
  const files = makeFiles();
  let indexed = 24_817;
  let contentIndexed = 0;
  let watching = false;
  let hasKey = true;
  const trash: TrashItem[] = makeTrash();
  const opOrder: string[] = [...new Set(trash.map((t) => t.op_id))];

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

  const invoke = async <T>(
    cmd: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    switch (cmd) {
      case "app_version":
        return "0.1.0 (browser preview)" as T;
      case "index_stats":
        return indexed as T;
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
          if (q && !f.name.toLowerCase().includes(q) && !f.path.toLowerCase().includes(q))
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
          trash.unshift({
            id: rid(),
            op_id: op,
            original_path: p,
            size: files.find((f) => f.path === p)?.size ?? 0,
            deleted_ns: Date.now() * 1e6,
            reason,
            restored: false,
          });
        }
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
        const op = opOrder.find((o) => trash.some((t) => t.op_id === o && !t.restored));
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
      case "set_api_key":
        hasKey = String(args.key ?? "").trim().length > 0;
        return undefined as T;
      case "has_api_key":
        return hasKey as T;
      case "clear_api_key":
        hasKey = false;
        return undefined as T;
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
          const messages: ChatMessage[] = [
            ...incoming,
            ...toolTurn(
              "scan_duplicates",
              { root: "/Users/you/Downloads" },
              "Found 3 duplicate sets, 14.6 MB reclaimable.",
            ),
            {
              role: "assistant",
              content:
                "I scanned Downloads and found 3 files that are exact duplicates of copies you already keep elsewhere. I can move these extras to Trash. Nothing is deleted for good, so you can restore them anytime.",
            },
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
        const reply =
          "Your largest folders are Downloads (1.4 GB) and Pictures (830 MB). The single biggest file is a meeting recording at 1.24 GB on your Desktop. Want me to look for anything you can safely clear?";
        const messages: ChatMessage[] = [
          ...incoming,
          ...toolTurn("index_stats", {}, "24,817 files indexed."),
          { role: "assistant", content: reply },
        ];
        return { messages, pending: [], final_text: reply, done: true } as AgentResult as T;
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
        else final_text = "No problem, I left everything where it is. Nothing was changed.";
        const messages: ChatMessage[] = [...incoming];
        if (approved > 0) {
          const op = "op_" + rid();
          opOrder.unshift(op);
          messages.push(
            ...toolTurn("trash_files", { count: approved }, `Moved ${approved} files to Trash.`),
          );
          emit("index:changed", undefined);
        }
        messages.push({ role: "assistant", content: final_text });
        return { messages, pending: [], final_text, done: true } as AgentResult as T;
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
