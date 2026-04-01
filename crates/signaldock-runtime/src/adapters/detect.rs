//! Platform auto-detection.
//!
//! Scans the local filesystem for known agent platform configs
//! and returns the best match.

/// Detect which agent platform is running on this machine.
/// Returns a platform identifier string matching the adapter names.
pub fn detect_platform() -> String {
    if let Some(home) = dirs::home_dir() {
        // OpenClaw: ~/.openclaw/openclaw.json with hooks.enabled = true
        if is_openclaw_with_hooks(&home) {
            eprintln!("[signaldock] Auto-detected: OpenClaw (hooks enabled)");
            return "openclaw".into();
        }

        // Claude Code: ~/.claude/ directory exists
        if home.join(".claude").exists() {
            eprintln!("[signaldock] Auto-detected: Claude Code");
            return "file".into();
        }

        // Cursor: ~/.cursor/ directory exists
        if home.join(".cursor").exists() {
            eprintln!("[signaldock] Auto-detected: Cursor");
            return "file".into();
        }

        // OpenClaw without hooks — fallback
        if home.join(".openclaw/openclaw.json").exists() {
            eprintln!("[signaldock] Found OpenClaw but hooks not enabled — using stdout");
        }
    }

    eprintln!("[signaldock] No platform detected — using stdout");
    "stdout".into()
}

fn is_openclaw_with_hooks(home: &std::path::Path) -> bool {
    let path = home.join(".openclaw/openclaw.json");
    std::fs::read_to_string(path).ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|j| j.get("hooks")?.get("enabled")?.as_bool())
        .unwrap_or(false)
}
