export type Provider = "Anthropic" | "OpenAI" | "Google";

export type ModelOption = {
  id: string;
  label: string;
  provider: Provider;
};

// Exact OpenRouter model IDs (verified against the /models endpoint).
export const MODELS: ModelOption[] = [
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "Anthropic",
  },
  {
    id: "anthropic/claude-opus-5",
    label: "Claude Opus 5",
    provider: "Anthropic",
  },
  {
    id: "anthropic/claude-opus-4.8",
    label: "Claude Opus 4.8",
    provider: "Anthropic",
  },
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "OpenAI" },
  { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "OpenAI" },
  { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "OpenAI" },
  {
    id: "google/gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    provider: "Google",
  },
];
