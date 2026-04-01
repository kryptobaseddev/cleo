//! Provider trait — the SSOT interface for all agent platform providers.
//!
//! Every provider MUST implement this trait. This is the single contract
//! that the runtime uses to interact with any agent harness.
//!
//! ## Implementing a new provider
//!
//! ```rust
//! use crate::providers::provider::*;
//!
//! pub struct MyProvider {
//!     config_path: String,
//!     endpoint: String,
//! }
//!
//! impl Provider for MyProvider {
//!     fn info(&self) -> ProviderInfo {
//!         ProviderInfo {
//!             name: "my-provider",
//!             display_name: "My Agent Platform",
//!             version: "1.0",
//!             config_paths: &["~/.my-provider/config.json"],
//!             docs_url: "https://my-provider.dev/docs",
//!         }
//!     }
//!     fn detect() -> Option<Box<dyn Provider>> { ... }
//!     fn deliver(&self, msg: &Message) -> anyhow::Result<DeliveryResult> { ... }
//! }
//! ```

use serde::{Deserialize, Serialize};

/// Static metadata about a provider.
#[derive(Debug, Clone)]
pub struct ProviderInfo {
    /// Machine name (used in --platform flag): "openclaw", "claude-code", etc.
    pub name: &'static str,
    /// Human-readable name: "OpenClaw", "Claude Code", etc.
    pub display_name: &'static str,
    /// Provider version (from their config/binary).
    pub version: &'static str,
    /// Config file paths the provider looks for (for docs/debugging).
    pub config_paths: &'static [&'static str],
    /// Link to provider documentation.
    pub docs_url: &'static str,
}

/// A normalized message from SignalDock, ready for delivery.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// SignalDock message ID (UUID)
    pub id: String,
    /// Sender agent ID
    pub from: String,
    /// Sender display name (if available)
    pub from_name: Option<String>,
    /// Message content (text)
    pub content: String,
    /// Conversation ID
    pub conversation_id: String,
    /// Content type (usually "text")
    pub content_type: String,
    /// ISO 8601 timestamp
    pub created_at: String,
    /// Raw metadata from SignalDock
    pub metadata: serde_json::Value,
}

/// Result of a delivery attempt.
#[derive(Debug)]
pub enum DeliveryResult {
    /// Message delivered successfully.
    Delivered,
    /// Transient failure — runtime should retry next cycle.
    Retry(String),
    /// Permanent failure — skip this message.
    Failed(String),
}

/// The trait all platform providers MUST implement.
///
/// This is the SSOT interface. The runtime never talks to providers
/// except through this trait.
pub trait Provider: Send + Sync {
    /// Return static info about this provider.
    fn info(&self) -> ProviderInfo;

    /// Try to detect this provider on the local machine.
    /// Returns Some(configured_instance) if found, None if not installed.
    ///
    /// Detection should be fast (filesystem checks only, no network).
    fn detect() -> Option<Box<dyn Provider>> where Self: Sized;

    /// Deliver a message to the agent platform.
    ///
    /// This is the core method. It should:
    /// 1. Format the message for the platform
    /// 2. Call the platform's wake/trigger mechanism
    /// 3. Return the delivery result
    fn deliver(&self, msg: &Message) -> anyhow::Result<DeliveryResult>;

    /// Check if the provider is healthy and can accept deliveries.
    /// Default: always true.
    fn is_healthy(&self) -> bool { true }

    /// Human-readable status string for `signaldock status`.
    fn status_line(&self) -> String {
        let info = self.info();
        format!("{} ({})", info.display_name, if self.is_healthy() { "healthy" } else { "unhealthy" })
    }
}
