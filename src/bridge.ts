import type {
  AgentResult,
  AppDataSummary,
  ApplyOrganization,
  Chat,
  ChatMessage,
  ChatSummary,
  ContentHit,
  DupGroup,
  DupScanResult,
  ExactCheck,
  ExactGroup,
  ExtStat,
  IndexResult,
  KeyStorage,
  Move,
  NameGroup,
  NameScanResult,
  NameStrategy,
  PathStatus,
  PendingAction,
  Progress,
  QuestionAnswer,
  ReasoningEffort,
  ResultSnapshot,
  RootStatus,
  Rule,
  RuleFilter,
  RuleRun,
  SearchHit,
  SearchOpts,
  SimilarGroup,
  SimilarScanResult,
  SkippedItem,
  StorageStats,
  Thumb,
  TrashItem,
  TrashOutcome,
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
  pickSaveFile: (defaultPath: string) => Promise<string | null>;
  pickOpenFile: () => Promise<string | null>;
};

const RESULTS_FILTER = [
  { name: "FileOrganizer results", extensions: ["json"] },
];

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
    pickSaveFile: async (defaultPath) =>
      await dialog.save({ defaultPath, filters: RESULTS_FILTER }),
    pickOpenFile: async () => {
      const file = await dialog.open({
        directory: false,
        multiple: false,
        filters: RESULTS_FILTER,
      });
      return typeof file === "string" ? file : null;
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

// The four sets a reader recognises from the rest of the mock, then enough
// filler to look like a real drive: a big scan runs to thousands of sets, and
// the list has to stay usable at that size.
function makeDupGroups(): DupGroup[] {
  const groups: DupGroup[] = [
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
  const stems: [string, string, number][] = [
    ["invoice", "pdf", 214_000],
    ["scan", "tiff", 22_400_000],
    ["headshot", "png", 3_400_000],
    ["first-take", "wav", 41_300_000],
    ["board-deck", "key", 48_200_000],
    ["dataset", "csv", 88_500_000],
    ["lease", "pdf", 920_000],
    ["drone", "mp4", 1_900_000_000],
    ["logo-mark", "svg", 18_400],
    ["schema", "sql", 24_500],
    ["mixdown", "wav", 1_100_000_000],
    ["reykjavik", "jpg", 8_900_000],
  ];
  const folders = [
    "/Users/you/Downloads",
    "/Users/you/Desktop",
    "/Users/you/Documents/Scans",
    "/Users/you/Pictures/2026",
    "/Users/you/Pictures/exports",
    "/Users/you/Archive/2019",
    "/Users/you/Music/demos",
    "/Users/you/Projects/atlas/assets",
  ];
  for (let i = 0; i < 116; i++) {
    const [stem, ext, size] = stems[i % stems.length];
    const copies = 2 + (i % 3);
    groups.push({
      hash: rid().slice(0, 16),
      size,
      paths: Array.from(
        { length: copies },
        (_, c) =>
          `${folders[(i + c * 3) % folders.length]}/${stem}-${1000 + i}${c === 0 ? "" : c === 1 ? " copy" : ` copy ${c}`}.${ext}`,
      ),
    });
  }
  return groups;
}

// The indexed scan reads every folder the user added, so its sets straddle
// drives: the working copy on the system drive, the archived copy on whatever
// external volume was indexed. Sizes are spread on purpose so a size floor
// visibly changes how much comes back.
function makeIndexedDupGroups(): DupGroup[] {
  const groups: DupGroup[] = [
    {
      hash: "b4d1907ac6e35f82",
      size: 22_400_000,
      paths: [
        "/Users/you/Archive/photos/scan-0001.tiff",
        "/Volumes/Archive/scans/1998/scan-0001.tiff",
        "/Volumes/Archive/scans/negatives/scan-0001.tiff",
      ],
    },
    {
      hash: "0f72c8ad5b31e604",
      size: 1_240_000_000,
      paths: [
        "/Users/you/Desktop/meeting recording.mov",
        "/Volumes/Archive/media/renders/meeting recording.mov",
      ],
    },
    {
      hash: "9ac4e1f80d27b553",
      size: 8_900_000,
      paths: [
        "/Users/you/Pictures/2026/reykjavik-0433.jpg",
        "/Volumes/Archive/media/2026/reykjavik-0433.jpg",
        "/Users/you/Pictures/exports/reykjavik-0433.jpg",
      ],
    },
    {
      hash: "5e60b3c92f814a7d",
      size: 214_000,
      paths: [
        "/Users/you/Documents/Invoices/invoice-2214.pdf",
        "/Volumes/Archive/scans/2019/invoice-2214.pdf",
      ],
    },
  ];
  const stems: [string, string, number][] = [
    ["logo-mark", "svg", 18_400],
    ["schema", "sql", 24_500],
    ["invoice", "pdf", 214_000],
    ["lease", "pdf", 920_000],
    ["headshot", "png", 3_400_000],
    ["ridge", "jpg", 5_100_000],
    ["reykjavik", "jpg", 8_900_000],
    ["scan", "tiff", 22_400_000],
    ["first-take", "wav", 41_300_000],
    ["board-deck", "key", 48_200_000],
    ["dataset", "csv", 88_500_000],
    ["dump-2026-07", "sql", 340_000_000],
    ["mixdown", "wav", 1_100_000_000],
    ["drone", "mp4", 1_900_000_000],
  ];
  const folders = [
    "/Users/you/Documents/Scans",
    "/Users/you/Pictures/2026",
    "/Users/you/Pictures/exports",
    "/Users/you/Music/demos",
    "/Volumes/Archive/scans/2019",
    "/Volumes/Archive/scans/negatives",
    "/Volumes/Archive/media/renders",
    "/Volumes/Archive/media/2026",
  ];
  for (let i = 0; i < 116; i++) {
    const [stem, ext, size] = stems[i % stems.length];
    const copies = 2 + (i % 3);
    groups.push({
      hash: rid().slice(0, 16),
      size,
      // Offsetting the second copy by four lands it on the other side of the
      // folder list, so most sets span the system drive and the volume.
      paths: Array.from(
        { length: copies },
        (_, c) =>
          `${folders[(i + c * 4 + 1) % folders.length]}/${stem}-${1000 + i}${c === 0 ? "" : c === 1 ? " copy" : ` copy ${c}`}.${ext}`,
      ),
    });
  }
  return groups;
}

function makeSimilarGroups(): SimilarGroup[] {
  const f = (path: string, size: number, days: number) => ({
    path,
    size,
    modified_ns: daysAgoNs(days),
  });
  return [
    {
      distance: 4,
      files: [
        f("/Users/you/Pictures/2026/reykjavik-0431.jpg", 61_800_000, 22),
        f("/Users/you/Pictures/2026/reykjavik-0432.jpg", 62_100_000, 22),
        f("/Users/you/Pictures/2026/reykjavik-0433.jpg", 8_900_000, 22),
      ],
    },
    {
      distance: 2,
      files: [
        f("/Users/you/Pictures/exports/sunset-final.jpg", 5_100_000, 54),
        f("/Users/you/Desktop/sunset-final copy.jpg", 5_090_000, 12),
      ],
    },
    {
      distance: 6,
      files: [
        f("/Users/you/Pictures/2026/harbour-burst-01.jpg", 7_400_000, 31),
        f("/Users/you/Pictures/2026/harbour-burst-02.jpg", 7_390_000, 31),
        f("/Users/you/Pictures/2026/harbour-burst-03.jpg", 7_420_000, 31),
        f("/Users/you/Pictures/exports/harbour-burst-edit.jpg", 4_100_000, 8),
      ],
    },
    // One set the trash cannot fully empty, so a partial move is drivable here
    // the way it is in the other lists: the mock refuses an unreachable
    // /Volumes path and anything named "locked".
    {
      distance: 3,
      files: [
        f("/Users/you/Pictures/2026/quarry-locked.jpg", 6_200_000, 44),
        f("/Volumes/Archive/photos/quarry-012.jpg", 6_180_000, 44),
        f("/Users/you/Pictures/exports/quarry-012.jpg", 3_050_000, 19),
      ],
    },
  ];
}

// ---- Stand-in previews ----------------------------------------------------
// Real JPEG data URIs drawn on a canvas, so the browser preview shows actual
// pictures. The drawing is keyed off the name with its copy markers and frame
// numbers stripped, which is what makes a look-alike set come back looking
// alike, the same way the desktop build would.

const drawn = new Map<string, string>();

function hashOf(text: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return Math.abs(h);
}

function mockThumb(path: string, px: number): string {
  const key = `${path}|${px}`;
  const had = drawn.get(key);
  if (had) return had;
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  let stem = name.replace(/\.[a-z0-9]+$/, "");
  // Strip trailing markers until nothing is left to strip, so "sunset-final"
  // and "sunset-final copy" collapse to the same picture.
  for (let i = 0; i < 4; i++)
    stem = stem.replace(/[\s_-]*(copy|final|edit|master|\d+)$/, "");
  const set = hashOf(stem);
  const own = hashOf(path);
  const portrait = set % 5 === 0;
  const w = portrait ? Math.round(px * 0.75) : px;
  const h = portrait ? px : Math.round(px * 0.72);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;
  const hue = set % 360;
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, `hsl(${hue} 52% ${28 + (own % 7)}%)`);
  sky.addColorStop(1, `hsl(${(hue + 38) % 360} 62% ${64 + (own % 9)}%)`);
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  g.fillStyle = `hsl(${(hue + 190) % 360} 40% 22%)`;
  g.beginPath();
  g.moveTo(0, h);
  g.lineTo(0, h * 0.66);
  g.lineTo(w * 0.34, h * (0.46 + (own % 5) / 60));
  g.lineTo(w * 0.62, h * 0.7);
  g.lineTo(w, h * 0.52);
  g.lineTo(w, h);
  g.closePath();
  g.fill();
  g.fillStyle = `hsl(${(hue + 20) % 360} 90% 78%)`;
  g.beginPath();
  g.arc(w * (0.2 + (own % 11) / 24), h * 0.28, px / 12, 0, Math.PI * 2);
  g.fill();
  const uri = canvas.toDataURL("image/jpeg", 0.72);
  drawn.set(key, uri);
  return uri;
}

const THUMB_EXTS = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif"];

function looksLikeImage(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > 0 && THUMB_EXTS.includes(path.slice(dot + 1).toLowerCase());
}

// ---- Saved results --------------------------------------------------------
// The snapshot the browser preview opens: 40 files across 15 sets, written
// before someone cleared out the negatives folder.

const SNAPSHOT_GONE = "/Volumes/Archive/scans/negatives/";
const SNAPSHOT_RESIZED = new Set([
  "/Users/you/Pictures/exports/reykjavik-0433.jpg",
  "/Users/you/Downloads/ridge.jpg",
]);

function makeSnapshotGroups(): DupGroup[] {
  const raw: [number, string[]][] = [
    [
      22_400_000,
      [
        "/Users/you/Archive/photos/scan-0001.tiff",
        "/Volumes/Archive/scans/1998/scan-0001.tiff",
        "/Volumes/Archive/scans/negatives/scan-0001.tiff",
      ],
    ],
    [
      22_400_000,
      [
        "/Users/you/Archive/photos/scan-0002.tiff",
        "/Volumes/Archive/scans/negatives/scan-0002.tiff",
      ],
    ],
    [
      8_900_000,
      [
        "/Users/you/Pictures/2026/reykjavik-0433.jpg",
        "/Volumes/Archive/media/2026/reykjavik-0433.jpg",
        "/Users/you/Pictures/exports/reykjavik-0433.jpg",
      ],
    ],
    [
      5_100_000,
      [
        "/Users/you/Pictures/wallpapers/ridge.jpg",
        "/Users/you/Downloads/ridge.jpg",
        "/Users/you/Desktop/ridge copy.jpg",
      ],
    ],
    [
      2_240_000,
      [
        "/Users/you/Pictures/exports/sunset-final.jpg",
        "/Users/you/Desktop/sunset-final copy.jpg",
        "/Volumes/Archive/media/2026/sunset-final.jpg",
        "/Users/you/Pictures/2026/backup/sunset-final.jpg",
        "/Volumes/Archive/scans/negatives/sunset-final.jpg",
      ],
    ],
    [
      214_000,
      [
        "/Users/you/Downloads/invoice-2214.pdf",
        "/Users/you/Documents/Invoices/invoice-2214.pdf",
        "/Users/you/Archive/2019/old-invoice-2214.pdf",
      ],
    ],
    [
      1_240_000_000,
      [
        "/Users/you/Desktop/meeting recording.mov",
        "/Volumes/Archive/media/renders/meeting recording.mov",
      ],
    ],
    [
      3_400_000,
      [
        "/Users/you/Pictures/headshot.png",
        "/Users/you/Downloads/headshot.png",
        "/Users/you/Documents/press/headshot.png",
      ],
    ],
    [
      41_300_000,
      [
        "/Users/you/Music/demos/first-take.wav",
        "/Users/you/Music/demos/backup/first-take.wav",
      ],
    ],
    [
      48_200_000,
      [
        "/Users/you/Documents/Q3 board deck.key",
        "/Users/you/Desktop/Q3 board deck.key",
      ],
    ],
    [
      88_500_000,
      [
        "/Users/you/Downloads/dataset-v3.csv",
        "/Volumes/Archive/media/dataset-v3.csv",
      ],
    ],
    [
      920_000,
      [
        "/Users/you/Documents/apartment lease signed.pdf",
        "/Users/you/Downloads/apartment lease signed.pdf",
        "/Users/you/Archive/2019/apartment lease signed.pdf",
      ],
    ],
    [
      61_800_000,
      [
        "/Users/you/Pictures/2026/reykjavik-0431.jpg",
        "/Volumes/Archive/media/2026/reykjavik-0431.jpg",
      ],
    ],
    [
      12_900_000,
      [
        "/Users/you/Downloads/font-plex.zip",
        "/Users/you/Desktop/font-plex.zip",
      ],
    ],
    [
      18_400,
      [
        "/Users/you/Projects/atlas/assets/logo-mark.svg",
        "/Users/you/Desktop/logo-mark.svg",
        "/Users/you/Downloads/logo-mark.svg",
      ],
    ],
  ];
  return raw.map(([size, paths], i) => ({
    hash: `5${i.toString(16).padStart(2, "0")}c41ab97e0d2f`,
    size,
    paths,
  }));
}

// Name matching returns leads, not proof, so the mock has to carry the two
// shapes the reader judges: copies that usually weigh the same, and one title
// held at qualities that weigh wildly different amounts.
function makeCopyGroups(): NameGroup[] {
  const stems: [string, string, number][] = [
    ["invoice", "pdf", 214_000],
    ["board deck", "key", 48_200_000],
    ["lease", "pdf", 920_000],
    ["headshot", "png", 3_400_000],
    ["dataset", "csv", 88_500_000],
    ["schema", "sql", 24_500],
    ["reykjavik-0431", "jpg", 8_900_000],
    ["first-take", "wav", 41_300_000],
    ["standup notes", "txt", 4_200],
    ["logo-mark", "svg", 18_400],
    ["site-backup", "zip", 642_000_000],
    ["podcast-ep12", "mp3", 52_400_000],
  ];
  const folders = [
    "/Users/you/Downloads",
    "/Users/you/Desktop",
    "/Users/you/Documents/Scans",
    "/Users/you/Pictures/2026",
    "/Users/you/Archive/2019",
    "/Volumes/Archive/scans",
  ];
  const markers = ["(1)", "copy", "2", "copy 2", "(3)"];
  const groups: NameGroup[] = [
    {
      strategy: "copies",
      stem: "invoice",
      ext: "pdf",
      year: null,
      all_same_size: true,
      files: [
        {
          path: "/Users/you/Documents/Invoices/invoice.pdf",
          size: 214_000,
          modified_ns: daysAgoNs(240),
          marker: null,
          stripped: [],
        },
        {
          path: "/Users/you/Downloads/invoice (1).pdf",
          size: 214_000,
          modified_ns: daysAgoNs(238),
          marker: "(1)",
          stripped: [],
        },
        {
          path: "/Users/you/Desktop/invoice copy.pdf",
          size: 214_000,
          modified_ns: daysAgoNs(96),
          marker: "copy",
          stripped: [],
        },
      ],
    },
  ];
  for (let i = 0; i < 41; i++) {
    const [stem, ext, size] = stems[i % stems.length];
    const name = `${stem}-${1000 + i}`;
    const copies = 2 + (i % 2);
    // Every third set holds a copy that grew or shrank, which is exactly the
    // case where a name match is not a content match.
    const drift = i % 3 === 0;
    const files = Array.from({ length: copies }, (_, c) => ({
      path: `${folders[(i + c * 2) % folders.length]}/${name}${c === 0 ? "" : ` ${markers[(i + c) % markers.length]}`}.${ext}`,
      size:
        c === 0 || !drift ? size : Math.round(size * (c === 1 ? 0.62 : 1.4)),
      modified_ns: daysAgoNs(12 + i * 3 + c * 9),
      marker: c === 0 ? null : markers[(i + c) % markers.length],
      stripped: [],
    }));
    groups.push({
      strategy: "copies",
      stem: name,
      ext,
      year: null,
      all_same_size: files.every((f) => f.size === files[0].size),
      files,
    });
  }
  // Three sets that exist only so the exact check's awkward answers can be
  // driven in the browser: the verify_exact_match mock reads "stop-here" as a
  // cancelled run and "split-me" as a set that breaks into several identical
  // groups, and a set living entirely on an absent drive comes back having
  // compared nothing. Every one of these renders a non-verdict, which is the
  // half of that feature nothing else in these fixtures reaches.
  for (const [stem, folder] of [
    ["stop-here-render", "/Users/you/Documents/Scans"],
    ["split-me-render", "/Users/you/Downloads"],
    ["offline-render", "/Volumes/Archive/scans"],
  ]) {
    const files = Array.from({ length: 4 }, (_, c) => ({
      path: `${folder}/${stem}${c === 0 ? "" : ` (${c})`}.pdf`,
      size: 512_000,
      modified_ns: daysAgoNs(30 + c * 4),
      marker: c === 0 ? null : `(${c})`,
      stripped: [],
    }));
    groups.push({
      strategy: "copies",
      stem,
      ext: "pdf",
      year: null,
      all_same_size: true,
      files,
    });
  }
  return groups;
}

function makeMediaGroups(): NameGroup[] {
  const films: [string, number, number][] = [
    ["Inception", 2010, 1_040_000_000],
    ["Arrival", 2016, 980_000_000],
    ["Dune", 2021, 1_320_000_000],
    ["Whiplash", 2014, 870_000_000],
    ["Parasite", 2019, 1_180_000_000],
    ["Heat", 1995, 1_460_000_000],
    ["The Thing", 1982, 790_000_000],
    ["Mad Max Fury Road", 2015, 1_290_000_000],
    ["Interstellar", 2014, 1_510_000_000],
    ["Ex Machina", 2014, 840_000_000],
    ["Sicario", 2015, 910_000_000],
    ["Drive", 2011, 760_000_000],
    ["Prisoners", 2013, 1_120_000_000],
    ["Her", 2013, 880_000_000],
    ["Moon", 2009, 720_000_000],
    ["Annihilation", 2018, 1_060_000_000],
    ["Gravity", 2013, 830_000_000],
    ["Spider-Man Into the Spider-Verse", 2018, 1_240_000_000],
    ["No Country for Old Men", 2007, 1_010_000_000],
    ["The Social Network", 2010, 940_000_000],
    ["Children of Men", 2006, 890_000_000],
    ["Under the Skin", 2013, 700_000_000],
    ["The Master", 2012, 1_150_000_000],
    ["Nightcrawler", 2014, 860_000_000],
    ["Hell or High Water", 2016, 780_000_000],
    ["Wind River", 2017, 810_000_000],
    ["Enemy", 2013, 690_000_000],
    ["Coherence", 2013, 640_000_000],
    ["Primer", 2004, 520_000_000],
    ["The Lighthouse", 2019, 950_000_000],
    ["First Reformed", 2017, 830_000_000],
    ["Burning", 2018, 1_090_000_000],
    ["Roma", 2018, 1_270_000_000],
    ["Mandy", 2018, 970_000_000],
    ["Uncut Gems", 2019, 1_140_000_000],
    ["Good Time", 2017, 800_000_000],
  ];
  const albums: [string, number][] = [
    ["Kind of Blue", 46_800_000],
    ["Blue Train", 51_200_000],
    ["Selected Ambient Works", 68_400_000],
    ["Music Has the Right to Children", 74_100_000],
  ];
  const groups: NameGroup[] = [];
  films.forEach(([title, year, base], i) => {
    const dot = title.replace(/[\s]/g, ".");
    const dash = title.toLowerCase().replace(/\s/g, "-");
    const files: NameGroup["files"] = [
      {
        path: `/Volumes/Archive/Movies/${dot}.${year}.720p.BluRay.x264-GRP.mp4`,
        size: base,
        modified_ns: daysAgoNs(300 + i * 11),
        marker: "720p",
        stripped: ["720p", "bluray", "x264", "grp", String(year)],
      },
      {
        path: `/Users/you/Movies/${dash}-${year}-1080p-web-dl.mkv`,
        size: Math.round(base * 6.4),
        modified_ns: daysAgoNs(40 + i * 5),
        marker: "1080p",
        stripped: ["1080p", "web-dl", String(year)],
      },
    ];
    if (i % 3 === 0)
      files.push({
        path: `/Volumes/Archive/Movies/remux/${dot}.${year}.2160p.UHD.REMUX.HDR.mkv`,
        size: Math.round(base * 34),
        modified_ns: daysAgoNs(18 + i * 4),
        marker: "2160p",
        stripped: ["2160p", "uhd", "remux", "hdr", String(year)],
      });
    groups.push({
      strategy: "media",
      stem: title.toLowerCase().replace(/-/g, " "),
      ext: "",
      year,
      all_same_size: false,
      files,
    });
  });
  albums.forEach(([title, base], i) => {
    const dash = title.toLowerCase().replace(/\s/g, "-");
    groups.push({
      strategy: "media",
      stem: title.toLowerCase(),
      ext: "",
      year: null,
      all_same_size: false,
      files: [
        {
          path: `/Users/you/Music/lossless/${dash}.flac`,
          size: Math.round(base * 6.1),
          modified_ns: daysAgoNs(120 + i * 8),
          marker: null,
          stripped: ["flac"],
        },
        {
          path: `/Users/you/Music/phone/${dash}-320.mp3`,
          size: base,
          modified_ns: daysAgoNs(60 + i * 8),
          marker: null,
          stripped: ["mp3"],
        },
      ],
    });
  });
  return groups;
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
  const appDataDir =
    "/Users/you/Library/Application Support/com.parham.fileorganizer";
  let appDataBytes = 50_412_000;
  const thumbsDir = "/Users/you/Library/Caches/com.parham.fileorganizer/thumbs";
  let thumbsBytes = 18_940_000;
  // The last results written to a file in this session, so opening a saved file
  // gives back what was actually saved.
  let lastExport: ResultSnapshot | null = null;
  let cancelRamp: (() => void) | null = null;
  const roots = [
    "/Users/you/Documents",
    "/Users/you/Pictures",
    "/Volumes/Archive/scans",
  ];
  const rootRows: Record<string, number> = {
    "/Users/you/Documents": 9_212,
    "/Users/you/Pictures": 11_340,
    "/Volumes/Archive/scans": 4_265,
  };
  // The external drive in this mock is unplugged: its rows stay searchable, but
  // nothing under it can be opened or hashed.
  const reachable = (path: string) => !path.startsWith("/Volumes/");
  // Mirrors VERIFY_CAP in src-tauri/src/lib.rs.
  const VERIFY_CAP = 512;
  const trash: TrashItem[] = makeTrash();
  const opOrder: string[] = [...new Set(trash.map((t) => t.op_id))];
  const rules: Rule[] = makeRules();
  const chats: Chat[] = makeChats();
  // What each rule run took out of the mock index, so undo can put it back.
  const undoable = new Map<string, { file: SearchHit; from: string }[]>();

  // Resolves true when the run was stopped part way through. Only one long
  // operation runs at a time, same as the desktop app.
  function ramp(evt: string, total: number, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const steps = 40;
      let i = 0;
      let stopped = false;
      cancelRamp = () => {
        stopped = true;
      };
      const tick = () => {
        if (stopped) {
          cancelRamp = null;
          resolve(true);
          return;
        }
        i++;
        const done = Math.round((i / steps) * total);
        emit(evt, { done, total } as Progress);
        if (i >= steps) {
          cancelRamp = null;
          resolve(false);
        } else setTimeout(tick, ms / steps);
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
    // Every model step reports its own meter. Later steps resend the same
    // prompt prefix, so the cached share climbs as the turn goes on.
    const meter = (
      prompt: number,
      completion: number,
      cached: number,
      cost: number,
    ) =>
      emit("ai:usage", {
        prompt_tokens: prompt,
        completion_tokens: completion,
        cached_tokens: cached,
        cost,
      });
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
    meter(1_812, Math.round((lead.length + think.length) / 4) + 12, 0, 0.0024);
    for (const name of tools) {
      emit("ai:step", { kind: "tool", name });
      await wait(320);
      emit("ai:step", { kind: "tool_done", name });
      await wait(110);
    }
    if (tools.length > 0) meter(2_346, 61, 1_536, 0.0016);
    emit("ai:step", { kind: "thinking" });
    await wait(150);
    for (const frag of text.split(/(?<=\s)/)) {
      emit("ai:delta", frag);
      await wait(14);
    }
    meter(2_904, Math.round(text.length / 4) + 8, 2_304, 0.0041);
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
        const cancelled = await ramp("index:progress", 8_421, 2600);
        indexed += cancelled ? 2_640 : 8_421;
        const path = String(args.path ?? "/Users/you/Downloads");
        if (!cancelled && !roots.includes(path)) {
          roots.push(path);
          rootRows[path] = 8_421;
        }
        return { count: indexed, cancelled } as IndexResult as T;
      }
      case "cancel_scan": {
        if (!cancelRamp) return false as T;
        cancelRamp();
        return true as T;
      }
      case "list_indexed_roots":
        return [...roots] as T;
      case "indexed_roots_status":
        return roots.map((path) => ({
          path,
          available: reachable(path),
          file_count: rootRows[path] ?? 0,
        })) as RootStatus[] as T;
      case "remove_indexed_root": {
        const path = String(args.path ?? "");
        const at = roots.indexOf(path);
        if (at < 0) return 0 as T;
        roots.splice(at, 1);
        const rows = rootRows[path] ?? 0;
        delete rootRows[path];
        indexed = Math.max(0, indexed - rows);
        return rows as T;
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
        // Sequential reads one file at a time, so the mock run takes longer.
        const slow = args.mode === "sequential";
        const cancelled = await ramp(
          "dedup:progress",
          1_204,
          slow ? 3400 : 2600,
        );
        const all = makeDupGroups();
        const groups = cancelled ? all.slice(0, 41) : all;
        return {
          group_count: groups.length,
          groups,
          cancelled,
          unavailable_roots: [],
          unreadable_files: 12,
        } as DupScanResult as T;
      }
      case "scan_duplicates_indexed": {
        // No walk here: it reads the index, so the total is every indexed row.
        const slow = args.mode === "sequential";
        const cancelled = await ramp(
          "dedup:progress",
          indexed,
          slow ? 3400 : 2600,
        );
        const floor = Number(args.minSize ?? 1);
        const all = makeIndexedDupGroups().filter((g) => g.size >= floor);
        const groups = cancelled
          ? all.slice(0, Math.ceil(all.length / 3))
          : all;
        return {
          group_count: groups.length,
          groups,
          cancelled,
          unavailable_roots: roots.filter((r) => !reachable(r)),
          unreadable_files: 37,
        } as DupScanResult as T;
      }
      case "scan_similar_images": {
        const slow = args.mode === "sequential";
        const cancelled = await ramp(
          "similar:progress",
          3_190,
          slow ? 3400 : 2600,
        );
        const all = makeSimilarGroups();
        return {
          groups: cancelled ? all.slice(0, 1) : all,
          cancelled,
          unavailable_roots: [],
          unreadable_files: 6,
        } as SimilarScanResult as T;
      }
      case "scan_similar_names": {
        // Names come from the index, so the total is rows read, not bytes.
        const slow = args.mode === "sequential";
        const strategy = (args.strategy ?? "copies") as NameStrategy;
        const cancelled = await ramp(
          "names:progress",
          args.root ? 6_400 : indexed,
          slow ? 3200 : 2400,
        );
        const all = strategy === "media" ? makeMediaGroups() : makeCopyGroups();
        const groups = cancelled
          ? all.slice(0, Math.ceil(all.length / 3))
          : all;
        return {
          group_count: groups.length,
          groups,
          cancelled,
          unavailable_roots: args.root
            ? []
            : roots.filter((r) => !reachable(r)),
        } as NameScanResult as T;
      }
      case "verify_exact_match": {
        // Every branch the UI has to render, drivable on purpose. Triggers, in
        // the order they are checked:
        //   no paths                      -> the empty-set error
        //   more than 512 paths           -> the cap error
        //   a path containing "stop-here" -> the cancelled shape, no verdict
        //   every path under /Volumes     -> compared 0, all unreadable
        //   a path containing "split-me"  -> more than one group
        //   anything else                 -> a pair, a loner, and an unreachable
        const asked = ((args.paths as string[]) ?? []).slice().sort();
        if (asked.length === 0)
          throw new Error("Nothing to verify: no files were passed.");
        if (asked.length > VERIFY_CAP)
          throw new Error(
            `Too many files to verify at once: ${asked.length} paths, the limit is ${VERIFY_CAP}. Verify one group at a time.`,
          );
        await new Promise((r) => setTimeout(r, 700));
        const sizeOf = (p: string) =>
          files.find((f) => f.path === p)?.size ?? 4_812_907;
        const unreadable = asked.filter((p) => !reachable(p));
        const rest = asked.filter((p) => reachable(p));
        if (asked.some((p) => p.includes("stop-here")))
          return {
            groups: [],
            unique: [],
            unreadable,
            compared: 0,
            bytes_hashed: 0,
            cancelled: true,
          } as ExactCheck as T;
        const groups: ExactGroup[] = [];
        let unique: string[] = [];
        if (asked.some((p) => p.includes("split-me"))) {
          // every reachable pair is its own group, an odd one out stays unique
          for (let i = 0; i + 1 < rest.length; i += 2)
            groups.push({
              hash: "b3:" + rid() + rid(),
              size: sizeOf(rest[i]),
              paths: rest.slice(i, i + 2),
            });
          if (rest.length % 2 === 1) unique = [rest[rest.length - 1]];
        } else {
          const matched = rest.slice(0, 2);
          unique = rest.slice(2);
          if (matched.length > 1)
            groups.push({
              hash: "b3:" + rid() + rid(),
              size: sizeOf(matched[0]),
              paths: matched,
            });
          else if (matched.length === 1) unique.unshift(matched[0]);
        }
        return {
          groups,
          unique,
          unreadable,
          compared: rest.length,
          // what a real run reads off the disk: the first and last 8 KiB of
          // everything compared, plus the whole file for anything that made it
          // to the full hash
          bytes_hashed:
            rest.reduce((n, p) => n + Math.min(sizeOf(p), 16_384), 0) +
            groups.reduce(
              (n, g) => n + g.paths.reduce((m, p) => m + sizeOf(p), 0),
              0,
            ),
          cancelled: false,
        } as ExactCheck as T;
      }
      case "index_content": {
        const cancelled = await ramp("content:progress", 612, 2600);
        contentIndexed = cancelled ? 214 : 612;
        return { count: contentIndexed, cancelled } as IndexResult as T;
      }
      case "search_content": {
        const q = String(args.query ?? "").trim();
        if (!q) return [] as ContentHit[] as T;
        const limit = (args.limit as number) ?? 20;
        return makeContentHits(q).slice(0, limit) as T;
      }
      case "trash_files": {
        // Partial failure is drivable on purpose. A path under /Volumes that is
        // not reachable comes back as a disconnected drive, and any path whose
        // name contains "locked" comes back as a permission wall. Everything
        // else moves, and only what moved leaves the index.
        const paths = (args.paths as string[]) ?? [];
        const reason = String(args.reason ?? "manual");
        const op = "op_" + rid();
        const moved: string[] = [];
        const skipped: SkippedItem[] = [];
        for (const p of paths) {
          if (!reachable(p)) {
            skipped.push({
              path: p,
              reason: `${p.split("/").slice(0, 3).join("/")} is not reachable, the drive holding it may not be connected`,
            });
            continue;
          }
          if (p.toLowerCase().includes("locked")) {
            skipped.push({
              path: p,
              reason: "could not be moved: Permission denied (os error 13)",
            });
            continue;
          }
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
          moved.push(p);
        }
        if (moved.length > 0) opOrder.unshift(op);
        largest = largest.filter((f) => !moved.includes(f.path));
        emit("index:changed", undefined);
        return { op_id: op, moved, skipped } as TrashOutcome as T;
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
          skipped: [],
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
      case "app_data_summary":
        return {
          dir: appDataDir,
          bytes: appDataBytes,
          trashed_files: trash.filter((t) => !t.restored).length,
          thumbs_dir: thumbsDir,
          thumbs_bytes: thumbsBytes,
        } as AppDataSummary as T;
      case "get_thumbnails": {
        const paths = ((args.paths as string[]) ?? []).slice(0, 200);
        const px = Math.min(512, Math.max(16, Number(args.maxPx ?? 96)));
        // A real drive answers over milliseconds, not instantly. The delay is
        // what makes the placeholder and the fade-in visible in the preview.
        await new Promise((r) => setTimeout(r, 220));
        return paths.map((path) => {
          if (!looksLikeImage(path))
            return { path, data_uri: null, error: null };
          if (path.startsWith(SNAPSHOT_GONE))
            return { path, data_uri: null, error: "not available" };
          return { path, data_uri: mockThumb(path, px), error: null };
        }) as Thumb[] as T;
      }
      case "clear_thumbnail_cache": {
        const freed = thumbsBytes;
        thumbsBytes = 0;
        drawn.clear();
        return freed as T;
      }
      case "export_results": {
        await new Promise((r) => setTimeout(r, 260));
        // Reading back what was just written is the whole point of the pair, so
        // the preview remembers it and hands it to the next import.
        lastExport = {
          format: "fileorganizer.results",
          version: 1,
          kind: String(args.kind),
          created_ns: Date.now() * 1e6,
          app_version: "0.10.3",
          scope: (args.scope as string | null) ?? null,
          note: (args.note as string | null) ?? null,
          payload: args.payload,
        };
        return undefined as T;
      }
      case "import_results": {
        await new Promise((r) => setTimeout(r, 320));
        if (lastExport) return lastExport as T;
        const groups = makeSnapshotGroups();
        return {
          format: "fileorganizer.results",
          version: 1,
          kind: "duplicates",
          created_ns: daysAgoNs(7),
          app_version: "0.10.3",
          scope: null,
          note: "BLAKE3",
          payload: {
            group_count: groups.length,
            groups,
            cancelled: false,
            unavailable_roots: [],
            unreadable_files: 0,
          },
        } as ResultSnapshot as T;
      }
      case "verify_snapshot_paths": {
        const checks =
          (args.paths as { path: string; expected_size?: number }[]) ?? [];
        await new Promise((r) => setTimeout(r, 180));
        return checks.map(({ path, expected_size }) => {
          if (path.startsWith(SNAPSHOT_GONE))
            return { path, exists: false, size: null, size_changed: null };
          const size = SNAPSHOT_RESIZED.has(path)
            ? Math.round((expected_size ?? 0) * 1.4) + 4096
            : (expected_size ?? 0);
          return {
            path,
            exists: true,
            size,
            size_changed: expected_size != null && size !== expected_size,
          };
        }) as PathStatus[] as T;
      }
      case "reset_app_data": {
        const pending = trash.filter((t) => !t.restored).length;
        if (pending > 0)
          throw new Error(
            `${pending} file(s) are still in the app's Trash. Restore them or empty the Trash first, so this cannot delete them by accident.`,
          );
        chats.length = 0;
        rules.length = 0;
        trash.length = 0;
        opOrder.length = 0;
        undoable.clear();
        hasKey = false;
        effort = "medium";
        keyStorage = "keychain";
        appDataBytes = 12_288;
        emit("index:changed", undefined);
        return undefined as T;
      }
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
        // Same skip triggers as trash_files, so an applied plan that half
        // succeeded is drivable here too: an unreachable /Volumes source, or a
        // name containing "locked".
        const moves = (args.moves as Move[]) ?? [];
        const op = "op_" + rid();
        const skipped: SkippedItem[] = [];
        let moved = 0;
        for (const m of moves) {
          if (!reachable(m.from)) {
            skipped.push({
              path: m.from,
              reason: `${m.from.split("/").slice(0, 3).join("/")} is not reachable, the drive holding it may not be connected`,
            });
          } else if (m.from.toLowerCase().includes("locked")) {
            skipped.push({
              path: m.from,
              reason: "could not be moved: Permission denied (os error 13)",
            });
          } else moved += 1;
        }
        if (moved > 0) opOrder.unshift(op);
        emit("index:changed", undefined);
        return { op_id: op, moved, skipped } as ApplyOrganization as T;
      }
      case "ai_agent": {
        if (!hasKey) throw new Error("No API key set");
        const incoming = (args.messages as ChatMessage[]) ?? [];
        const last =
          [...incoming].reverse().find((m) => m.role === "user")?.content ?? "";
        const text = String(last).toLowerCase();
        // One thing the model cannot guess: where the user wants files to land.
        // It stops and asks instead of picking a folder on their behalf.
        if (/sort|file away|archive|which folder|where should/.test(text)) {
          const said =
            "I found **12 receipts** scattered across `~/Downloads` and the Desktop, all from this year. Before I move anything, I need to know where they belong.";
          const lead = "Reading what is actually in Downloads first.";
          await streamTurn(
            lead,
            ["list_folder"],
            said,
            "There are three plausible destinations and picking wrong means the user hunts for these files later. Documents/Invoices/2026 already holds this year's invoices, so it is the tidiest, but a separate Receipts folder is defensible if they file receipts apart from invoices. That is a preference, not something I can read off the disk, so I should ask rather than guess.",
          );
          emit("ai:step", { kind: "question" });
          emit("ai:done", undefined);
          const messages: ChatMessage[] = [
            ...incoming,
            ...toolTurn(
              "list_folder",
              { path: "/Users/you/Downloads" },
              "34 files, 12 of them receipt PDFs.",
              lead,
            ),
            { role: "assistant", content: said },
          ];
          return {
            messages,
            pending: [],
            question: {
              id: "q_" + rid(),
              question: "Where should the receipts go?",
              options: [
                {
                  label: "Documents/Invoices/2026",
                  description: "Where this year's invoices already live",
                },
                {
                  label: "Documents/Receipts",
                  description: "A new folder, kept apart from invoices",
                },
                {
                  label: "Leave them in Downloads",
                  description: "Rename them in place instead of moving them",
                },
              ],
              multi_select: false,
              allow_text: true,
            },
            final_text: said,
            done: false,
          } as AgentResult as T;
        }
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
            question: null,
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
          question: null,
          final_text: reply,
          done: true,
        } as AgentResult as T;
      }
      case "ai_agent_continue": {
        const incoming = (args.messages as ChatMessage[]) ?? [];
        const answers = (args.answers as QuestionAnswer[]) ?? [];
        if (answers.length > 0) {
          const value = answers[0].value.trim();
          const reply = value
            ? `Filing them under \`${value}\`. I will keep the original names so the dates stay searchable, and I will show you every move before it runs.`
            : "Left the receipts where they are. Nothing moved, and you can ask again whenever you want them filed.";
          await streamTurn(
            "",
            [],
            reply,
            value
              ? "They picked a destination, so the guesswork is gone. Restate it once so they can catch a misread, then stop short of moving anything until the moves are approved."
              : "They passed on the question. That is an answer too, so I should not re-ask or nudge, just say plainly that nothing changed.",
          );
          emit("ai:done", undefined);
          return {
            messages: [...incoming, { role: "assistant", content: reply }],
            pending: [],
            question: null,
            final_text: reply,
            done: true,
          } as AgentResult as T;
        }
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
          question: null,
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
    pickSaveFile: async (defaultPath) => `/Users/you/Desktop/${defaultPath}`,
    pickOpenFile: async () =>
      "/Users/you/Desktop/fileorganizer-duplicates-2026-08-24.json",
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

export async function pickSaveFile(
  defaultPath: string,
): Promise<string | null> {
  return (await get()).pickSaveFile(defaultPath);
}

export async function pickOpenFile(): Promise<string | null> {
  return (await get()).pickOpenFile();
}

export const isDesktop = IN_TAURI;
