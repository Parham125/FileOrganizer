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

export type SimilarGroup = {
  paths: string[];
  distance: number;
};

export type ContentHit = {
  path: string;
  snippet: string;
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

export type Progress = { done: number; total: number };

export type ViewId =
  | "search"
  | "duplicates"
  | "organize"
  | "assistant"
  | "trash"
  | "settings";
export type HashAlgo = "blake3" | "sha256";
export type Theme = "light" | "dark" | "system";

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

export type PendingAction = {
  id: string;
  name: string;
  summary: string;
  args: Record<string, unknown>;
};

export type AgentResult = {
  messages: ChatMessage[];
  pending: PendingAction[];
  final_text: string | null;
  done: boolean;
};
