use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub mod organize;

const CHAT_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
const MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
const DEFAULT_MODEL: &str = "anthropic/claude-sonnet-5";
const REFERER: &str = "https://github.com/Parham125/FileOrganizer";
const TITLE: &str = "FileOrganizer";

/// One entry from the OpenRouter model catalog.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
}

/// How much the model should reason before answering. `Off` sends no `reasoning`
/// key at all, leaving the provider default alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Off,
    Low,
    #[default]
    Medium,
    High,
}

impl ReasoningEffort {
    /// The `effort` string OpenRouter expects, or `None` when reasoning is off.
    pub fn as_effort(self) -> Option<&'static str> {
        match self {
            ReasoningEffort::Off => None,
            ReasoningEffort::Low => Some("low"),
            ReasoningEffort::Medium => Some("medium"),
            ReasoningEffort::High => Some("high"),
        }
    }
}

impl std::str::FromStr for ReasoningEffort {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "off" => Ok(ReasoningEffort::Off),
            "low" => Ok(ReasoningEffort::Low),
            "medium" => Ok(ReasoningEffort::Medium),
            "high" => Ok(ReasoningEffort::High),
            other => Err(anyhow!(
                "invalid reasoning effort \"{}\" (expected off, low, medium or high)",
                other
            )),
        }
    }
}

/// One tool call being rebuilt from streamed fragments. `name` and `arguments`
/// arrive split across any number of chunks and are concatenated in order.
#[derive(Debug, Default)]
struct ToolCallAccum {
    id: String,
    name: String,
    arguments: String,
}

/// Accumulates an OpenAI-style SSE stream into a single assistant message.
/// `feed` buffers bytes so a line split across chunks is still applied once,
/// and `finish` rebuilds the exact shape `chat_raw` returns.
#[derive(Debug, Default)]
pub struct StreamAccum {
    buf: Vec<u8>,
    content: String,
    reasoning: String,
    tool_calls: BTreeMap<u64, ToolCallAccum>,
}

impl StreamAccum {
    /// Feed one raw body chunk. Complete lines are applied; a trailing partial
    /// line (possibly cutting a multi-byte char) is held for the next chunk.
    pub fn feed(
        &mut self,
        chunk: &[u8],
        on_delta: &mut dyn FnMut(&str),
        on_reasoning: &mut dyn FnMut(&str),
    ) {
        self.buf.extend_from_slice(chunk);
        while let Some(nl) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            if let Ok(s) = std::str::from_utf8(&line) {
                self.apply_line(s, on_delta, on_reasoning);
            }
        }
    }

    /// Apply one complete SSE line. Blank lines, comments and `[DONE]` are ignored.
    pub fn apply_line(
        &mut self,
        line: &str,
        on_delta: &mut dyn FnMut(&str),
        on_reasoning: &mut dyn FnMut(&str),
    ) {
        let Some(data) = line.trim().strip_prefix("data:") else {
            return;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
            return;
        };
        let delta = &v["choices"][0]["delta"];
        if let Some(text) = delta["content"].as_str() {
            if !text.is_empty() {
                self.content.push_str(text);
                on_delta(text);
            }
        }
        if let Some(text) = delta["reasoning"].as_str() {
            if !text.is_empty() {
                self.reasoning.push_str(text);
                on_reasoning(text);
            }
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for tc in calls {
                let slot = self
                    .tool_calls
                    .entry(tc["index"].as_u64().unwrap_or(0))
                    .or_default();
                if let Some(id) = tc["id"].as_str() {
                    if !id.is_empty() {
                        slot.id = id.to_string();
                    }
                }
                if let Some(name) = tc["function"]["name"].as_str() {
                    slot.name.push_str(name);
                }
                if let Some(args) = tc["function"]["arguments"].as_str() {
                    slot.arguments.push_str(args);
                }
            }
        }
    }

    /// Rebuild the assistant message: `content` (null when nothing streamed) plus
    /// `tool_calls` only when the model asked for any.
    pub fn finish(self) -> serde_json::Value {
        let content = if self.content.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::Value::String(self.content)
        };
        let mut msg = serde_json::json!({"role": "assistant", "content": content});
        if !self.reasoning.is_empty() {
            msg["reasoning"] = serde_json::Value::String(self.reasoning);
        }
        if !self.tool_calls.is_empty() {
            msg["tool_calls"] = self
                .tool_calls
                .into_values()
                .map(|tc| {
                    serde_json::json!({
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.name, "arguments": tc.arguments}
                    })
                })
                .collect();
        }
        msg
    }
}

/// OpenRouter chat client for BYO-key usage. The key is never logged.
pub struct OpenRouter {
    api_key: String,
    model: String,
    reasoning: ReasoningEffort,
    client: reqwest::Client,
}

