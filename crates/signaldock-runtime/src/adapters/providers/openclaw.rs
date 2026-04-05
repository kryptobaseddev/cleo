//! OpenClaw provider — delivers messages via /hooks/agent.
//!
//! Detection: ~/.openclaw/openclaw.json with hooks.enabled = true
//! Delivery: Uses HttpAdapter to POST to http://127.0.0.1:{port}/hooks/agent

use super::provider::*;
use crate::adapters::HttpAdapter;
use crate::adapters::base::{Adapter, TransportResult};
use anyhow::{Context, Result};

pub struct OpenClawProvider {
    http: HttpAdapter,
    port: u16,
}

impl OpenClawProvider {
    pub fn new(port: u16, token: String) -> Self {
        Self {
            http: HttpAdapter::new(
                format!("http://127.0.0.1:{}/hooks/agent", port),
                Some(format!("Bearer {}", token)),
            ),
            port,
        }
    }

    pub fn new_default() -> Self {
        Self::new(18789, String::new())
    }
}

impl Provider for OpenClawProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            name: "openclaw",
            display_name: "OpenClaw",
            version: "2026.x",
            config_paths: &["~/.openclaw/openclaw.json"],
            docs_url: "https://docs.openclaw.ai",
        }
    }

    fn detect() -> Option<Box<dyn Provider>> {
        let home = dirs::home_dir()?;
        let content = std::fs::read_to_string(home.join(".openclaw/openclaw.json")).ok()?;
        let json: serde_json::Value = serde_json::from_str(&content).ok()?;

        if json.get("hooks")?.get("enabled")?.as_bool()? != true {
            return None;
        }

        let port = json
            .get("gateway")
            .and_then(|g| g.get("port"))
            .and_then(|p| p.as_u64())
            .unwrap_or(18789) as u16;
        let token = json.get("hooks")?.get("token")?.as_str()?.to_string();

        eprintln!(
            "[signaldock] Detected OpenClaw on port {} with hooks enabled",
            port
        );
        Some(Box::new(Self::new(port, token)))
    }

    fn deliver(&self, msg: &Message) -> Result<DeliveryResult> {
        let payload = serde_json::json!({
            "message": format!("SignalDock message from @{}:\n\n{}", msg.from, msg.content),
            "name": "SignalDock",
            "deliver": true,
            "channel": "telegram",
            "wakeMode": "now"
        });

        match self.http.send(&payload)? {
            TransportResult::Ok => {
                eprintln!("[signaldock] Delivered to OpenClaw (port {})", self.port);
                Ok(DeliveryResult::Delivered)
            }
            TransportResult::RetryableError(e) => Ok(DeliveryResult::Retry(e)),
            TransportResult::PermanentError(e) => Ok(DeliveryResult::Failed(e)),
        }
    }

    fn is_healthy(&self) -> bool {
        let health = crate::adapters::HttpAdapter::new(
            format!("http://127.0.0.1:{}/health", self.port),
            None,
        );
        matches!(
            health.send(&serde_json::json!({})),
            Ok(TransportResult::Ok) | Err(_)
        )
    }
}
