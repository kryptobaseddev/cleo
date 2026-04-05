//! Provider factory — creates the right provider from config.
//!
//! Single Responsibility: map platform string → concrete provider instance.
//! No detection logic — that lives in detect.rs.

use super::provider::Provider;
use super::*;
use crate::config::Config;
use anyhow::{Context, Result};

/// Create a provider instance from the config's `platform` field.
pub fn create_provider(config: &Config) -> Result<Box<dyn Provider>> {
    match config.platform.as_str() {
        "openclaw" => OpenClawProvider::detect()
            .or_else(|| Some(Box::new(OpenClawProvider::new_default())))
            .context("OpenClaw provider failed"),
        "claude-code" => {
            ClaudeCodeProvider::detect().context("Claude Code not found — is it installed?")
        }
        "codex" => CodexProvider::detect().context("Codex CLI not found — is it installed?"),
        "gemini" => GeminiProvider::detect().context("Gemini CLI not found — is it installed?"),
        "copilot" => CopilotProvider::detect().context("Copilot not found — is it installed?"),
        "opencode" => OpenCodeProvider::detect().context("OpenCode not found — is it installed?"),
        "webhook" => {
            let url = config
                .webhook_url
                .as_ref()
                .context("--webhook URL required")?;
            Ok(Box::new(WebhookProvider::new(url.clone())))
        }
        "file" => {
            let dir = config.file_output_dir.clone().unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_default()
                    .join(".signaldock/messages")
                    .to_string_lossy()
                    .to_string()
            });
            Ok(Box::new(FileProvider::new(dir)))
        }
        "stdout" | _ => Ok(Box::new(StdoutProvider)),
    }
}
