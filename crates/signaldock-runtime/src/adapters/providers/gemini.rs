//! Google Gemini CLI provider.
//!
//! Detection: `gemini` CLI in PATH, or ~/.gemini/ config
//! Delivery: TBD

use anyhow::Result;
use super::provider::*;

pub struct GeminiProvider {
    config_dir: String,
}

impl Provider for GeminiProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            name: "gemini",
            display_name: "Google Gemini CLI",
            version: "2026.x",
            config_paths: &["~/.gemini/"],
            docs_url: "https://ai.google.dev/gemini-api/docs",
        }
    }

    fn detect() -> Option<Box<dyn Provider>> {
        let home = dirs::home_dir()?;
        let dir = home.join(".gemini");
        if dir.exists() {
            eprintln!("[signaldock] Detected Gemini config at {}", dir.display());
            return Some(Box::new(Self { config_dir: dir.to_string_lossy().to_string() }));
        }
        if which_exists("gemini") {
            eprintln!("[signaldock] Detected gemini CLI in PATH");
            return Some(Box::new(Self { config_dir: dir.to_string_lossy().to_string() }));
        }
        None
    }

    fn deliver(&self, msg: &Message) -> Result<DeliveryResult> {
        let messages_dir = std::path::Path::new(&self.config_dir).join("messages");
        std::fs::create_dir_all(&messages_dir)?;
        let path = messages_dir.join(format!("{}.json", msg.id));
        std::fs::write(&path, serde_json::to_string_pretty(&serde_json::json!({
            "from": msg.from, "content": msg.content,
            "messageId": msg.id, "createdAt": msg.created_at,
        }))?)?;
        eprintln!("[signaldock] Gemini: written to {}", path.display());
        Ok(DeliveryResult::Delivered)
    }
}

fn which_exists(cmd: &str) -> bool {
    std::process::Command::new("which").arg(cmd).output()
        .map(|o| o.status.success()).unwrap_or(false)
}
