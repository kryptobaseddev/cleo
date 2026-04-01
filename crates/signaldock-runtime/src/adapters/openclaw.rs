//! OpenClaw adapter — delivers messages via /hooks/agent endpoint.
//!
//! Auto-detects OpenClaw config from ~/.openclaw/openclaw.json.
//! Reads gateway port and hooks token automatically.

use anyhow::{Context, Result};
use super::base::{PlatformAdapter, Message, DeliveryResult};

pub struct OpenClawAdapter {
    hooks_url: String,
    hooks_token: String,
}

impl OpenClawAdapter {
    /// Create adapter by auto-detecting OpenClaw config.
    pub fn from_auto_detect() -> Result<Self> {
        let home = dirs::home_dir().context("No HOME directory")?;
        let config_path = home.join(".openclaw/openclaw.json");
        let content = std::fs::read_to_string(&config_path)
            .context("Cannot read ~/.openclaw/openclaw.json")?;
        let json: serde_json::Value = serde_json::from_str(&content)?;

        let port = json.get("gateway")
            .and_then(|g| g.get("port"))
            .and_then(|p| p.as_u64())
            .unwrap_or(18789);

        let token = json.get("hooks")
            .and_then(|h| h.get("token"))
            .and_then(|t| t.as_str())
            .context("hooks.token not found in openclaw.json — enable hooks first")?
            .to_string();

        Ok(Self {
            hooks_url: format!("http://127.0.0.1:{}/hooks/agent", port),
            hooks_token: token,
        })
    }

    /// Create adapter with explicit config.
    pub fn new(hooks_url: String, hooks_token: String) -> Self {
        Self { hooks_url, hooks_token }
    }
}

impl PlatformAdapter for OpenClawAdapter {
    fn name(&self) -> &str { "openclaw" }

    fn deliver(&self, msg: &Message) -> Result<DeliveryResult> {
        let payload = serde_json::json!({
            "message": format!("SignalDock message from @{}:\n\n{}", msg.from, msg.content),
            "name": "SignalDock",
            "deliver": true,
            "channel": "telegram",
            "wakeMode": "now"
        });

        let client = reqwest::blocking::Client::new();
        let resp = client.post(&self.hooks_url)
            .header("Authorization", format!("Bearer {}", self.hooks_token))
            .json(&payload)
            .timeout(std::time::Duration::from_secs(10))
            .send();

        match resp {
            Ok(r) if r.status().is_success() => {
                eprintln!("[signaldock] Delivered to OpenClaw (hooks/agent)");
                Ok(DeliveryResult::Delivered)
            }
            Ok(r) if r.status().is_server_error() => {
                Ok(DeliveryResult::Retry(format!("OpenClaw returned {}", r.status())))
            }
            Ok(r) => {
                Ok(DeliveryResult::Failed(format!("OpenClaw returned {}", r.status())))
            }
            Err(e) if e.is_timeout() || e.is_connect() => {
                Ok(DeliveryResult::Retry(format!("Connection error: {}", e)))
            }
            Err(e) => {
                Ok(DeliveryResult::Failed(format!("Request error: {}", e)))
            }
        }
    }

    fn is_healthy(&self) -> bool {
        reqwest::blocking::Client::new()
            .get(self.hooks_url.replace("/hooks/agent", "/health"))
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }
}
