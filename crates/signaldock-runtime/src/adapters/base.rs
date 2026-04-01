//! Base trait for all platform adapters.
//!
//! Every adapter MUST implement this trait. It provides the unified interface
//! that the receiver uses to deliver messages to the agent's platform.
//!
//! ## Building a new adapter
//!
//! ```rust
//! use crate::adapters::base::{PlatformAdapter, Message};
//!
//! pub struct MyAdapter { /* config */ }
//!
//! impl PlatformAdapter for MyAdapter {
//!     fn name(&self) -> &str { "my-platform" }
//!
//!     fn deliver(&self, msg: &Message) -> anyhow::Result<DeliveryResult> {
//!         // Your delivery logic here
//!         Ok(DeliveryResult::Delivered)
//!     }
//! }
//! ```

use serde::{Deserialize, Serialize};

/// A normalized message from SignalDock, ready for delivery to an adapter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// SignalDock message ID (UUID)
    pub id: String,
    /// Sender agent ID
    pub from: String,
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
    /// Message was delivered successfully.
    Delivered,
    /// Delivery failed but should be retried.
    Retry(String),
    /// Delivery permanently failed — do not retry.
    Failed(String),
}

/// The trait all platform adapters must implement.
///
/// Adapters are responsible for taking a SignalDock message and
/// waking/notifying the target agent platform.
pub trait PlatformAdapter: Send + Sync {
    /// Human-readable name of this adapter (e.g., "openclaw", "webhook").
    fn name(&self) -> &str;

    /// Deliver a message to the platform.
    ///
    /// Return `DeliveryResult::Delivered` on success.
    /// Return `DeliveryResult::Retry` for transient failures (network, timeout).
    /// Return `DeliveryResult::Failed` for permanent failures (auth, config).
    fn deliver(&self, msg: &Message) -> anyhow::Result<DeliveryResult>;

    /// Check if the adapter is healthy and can accept deliveries.
    /// Default implementation always returns true.
    fn is_healthy(&self) -> bool {
        true
    }

    /// Optional setup/initialization. Called once when adapter is created.
    fn init(&mut self) -> anyhow::Result<()> {
        Ok(())
    }
}
