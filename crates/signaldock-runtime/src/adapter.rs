use anyhow::{Result, Context};
use crate::config::Config;

/// A platform adapter that receives messages and wakes the agent.
pub trait PlatformAdapter: Send + Sync {
    fn name(&self) -> &str;
    fn deliver(&self, from: &str, content: &str, message_id: &str, conversation_id: &str) -> Result<()>;
}

/// Auto-detect which agent platform is running.
pub fn detect_platform() -> String {
    // OpenClaw: check for ~/.openclaw/openclaw.json with hooks enabled
    if let Ok(home) = std::env::var("HOME") {
        let oc_config = std::path::Path::new(&home).join(".openclaw/openclaw.json");
        if oc_config.exists() {
            if let Ok(content) = std::fs::read_to_string(&oc_config) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    if json.get("hooks").and_then(|h| h.get("enabled")).and_then(|e| e.as_bool()) == Some(true) {
                        tracing::info!("Detected OpenClaw with hooks enabled");
                        return "openclaw".to_string();
                    }
                }
            }
            tracing::info!("Detected OpenClaw (hooks not enabled, using stdout)");
        }

        // Claude Code: check for ~/.claude/
        if std::path::Path::new(&home).join(".claude").exists() {
            tracing::info!("Detected Claude Code");
            return "stdout".to_string(); // TODO: claude adapter
        }
    }

    tracing::info!("No platform detected, using stdout");
    "stdout".to_string()
}

/// Create a platform adapter based on config.
pub fn create(config: &Config) -> Result<Box<dyn PlatformAdapter>> {
    match config.platform.as_str() {
        "openclaw" => Ok(Box::new(OpenClawAdapter::new()?)),
        "webhook" => {
            let url = config.webhook_url.as_ref()
                .context("--webhook URL required for webhook platform")?;
            Ok(Box::new(WebhookAdapter::new(url.clone())))
        }
        "stdout" | _ => Ok(Box::new(StdoutAdapter)),
    }
}

// ============================================================
// OpenClaw Adapter — POST to /hooks/agent
// ============================================================

struct OpenClawAdapter {
    hooks_url: String,
    hooks_token: String,
}

impl OpenClawAdapter {
    fn new() -> Result<Self> {
        let home = std::env::var("HOME").context("No HOME")?;
        let config_path = std::path::Path::new(&home).join(".openclaw/openclaw.json");
        let content = std::fs::read_to_string(&config_path)
            .context("Cannot read OpenClaw config")?;
        let json: serde_json::Value = serde_json::from_str(&content)?;

        let port = json.get("gateway").and_then(|g| g.get("port")).and_then(|p| p.as_u64()).unwrap_or(18789);
        let token = json.get("hooks").and_then(|h| h.get("token")).and_then(|t| t.as_str())
            .context("OpenClaw hooks.token not found")?
            .to_string();

        Ok(Self {
            hooks_url: format!("http://127.0.0.1:{}/hooks/agent", port),
            hooks_token: token,
        })
    }
}

impl PlatformAdapter for OpenClawAdapter {
    fn name(&self) -> &str { "openclaw" }

    fn deliver(&self, from: &str, content: &str, _message_id: &str, _conversation_id: &str) -> Result<()> {
        let payload = serde_json::json!({
            "message": format!("SignalDock message from @{}:\n\n{}", from, content),
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
            .send()?;

        if resp.status().is_success() {
            tracing::info!(from = from, "Agent woken via OpenClaw hooks/agent");
        } else {
            tracing::warn!(status = %resp.status(), "OpenClaw hooks/agent failed");
        }
        Ok(())
    }
}

// ============================================================
// Webhook Adapter — POST to custom URL
// ============================================================

struct WebhookAdapter {
    url: String,
}

impl WebhookAdapter {
    fn new(url: String) -> Self {
        Self { url }
    }
}

impl PlatformAdapter for WebhookAdapter {
    fn name(&self) -> &str { "webhook" }

    fn deliver(&self, from: &str, content: &str, message_id: &str, conversation_id: &str) -> Result<()> {
        let payload = serde_json::json!({
            "from": from,
            "content": content,
            "messageId": message_id,
            "conversationId": conversation_id,
        });

        let client = reqwest::blocking::Client::new();
        let resp = client.post(&self.url)
            .json(&payload)
            .timeout(std::time::Duration::from_secs(10))
            .send()?;

        tracing::info!(from = from, status = %resp.status(), "Delivered via webhook");
        Ok(())
    }
}

// ============================================================
// Stdout Adapter — Print to stdout (pipe to anything)
// ============================================================

struct StdoutAdapter;

impl PlatformAdapter for StdoutAdapter {
    fn name(&self) -> &str { "stdout" }

    fn deliver(&self, from: &str, content: &str, message_id: &str, conversation_id: &str) -> Result<()> {
        let msg = serde_json::json!({
            "from": from,
            "content": content,
            "messageId": message_id,
            "conversationId": conversation_id,
            "timestamp": chrono::Utc::now().to_rfc3339(),
        });
        println!("{}", serde_json::to_string(&msg)?);
        Ok(())
    }
}
