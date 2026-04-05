//! OpenCode provider.
//!
//! Detection: `opencode` CLI in PATH, or ~/.opencode/ config
//! Delivery: TBD

use super::provider::*;
use anyhow::Result;

pub struct OpenCodeProvider {
    config_dir: String,
}

impl Provider for OpenCodeProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            name: "opencode",
            display_name: "OpenCode",
            version: "2026.x",
            config_paths: &["~/.opencode/"],
            docs_url: "https://opencode.dev",
        }
    }

    fn detect() -> Option<Box<dyn Provider>> {
        let home = dirs::home_dir()?;
        let dir = home.join(".opencode");
        if dir.exists() {
            eprintln!("[signaldock] Detected OpenCode at {}", dir.display());
            return Some(Box::new(Self {
                config_dir: dir.to_string_lossy().to_string(),
            }));
        }
        if which_exists("opencode") {
            eprintln!("[signaldock] Detected opencode CLI in PATH");
            return Some(Box::new(Self {
                config_dir: dir.to_string_lossy().to_string(),
            }));
        }
        None
    }

    fn deliver(&self, msg: &Message) -> Result<DeliveryResult> {
        let messages_dir = std::path::Path::new(&self.config_dir).join("messages");
        std::fs::create_dir_all(&messages_dir)?;
        let path = messages_dir.join(format!("{}.json", msg.id));
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&serde_json::json!({
                "from": msg.from, "content": msg.content,
                "messageId": msg.id, "createdAt": msg.created_at,
            }))?,
        )?;
        eprintln!("[signaldock] OpenCode: written to {}", path.display());
        Ok(DeliveryResult::Delivered)
    }
}

fn which_exists(cmd: &str) -> bool {
    std::process::Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