impl OpenRouter {
    pub fn new(api_key: String, model: String) -> Self {
        let model = if model.trim().is_empty() {
            DEFAULT_MODEL.to_string()
        } else {
            model
        };
        OpenRouter {
            api_key,
            model,
            reasoning: ReasoningEffort::default(),
            client: reqwest::Client::new(),
        }
    }

    /// Set how hard the model should think. Applies to every request this client makes.
    pub fn with_reasoning(mut self, effort: ReasoningEffort) -> Self {
        self.reasoning = effort;
        self
    }

    /// Add `reasoning.effort` to a request body, or leave the body untouched when off.
    /// Deliberately never sends `max_tokens`: adaptive-thinking models ignore it.
    fn apply_reasoning(&self, body: &mut serde_json::Value) {
        if let Some(effort) = self.reasoning.as_effort() {
            body["reasoning"] = serde_json::json!({"effort": effort});
        }
    }

    pub async fn chat(&self, system: Option<&str>, user: &str) -> Result<String> {
        let mut messages = Vec::new();
        if let Some(s) = system {
            messages.push(serde_json::json!({"role": "system", "content": s}));
        }
        messages.push(serde_json::json!({"role": "user", "content": user}));
        let mut body = serde_json::json!({"model": self.model, "messages": messages});
        self.apply_reasoning(&mut body);
        let resp = self
            .client
            .post(CHAT_URL)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("HTTP-Referer", REFERER)
            .header("X-Title", TITLE)
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            let msg = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| text.clone());
            return Err(anyhow!("OpenRouter error ({}): {}", status.as_u16(), msg));
        }
        let v: serde_json::Value = serde_json::from_str(&text)?;
        let content = v["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| anyhow!("OpenRouter response had no message content"))?;
        Ok(content.to_string())
    }

    /// Raw tool-calling chat turn. `messages` is the full OpenAI-format array and
    /// `tools` the optional function schema array. Returns `choices[0].message`
    /// verbatim (holds `content` and optionally `tool_calls`).
    pub async fn chat_raw(
        &self,
        messages: serde_json::Value,
        tools: Option<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let mut body = serde_json::json!({"model": self.model, "messages": messages});
        if let Some(t) = tools {
            body["tools"] = t;
            body["tool_choice"] = serde_json::json!("auto");
        }
        self.apply_reasoning(&mut body);
        let resp = self
            .client
            .post(CHAT_URL)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("HTTP-Referer", REFERER)
            .header("X-Title", TITLE)
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            let msg = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| text.clone());
            return Err(anyhow!("OpenRouter error ({}): {}", status.as_u16(), msg));
        }
        let v: serde_json::Value = serde_json::from_str(&text)?;
        let msg = v["choices"][0]["message"].clone();
        if msg.is_null() {
            return Err(anyhow!("OpenRouter response had no message"));
        }
        Ok(msg)
    }

    /// Streaming twin of `chat_raw`. `on_delta` is called with each content token
    /// and `on_reasoning` with each reasoning token as they arrive; the returned
    /// value is the same assistant message shape `chat_raw` produces, plus a
    /// `reasoning` field when the model streamed any.
    pub async fn chat_raw_stream<F, R>(
        &self,
        messages: serde_json::Value,
        tools: Option<serde_json::Value>,
        mut on_delta: F,
        mut on_reasoning: R,
    ) -> Result<serde_json::Value>
    where
        F: FnMut(&str) + Send,
        R: FnMut(&str) + Send,
    {
        let mut body =
            serde_json::json!({"model": self.model, "messages": messages, "stream": true});
        if let Some(t) = tools {
            body["tools"] = t;
            body["tool_choice"] = serde_json::json!("auto");
        }
        self.apply_reasoning(&mut body);
        let resp = self
            .client
            .post(CHAT_URL)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("HTTP-Referer", REFERER)
            .header("X-Title", TITLE)
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await?;
            let msg = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| text.clone());
            return Err(anyhow!("OpenRouter error ({}): {}", status.as_u16(), msg));
        }
        let mut accum = StreamAccum::default();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            accum.feed(&chunk?, &mut on_delta, &mut on_reasoning);
        }
        // Flush a final line that arrived without a trailing newline.
        accum.feed(b"\n", &mut on_delta, &mut on_reasoning);
        Ok(accum.finish())
    }

    pub async fn list_models() -> Result<Vec<ModelInfo>> {
        let resp = reqwest::Client::new().get(MODELS_URL).send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(anyhow!("OpenRouter error ({})", status.as_u16()));
        }
        let v: serde_json::Value = serde_json::from_str(&text)?;
        let mut out = Vec::new();
        if let Some(arr) = v["data"].as_array() {
            for m in arr {
                if let Some(id) = m["id"].as_str() {
                    let name = m["name"].as_str().unwrap_or(id).to_string();
                    out.push(ModelInfo {
                        id: id.to_string(),
                        name,
                    });
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn content_chunk(text: &str) -> String {
        format!(
            "data: {}\n\n",
            serde_json::json!({"choices": [{"delta": {"content": text}}]})
        )
    }

    fn reasoning_chunk(text: &str) -> String {
        format!(
            "data: {}\n\n",
            serde_json::json!({"choices": [{"delta": {"reasoning": text}}]})
        )
    }

    #[test]
    fn content_deltas_concatenate_in_order() {
        let mut accum = StreamAccum::default();
        let mut seen = String::new();
        let mut on_delta = |s: &str| seen.push_str(s);
        let mut on_reasoning = |_: &str| {};
        for part in ["Hello", ", ", "world"] {
            accum.feed(
                content_chunk(part).as_bytes(),
                &mut on_delta,
                &mut on_reasoning,
            );
        }
        drop(on_delta);
        assert_eq!(seen, "Hello, world");
        let msg = accum.finish();
        assert_eq!(msg["role"], "assistant");
        assert_eq!(msg["content"], "Hello, world");
        assert!(msg["tool_calls"].is_null());
        assert!(msg["reasoning"].is_null());
    }

    #[test]
    fn reasoning_deltas_concatenate_in_order() {
        let mut accum = StreamAccum::default();
        let mut seen = String::new();
        let mut on_delta = |_: &str| {};
        let mut on_reasoning = |s: &str| seen.push_str(s);
        // one fragment split across two body chunks mid-line
        let line = reasoning_chunk("Let me check the index");
        let (a, b) = line.split_at(line.len() / 2);
        accum.feed(a.as_bytes(), &mut on_delta, &mut on_reasoning);
        accum.feed(b.as_bytes(), &mut on_delta, &mut on_reasoning);
        accum.feed(
            reasoning_chunk(" first.").as_bytes(),
            &mut on_delta,
            &mut on_reasoning,
        );
        drop(on_reasoning);
        assert_eq!(seen, "Let me check the index first.");
        let msg = accum.finish();
        assert_eq!(msg["reasoning"], "Let me check the index first.");
        assert!(msg["content"].is_null());
    }

    #[test]
    fn interleaved_reasoning_and_content_stay_in_own_buffers() {
        let mut accum = StreamAccum::default();
        let mut content = String::new();
        let mut reasoning = String::new();
        let mut on_delta = |s: &str| content.push_str(s);
        let mut on_reasoning = |s: &str| reasoning.push_str(s);
        for chunk in [
            reasoning_chunk("think "),
            content_chunk("Found "),
            reasoning_chunk("more"),
            content_chunk("3 files."),
        ] {
            accum.feed(chunk.as_bytes(), &mut on_delta, &mut on_reasoning);
        }
        // a single delta carrying both fields lands in both buffers
        let both = serde_json::json!({"choices": [{"delta": {"content": "", "reasoning": "!"}}]});
        accum.feed(
            format!("data: {}\n\n", both).as_bytes(),
            &mut on_delta,
            &mut on_reasoning,
        );
        drop(on_delta);
        drop(on_reasoning);
        assert_eq!(content, "Found 3 files.");
        assert_eq!(reasoning, "think more!");
        let msg = accum.finish();
        assert_eq!(msg["content"], "Found 3 files.");
        assert_eq!(msg["reasoning"], "think more!");
    }

    #[test]
    fn finish_omits_reasoning_when_empty() {
        let mut accum = StreamAccum::default();
        let mut on_delta = |_: &str| {};
        let mut on_reasoning = |_: &str| {};
        accum.feed(
            content_chunk("no thinking here").as_bytes(),
            &mut on_delta,
            &mut on_reasoning,
        );
        // an empty reasoning fragment must not create the field either
        accum.feed(
            reasoning_chunk("").as_bytes(),
            &mut on_delta,
            &mut on_reasoning,
        );
        let msg = accum.finish();
        assert!(msg.get("reasoning").is_none());
    }

    #[test]
    fn reasoning_effort_maps_to_body_or_omits() {
        assert_eq!(ReasoningEffort::default(), ReasoningEffort::Medium);
        assert_eq!(ReasoningEffort::Off.as_effort(), None);
        assert_eq!(ReasoningEffort::Low.as_effort(), Some("low"));
        assert_eq!(ReasoningEffort::High.as_effort(), Some("high"));
        assert_eq!(
            "HIGH".parse::<ReasoningEffort>().unwrap(),
            ReasoningEffort::High
        );
        assert!("turbo".parse::<ReasoningEffort>().is_err());
        // the settings file round trip: serialized lowercase, parsed back by name
        let stored = serde_json::json!({"reasoning_effort": ReasoningEffort::High}).to_string();
        assert_eq!(stored, "{\"reasoning_effort\":\"high\"}");
        let back: serde_json::Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(
            back["reasoning_effort"]
                .as_str()
                .unwrap()
                .parse::<ReasoningEffort>()
                .unwrap(),
            ReasoningEffort::High
        );
        let client = OpenRouter::new("k".into(), "m".into()).with_reasoning(ReasoningEffort::Low);
        let mut body = serde_json::json!({"model": "m"});
        client.apply_reasoning(&mut body);
        assert_eq!(body["reasoning"], serde_json::json!({"effort": "low"}));
        assert!(body.get("max_tokens").is_none());
        let client = client.with_reasoning(ReasoningEffort::Off);
        let mut body = serde_json::json!({"model": "m"});
        client.apply_reasoning(&mut body);
        assert!(body.get("reasoning").is_none());
    }

    #[test]
    fn tool_call_fragments_reassemble() {
        let mut accum = StreamAccum::default();
        let mut on_delta = |_: &str| {};
        let mut on_reasoning = |_: &str| {};
        let frags = [
            serde_json::json!({"index": 0, "id": "call_1", "type": "function", "function": {"arguments": ""}}),
            serde_json::json!({"index": 0, "function": {"name": "search_files"}}),
            serde_json::json!({"index": 0, "function": {"arguments": "{\"que"}}),
            serde_json::json!({"index": 0, "function": {"arguments": "ry\": \"inv"}}),
            serde_json::json!({"index": 0, "function": {"arguments": "oice\"}"}}),
        ];
        for f in frags {
            let line = format!(
                "data: {}\n\n",
                serde_json::json!({"choices": [{"delta": {"tool_calls": [f]}}]})
            );
            accum.feed(line.as_bytes(), &mut on_delta, &mut on_reasoning);
        }
        let msg = accum.finish();
        assert!(msg["content"].is_null());
        let calls = msg["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "call_1");
        assert_eq!(calls[0]["type"], "function");
        assert_eq!(calls[0]["function"]["name"], "search_files");
        let args: serde_json::Value =
            serde_json::from_str(calls[0]["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(args["query"], "invoice");
    }

    #[test]
    fn parallel_tool_calls_stay_separate_per_index() {
        let mut accum = StreamAccum::default();
        let mut on_delta = |_: &str| {};
        let mut on_reasoning = |_: &str| {};
        let body = serde_json::json!({"choices": [{"delta": {"tool_calls": [
            {"index": 1, "id": "b", "function": {"name": "list_folder", "arguments": "{}"}},
            {"index": 0, "id": "a", "function": {"name": "index_stats", "arguments": "{}"}}
        ]}}]});
        accum.feed(
            format!("data: {}\n\n", body).as_bytes(),
            &mut on_delta,
            &mut on_reasoning,
        );
        let msg = accum.finish();
        let calls = msg["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["id"], "a");
        assert_eq!(calls[1]["id"], "b");
    }

    #[test]
    fn done_blank_and_comment_lines_are_ignored() {
        let mut accum = StreamAccum::default();
        let mut seen = String::new();
        let mut on_delta = |s: &str| seen.push_str(s);
        let mut on_reasoning = |_: &str| {};
        accum.feed(
            b": OPENROUTER PROCESSING\n\n",
            &mut on_delta,
            &mut on_reasoning,
        );
        accum.feed(
            content_chunk("hi").as_bytes(),
            &mut on_delta,
            &mut on_reasoning,
        );
        accum.feed(
            b"\n\ndata: [DONE]\n\ndata: \n\n",
            &mut on_delta,
            &mut on_reasoning,
        );
        accum.feed(b"data: not json\n\n", &mut on_delta, &mut on_reasoning);
        drop(on_delta);
        assert_eq!(seen, "hi");
        assert_eq!(accum.finish()["content"], "hi");
    }

    #[test]
    fn line_split_across_chunks_reassembles() {
        let mut accum = StreamAccum::default();
        let mut on_delta = |_: &str| {};
        let mut on_reasoning = |_: &str| {};
        let line = content_chunk("split ok");
        let (a, b) = line.split_at(line.len() / 2);
        accum.feed(a.as_bytes(), &mut on_delta, &mut on_reasoning);
        accum.feed(b.as_bytes(), &mut on_delta, &mut on_reasoning);
        assert_eq!(accum.finish()["content"], "split ok");
    }

    #[test]
    fn trailing_line_without_newline_flushes() {
        let mut accum = StreamAccum::default();
        let mut on_delta = |_: &str| {};
        let mut on_reasoning = |_: &str| {};
        accum.feed(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"tail\"}}]}",
            &mut on_delta,
            &mut on_reasoning,
        );
        accum.feed(b"\n", &mut on_delta, &mut on_reasoning);
        assert_eq!(accum.finish()["content"], "tail");
    }
}
