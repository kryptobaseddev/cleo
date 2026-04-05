//! OpenAI Codex CLI provider.
//!
//! Detection: `codex` or `openai` CLI in PATH, or ~/.codex/ config
//! Delivery: TBD — file-based or stdin injection

use super::provider::*;
use anyhow::Result;

pub struct CodexProvider {
    config_dir: String,
}

impl Provider for CodexProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            name: "codex",
            display_name: "OpenAI Codex",
            version: "2026.x",
            config_paths: &["~/.codex/", "~/.openai/"],
            docs_url: "https://platform.openai.com/docs/codex",
        }
    }

    fn detect() -> Option<Box<dyn Provider>> {
        let home = dirs::home_dir()?;

        // Check for .codex config dir
        for dir_name in &[".codex", ".openai"] {
            let dir = home.join(dir_name);
            if dir.exists() {
                eprintln!("[signaldock] Detected Codex config at {}", dir.display());
                return Some(Box::new(Self {
                    config_dir: dir.to_string_lossy().to_string(),
                }));
            }
        }

        // Check if codex CLI is in PATH
        if which_exists("codex") {
            eprintln!("[signaldock] Detected codex CLI in PATH");
            return Some(Box::new(Self {
                config_dir: home.join(".codex").to_string_lossy().to_string(),
            }));
        }

        None
    }

    fn deliver(&self, msg: &Message) -> Result<DeliveryResult> {
        // TODO: Implement Codex-specific delivery
        // For now, write to messages directory
        let messages_dir = std::path::Path::new(&self.config_dir).join("messages");
        std::fs::create_dir_all(&messages_dir)?;

        let path = messages_dir.join(format!("{}.json", msg.id));
        let output = serde_json::json!({
            "from": msg.from,
            "content": msg.content,
            "messageId": msg.id,
            "conversationId": msg.conversation_id,
            "createdAt": msg.created_at,
        });
        std::fs::write(&path, serde_json::to_string_pretty(&output)?)?;
        eprintln!("[signaldock] Codex: written to {}", path.display());
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
