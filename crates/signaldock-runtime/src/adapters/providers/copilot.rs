//! GitHub Copilot provider.
//!
//! Detection: `gh copilot` available, or ~/.config/github-copilot/
//! Delivery: TBD

use anyhow::Result;
use super::provider::*;

pub struct CopilotProvider {
    config_dir: String,
}

impl Provider for CopilotProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            name: "copilot",
            display_name: "GitHub Copilot",
            version: "2026.x",
            config_paths: &["~/.config/github-copilot/"],
            docs_url: "https://docs.github.com/copilot",
        }
    }

    fn detect() -> Option<Box<dyn Provider>> {
        let home = dirs::home_dir()?;
        let dir = home.join(".config/github-copilot");
        if dir.exists() {
            eprintln!("[signaldock] Detected GitHub Copilot at {}", dir.display());
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
        eprintln!("[signaldock] Copilot: written to {}", path.display());
        Ok(DeliveryResult::Delivered)
    }
}
