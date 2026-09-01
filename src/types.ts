export type SearchHit = {
  path: string;
  name: string;
  size: number;
  modified_ns: number | null;
};

export type SearchOpts = {
  min_size?: number | null;
  max_size?: number | null;
  ext?: string | null;
  limit?: number | null;
};

export type DupGroup = {
  hash: string;
  size: number;
  paths: string[];
};

export type SimilarFile = {
  path: string;
  size: number;
  modified_ns: number | null;
};

export type SimilarGroup = {
  files: SimilarFile[];
  distance: number;
};

// How two names were judged to belong together. "copies" strips copy markers
// and keeps the extension, "media" strips quality tags and ignores it.
export type NameStrategy = "copies" | "media";

// One file inside a name group. marker is what made it look like a copy, and
// stripped lists the tokens the media strategy removed to reach the title.
export type NameMatch = {
  path: string;
  size: number;
  modified_ns: number | null;
  marker: string | null;
  stripped?: string[];
};

// Files whose names collapse to the same stem. Nothing here was hashed, so a
// group is a lead and not a proof: all_same_size is the only hint that the
// files might really hold the same bytes.
export type NameGroup = {
  strategy: string;
  stem: string;
  ext: string;
  year?: number | null;
  files: NameMatch[];
  all_same_size: boolean;
};

// How aggressively a scan reads the disk. "sequential" reads one file at a
// time, which suits external and spinning drives.
export type ScanMode = "auto" | "sequential";

// Long operations can be stopped mid-run, so every one of them answers with
// whatever it managed to finish plus whether the user stopped it.
// group_count is the true number of sets the scan confirmed, which can exceed
// the groups it hands back when the backend caps the payload.
// unavailable_roots and unreadable_files are the honesty fields. A content scan
// cannot open a file on a drive that is not plugged in, so a short result has to
// say so instead of reading as a complete one.
export type DupScanResult = {
  group_count: number;
  groups: DupGroup[];
  cancelled: boolean;
  unavailable_roots: string[];
  unreadable_files: number;
};
// too_many_images is set only when the folder held more images than the pass
// will compare, in which case nothing was compared: empty groups there mean
// "not looked at", not "nothing alike", and the UI has to say which it is.
export type SimilarScanResult = {
  groups: SimilarGroup[];
  cancelled: boolean;
  unavailable_roots: string[];
  unreadable_files: number;
  too_many_images?: number | null;
};
// Names come from the index and no file is opened, so a disconnected drive is
// still covered here. No unreadable_files for the same reason.
export type NameScanResult = {
  group_count: number;
  groups: NameGroup[];
  cancelled: boolean;
  unavailable_roots: string[];
};
export type ExactGroup = {
  hash: string;
  size: number;
  paths: string[];
};
// The answer to "are these the same file?" for one hand-picked set, from the
// same staging the duplicate scan uses: size, partial hash, full hash.
// Not a boolean, because a set can split: three same-named files where two match
// and one differs come back as one group of 2 plus one entry in unique. Empty
// groups with everything in unique is a real answer, same name and different
// bytes. compared == 0 means nothing was looked at, which is a different thing,
// and unreadable holds the files that could not be opened at all.
// bytes_hashed is bytes actually read off the disk, partial reads included, so
// only the files settled by size alone contribute nothing to it. cancelled is
// true only for a run that stopped before it had an answer; a run that reached
// the end is a verdict even if Stop was pressed a moment later.
export type ExactCheck = {
  groups: ExactGroup[];
  unique: string[];
  unreadable: string[];
  compared: number;
  bytes_hashed: number;
  cancelled: boolean;
};

export type IndexResult = { count: number; cancelled: boolean };

// An indexed folder and whether it can be reached right now. Rows from an
// unplugged drive stay searchable, so available is how the UI says a hit cannot
// be opened and why a content scan came back short.
export type RootStatus = {
  path: string;
  available: boolean;
  file_count: number;
};

export type ContentHit = {
  path: string;
  snippet: string;
};

export type ExtStat = {
  ext: string;
  count: number;
  total_size: number;
};

export type StorageStats = {
  files: number;
  total_size: number;
  largest: SearchHit[];
  by_ext: ExtStat[];
};

// Everything the app keeps on this device. trashed_files counts the files still
// sitting in the app's own Trash, which is what blocks a reset. Thumbnails are
// reported apart because they live in the OS cache folder, outside dir.
export type AppDataSummary = {
  dir: string;
  bytes: number;
  trashed_files: number;
  thumbs_dir: string;
  thumbs_bytes: number;
};

// One preview from get_thumbnails. data_uri is ready to drop into an img src.
// A file that is not a raster image comes back with neither a preview nor an
// error, and the row simply shows nothing.
export type Thumb = {
  path: string;
  data_uri: string | null;
  error: string | null;
};

