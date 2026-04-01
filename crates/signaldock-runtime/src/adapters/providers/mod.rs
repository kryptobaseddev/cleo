//! Agent platform providers for SignalDock Runtime.
//!
//! A **provider** represents an agent harness / coding agent / LLM platform
//! that can receive and process messages. Each provider knows how to:
//! 1. Detect if it's installed on this machine
//! 2. Read its local config to find connection details  
//! 3. Deliver a message to wake/trigger the agent
//! 4. Report its health status
//!
//! ## Architecture
//!
//! ```text
//! providers/
//! ├── mod.rs           ← Barrel exports + registry
//! ├── provider.rs      ← Provider trait (SSOT interface)
//! ├── detect.rs        ← Auto-detection: scan machine for installed providers
//! ├── openclaw.rs      ← OpenClaw (hooks/agent)
//! ├── claude_code.rs   ← Claude Code / Anthropic CLI
//! ├── codex.rs         ← OpenAI Codex CLI  
//! ├── gemini.rs        ← Google Gemini CLI
//! ├── copilot.rs       ← GitHub Copilot
//! ├── opencode.rs      ← OpenCode
//! └── generic.rs       ← Webhook / stdout / file fallbacks
//! ```
//!
//! ## Adding a new provider
//!
//! 1. Create `src/providers/my_provider.rs`
//! 2. Implement the `Provider` trait
//! 3. Add `pub mod my_provider;` below
//! 4. Register in `PROVIDERS` array in this file
//! 5. That's it — detection and factory are automatic

// SSOT interface — every provider implements this
pub mod provider;

// Auto-detection + factory
pub mod detect;
pub mod factory;

// --- Provider implementations ---
pub mod openclaw;
pub mod claude_code;
pub mod codex;
pub mod gemini;
pub mod copilot;
pub mod opencode;
pub mod generic;

// Re-export the trait and core types
pub use provider::{Provider, ProviderInfo, DeliveryResult, Message};

// Re-export concrete providers
pub use openclaw::OpenClawProvider;
pub use claude_code::ClaudeCodeProvider;
pub use codex::CodexProvider;
pub use gemini::GeminiProvider;
pub use copilot::CopilotProvider;
pub use opencode::OpenCodeProvider;
pub use generic::{WebhookProvider, StdoutProvider, FileProvider};

// Re-export detection
pub use detect::detect_provider;
pub use factory::create_provider;

/// Registry of all known providers, checked in priority order.
/// First match wins during auto-detection.
pub const PROVIDER_NAMES: &[&str] = &[
    "openclaw",
    "claude-code",
    "codex",
    "gemini",
    "copilot",
    "opencode",
    // Generic fallbacks (never auto-detected, must be explicit)
    // "webhook", "file", "stdout"
];
