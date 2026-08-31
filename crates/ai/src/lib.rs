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
    tool_calls: BTreeMap<u64, ToolCallAccum>,
}

impl StreamAccum {
    /// Feed one raw body chunk. Complete lines are applied; a trailing partial
    /// line (possibly cutting a multi-byte char) is held for the next chunk.
    pub fn feed(&mut self, chunk: &[u8], on_delta: &mut dyn FnMut(&str)) {
        self.buf.extend_from_slice(chunk);
        while let Some(nl) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            if let Ok(s) = std::str::from_utf8(&line) {
                self.apply_line(s, on_delta);
            }
        }
    }

    /// Apply one complete SSE line. Blank lines, comments and `[DONE]` are ignored.
    pub fn apply_line(&mut self, line: &str, on_delta: &mut dyn FnMut(&str)) {
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
            client: reqwest::Client::new(),
        }
    }

    pub async fn chat(&self, system: Option<&str>, user: &str) -> Result<String> {
        let mut messages = Vec::new();
        if let Some(s) = system {
            messages.push(serde_json::json!({"role": "system", "content": s}));
        }
        messages.push(serde_json::json!({"role": "user", "content": user}));
        let body = serde_json::json!({"model": self.model, "messages": messages});
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

    /// Streaming twin of `chat_raw`. `on_delta` is called with each content
    /// token as it arrives; the returned value is the same assistant message
    /// shape `chat_raw` produces, so callers need no other changes.
    pub async fn chat_raw_stream<F>(
        &self,
        messages: serde_json::Value,
        tools: Option<serde_json::Value>,
        mut on_delta: F,
    ) -> Result<serde_json::Value>
    where
        F: FnMut(&str) + Send,
    {
        let mut body =
            serde_json::json!({"model": self.model, "messages": messages, "stream": true});
        if let Some(t) = tools {
            body["tools"] = t;
            body["tool_choice"] = serde_json::json!("auto");
        }
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
            accum.feed(&chunk?, &mut on_delta);
        }
        // Flush a final line that arrived without a trailing newline.
        accum.feed(b"\n", &mut on_delta);
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

    #[test]
    fn content_deltas_concatenate_in_order() {
        let mut accum = StreamAccum::default();
        let mut seen = String::new();
        let mut on_delta = |s: &str| seen.push_str(s);
        for part in ["Hello", ", ", "world"] {
            accum.feed(content_chunk(part).as_bytes(), &mut on_delta);
        }
        drop(on_delta);
        assert_eq!(seen, "Hello, world");
        let msg = accum.finish();
        assert_eq!(msg["role"], "assistant");
        assert_eq!(msg["content"], "Hello, world");
        assert!(msg["tool_calls"].is_null());
    }

    #[test]
    fn tool_call_fragments_reassemble() {
        let mut accum = StreamAccum::default();
        let mut on_delta = |_: &str| {};
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
            accum.feed(line.as_bytes(), &mut on_delta);
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
        let body = serde_json::json!({"choices": [{"delta": {"tool_calls": [
            {"index": 1, "id": "b", "function": {"name": "list_folder", "arguments": "{}"}},
            {"index": 0, "id": "a", "function": {"name": "index_stats", "arguments": "{}"}}
        ]}}]});
        accum.feed(format!("data: {}\n\n", body).as_bytes(), &mut on_delta);
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
        accum.feed(b": OPENROUTER PROCESSING\n\n", &mut on_delta);
        accum.feed(content_chunk("hi").as_bytes(), &mut on_delta);
        accum.feed(b"\n\ndata: [DONE]\n\ndata: \n\n", &mut on_delta);
        accum.feed(b"data: not json\n\n", &mut on_delta);
        drop(on_delta);
        assert_eq!(seen, "hi");
        assert_eq!(accum.finish()["content"], "hi");
    }

    #[test]
    fn line_split_across_chunks_reassembles() {
        let mut accum = StreamAccum::default();
        let mut on_delta = |_: &str| {};
        let line = content_chunk("split ok");
        let (a, b) = line.split_at(line.len() / 2);
        accum.feed(a.as_bytes(), &mut on_delta);
        accum.feed(b.as_bytes(), &mut on_delta);
        assert_eq!(accum.finish()["content"], "split ok");
    }

    #[test]
    fn trailing_line_without_newline_flushes() {
        let mut accum = StreamAccum::default();
        let mut on_delta = |_: &str| {};
        accum.feed(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"tail\"}}]}",
            &mut on_delta,
        );
        accum.feed(b"\n", &mut on_delta);
        assert_eq!(accum.finish()["content"], "tail");
    }
}
