//! Adapter factory — creates the right adapter from config.
//!
//! Single Responsibility: map platform string → concrete adapter instance.

use anyhow::{Context, Result};
use crate::config::Config;
use super::base::PlatformAdapter;
use super::{OpenClawAdapter, WebhookAdapter, StdoutAdapter, FileAdapter};

/// Create a platform adapter based on the config's `platform` field.
///
/// Supported platforms:
/// - `"openclaw"` → OpenClawAdapter (auto-reads ~/.openclaw/openclaw.json)
/// - `"webhook"`  → WebhookAdapter (requires config.webhook_url)
/// - `"file"`     → FileAdapter (writes JSON to directory)
/// - `"stdout"`   → StdoutAdapter (prints JSON to stdout)
pub fn create(config: &Config) -> Result<Box<dyn PlatformAdapter>> {
    match config.platform.as_str() {
        "openclaw" => {
            Ok(Box::new(
                OpenClawAdapter::from_auto_detect()
                    .context("Failed to configure OpenClaw adapter — is hooks.enabled=true in openclaw.json?")?
            ))
        }
        "webhook" => {
            let url = config.webhook_url.as_ref()
                .context("--webhook URL required when platform is 'webhook'")?;
            Ok(Box::new(WebhookAdapter::new(url.clone())))
        }
        "file" => {
            let dir = config.file_output_dir.clone()
                .unwrap_or_else(|| {
                    dirs::home_dir()
                        .unwrap_or_default()
                        .join(".signaldock/messages")
                        .to_string_lossy()
                        .to_string()
                });
            Ok(Box::new(FileAdapter::new(dir)))
        }
        "stdout" => Ok(Box::new(StdoutAdapter)),
        unknown => {
            eprintln!("[signaldock] Unknown platform '{}' — falling back to stdout", unknown);
            Ok(Box::new(StdoutAdapter))
        }
    }
}