// A result set parked on a file. payload is opaque here and read per kind, the
// same way the runtime treats it.
export type SnapshotKind =
  "duplicates" | "similar_images" | "similar_names" | "search";

export type ResultSnapshot = {
  format: string;
  version: number;
  kind: string;
  created_ns: number;
  app_version: string;
  scope: string | null;
  note: string | null;
  payload: unknown;
};

// One snapshot path checked against the disk as it is now. size_changed is null
// when the file is gone or the snapshot carried no size to compare against.
export type PathStatus = {
  path: string;
  exists: boolean;
  size: number | null;
  size_changed: boolean | null;
};

export type TrashItem = {
  id: string;
  op_id: string;
  original_path: string;
  size: number;
  deleted_ns: number;
  reason: string | null;
  restored: boolean;
};

// One path an operation deliberately did not touch, with the reason in plain
// words: "source no longer exists", "could not be moved: Permission denied",
// "there is not enough room on the app's disk...". Show it, do not count it.
export type SkippedItem = {
  path: string;
  reason: string;
};

// What trash_files actually did. moved holds the files that reached the
// quarantine, skipped the ones still sitting on disk and why. moved.length is
// the only honest count to report: it is not the number of paths asked for.
export type TrashOutcome = {
  op_id: string;
  moved: string[];
  skipped: SkippedItem[];
};

// What ai_apply_organization actually did. moved is a count here, not a path
// list like TrashOutcome's, because the plan already names every file. A file
// the runtime refused to move is in skipped with the reason, so an applied plan
// that moved nothing cannot read as an applied plan.
export type ApplyOrganization = {
  op_id: string;
  moved: number;
  skipped: SkippedItem[];
};

export type Progress = { done: number; total: number };

// Saved cleanups: a filter over the index plus one action. Both actions route
// through the trash journal, so every run is undoable.
export type RuleAction = { type: "Trash" } | { type: "MoveTo"; folder: string };

export type RuleFilter = {
  name_contains?: string | null;
  ext?: string | null;
  min_size?: number | null;
  max_size?: number | null;
  older_than_days?: number | null;
  in_folder?: string | null;
};

export type Rule = {
  id: string;
  name: string;
  filter: RuleFilter;
  action: RuleAction;
  created_ns: number;
  last_run_ns: number | null;
  last_run_count: number;
};

// count is what the run actually acted on, skipped everything it could not.
export type RuleRun = {
  op_id: string;
  count: number;
  skipped: SkippedItem[];
};

export type ViewId =
  | "search"
  | "duplicates"
  | "insights"
  | "organize"
  | "rules"
  | "assistant"
  | "trash"
  | "settings";
export type HashAlgo = "blake3" | "sha256";
export type Theme = "light" | "dark" | "system";
export type ReasoningEffort = "off" | "low" | "medium" | "high";
// Where the OpenRouter key lives. Switching migrates it, it is never duplicated.
export type KeyStorage = "keychain" | "file";

// AI organizer
export type Move = { from: string; to: string };

// AI assistant (OpenAI-format transcript)
export type ToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "user" | "assistant" | "tool" | "system";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

// Saved conversations. The list view only needs the header fields, so it never
// pulls whole transcripts across the bridge.
export type ChatSummary = {
  id: string;
  title: string;
  created_ns: number;
  updated_ns: number;
  message_count: number;
};

export type Chat = {
  id: string;
  title: string;
  created_ns: number;
  updated_ns: number;
  messages: ChatMessage[];
};

export type PendingAction = {
  id: string;
  name: string;
  summary: string;
  args: Record<string, unknown>;
};

// Something the model wants the user to settle before it goes on. Nothing is
// authorized here, so it is not a PendingAction: the answer is just text going
// back into the transcript.
export type QuestionOption = { label: string; description?: string | null };

export type PendingQuestion = {
  id: string;
  question: string;
  options: QuestionOption[];
  multi_select: boolean;
  allow_text: boolean;
};

export type QuestionAnswer = { id: string; value: string };

// Live turn events: "ai:delta" and "ai:reasoning" each carry a bare text
// fragment, "ai:step" one of these, "ai:usage" the meter below, "ai:done"
// nothing at all.
export type AgentStep = {
  kind: "thinking" | "tool" | "tool_done" | "awaiting_approval" | "question";
  name?: string;
};

// What one model step burned. cost is null when the provider did not price it.
// The view sums these over a turn, which is the only number worth reading.
export type AgentUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cost: number | null;
};

export type AgentResult = {
  messages: ChatMessage[];
  pending: PendingAction[];
  question: PendingQuestion | null;
  final_text: string | null;
  done: boolean;
};
