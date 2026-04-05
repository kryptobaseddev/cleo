//! Platform auto-detection.
//!
//! Scans the local machine for installed agent platforms.
//! Returns the first match in priority order.
//! Single Responsibility: detection only — no creation logic.

use super::*;

/// Auto-detect which provider is available on this machine.
/// Returns the platform name string for config.
pub fn detect_provider() -> String {
    if OpenClawProvider::detect().is_some() {
        return "openclaw".into();
    }
    if ClaudeCodeProvider::detect().is_some() {
        return "claude-code".into();
    }
    if CodexProvider::detect().is_some() {
        return "codex".into();
    }
    if GeminiProvider::detect().is_some() {
        return "gemini".into();
    }
    if CopilotProvider::detect().is_some() {
        return "copilot".into();
    }
    if OpenCodeProvider::detect().is_some() {
        return "opencode".into();
    }

    eprintln!("[signaldock] No agent platform detected — using stdout");
    "stdout".into()
}
