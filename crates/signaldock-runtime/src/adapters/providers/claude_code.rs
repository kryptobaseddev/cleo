//! Claude Code provider — Anthropic's Claude Code / CLI agent.
//!
//! Detection: ~/.claude/ directory exists
//! Delivery: Write message to ~/.claude/messages/ (file-based wake)
//! TODO: When Claude Code exposes an API/hook, use that instead

use super::provider::*;
use anyhow::Result;

pub struct ClaudeCodeProvider {
    messages_dir: String,
}

impl Provider for ClaudeCodeProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            name: "claude-code",
            display_name: "Claude Code",
            version: "2026.x",
            config_paths: &["~/.claude/"],
            docs_url: "https://docs.anthropic.com/claude-code",
        }
    }

    fn detect() -> Option<Box<dyn Provider>> {
        let home = dirs::home_dir()?;
        let claude_dir = home.join(".claude");
        if !claude_dir.exists() {
            return None;
        }

        let messages_dir = claude_dir.join("messages");
        eprintln!(
            "[signaldock] Detected Claude Code at {}",
            claude_dir.display()
        );

        Some(Box::new(Self {
            messages_dir: messages_dir.to_string_lossy().to_string(),
        }))
    }

    fn deliver(&self, msg: &Message) -> Result<DeliveryResult> {
        std::fs::create_dir_all(&self.messages_dir)?;
        let filename = format!("{}.json", msg.id);
        let path = std::path::Path::new(&self.messages_dir).join(&filename);

        let output = serde_json::json!({
            "from": msg.from,
            "content": msg.content,
            "messageId": msg.id,
            "conversationId": msg.conversation_id,
            "createdAt": msg.created_at,
        });

        std::fs::write(&path, serde_json::to_string_pretty(&output)?)?;
        eprintln!("[signaldock] Written to {}", path.display());
        Ok(DeliveryResult::Delivered)
    }
}
