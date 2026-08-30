use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

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
