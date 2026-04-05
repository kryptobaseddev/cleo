//! Adapter system — unified delivery infrastructure for SignalDock Runtime.
//!
//! ```text
//! src/adapters/
//! ├── mod.rs              ← This file: top-level exports
//! ├── adapter.rs          ← Adapter trait (transport SSOT)
//! ├── http.rs             ← HTTP POST transport
//! ├── stdout.rs           ← Stdout transport
//! ├── file.rs             ← File write transport
//! └── providers/          ← Agent platform providers
//!     ├── mod.rs          ← Provider registry + barrel exports
//!     ├── provider.rs     ← Provider trait (platform SSOT)
//!     ├── detect.rs       ← Auto-detection + factory
//!     ├── openclaw.rs     ← OpenClaw
//!     ├── claude_code.rs  ← Claude Code
//!     ├── codex.rs        ← OpenAI Codex
//!     ├── gemini.rs       ← Google Gemini
//!     ├── copilot.rs      ← GitHub Copilot
//!     ├── opencode.rs     ← OpenCode
//!     └── generic.rs      ← Webhook / Stdout / File wrappers
//! ```
//!
//! **Adapters** = transport mechanisms (HOW to deliver)
//! **Providers** = agent platforms (WHERE to deliver, using adapters)

// Transport layer
pub mod base;
pub mod file;
pub mod http;
pub mod stdout;

// Platform providers (nested)
pub mod providers;

// Re-export transport types
pub use base::{Adapter, AdapterConfig, TransportResult};
pub use file::FileAdapter;
pub use http::HttpAdapter;
pub use stdout::StdoutAdapter;

// Re-export provider types (bubble up for convenience)
pub use providers::provider::{DeliveryResult, Message, Provider, ProviderInfo};
pub use providers::{create_provider, detect_provider};
