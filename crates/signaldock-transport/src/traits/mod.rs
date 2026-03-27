//! Core transport traits and shared delivery types.
//!
//! Defines the `TransportAdapter` trait that all delivery
//! mechanisms implement, plus supporting types
//! (`DeliveryTarget`, `DeliveryResult`, `RetryPolicy`)
//! and the priority-ordered `DeliveryChain`.
//!
//! # Design
//!
//! See [ADR-001: Transport Protocol](../../../docs/dev/adr/001-transport-protocol.md).

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use signaldock_protocol::message::DeliveryEvent;

/// The target agent for delivery, including connection info.
///
/// Carries the identifiers and optional webhook configuration
/// needed by each [`TransportAdapter`] to route a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryTarget {
    /// Human-readable agent slug (e.g. `"cleo-assistant"`).
    pub agent_id: String,
    /// Webhook endpoint URL, if the agent has one configured.
    pub endpoint: Option<String>,
    /// HMAC-SHA256 signing secret for webhook delivery.
    pub webhook_secret: Option<String>,
}

/// Result of a single delivery attempt.
///
/// Returned by [`TransportAdapter::deliver`]. A successful
/// delivery sets `success = true`. On failure,
/// `permanent_failure` distinguishes retryable errors (e.g.
/// 5xx) from permanent ones (e.g. 4xx, missing endpoint).
///
/// Note that [`TransportAdapter::deliver`] returns
/// `Ok(DeliveryResult)` even for recoverable failures.
/// `Err` is reserved for unexpected internal errors.
#[derive(Debug, Clone)]
pub struct DeliveryResult {
    /// Whether delivery succeeded.
    pub success: bool,
    /// Transport name that attempted delivery
    /// (e.g. `"sse"`, `"webhook"`).
    pub transport: &'static str,
    /// HTTP status code, if applicable.
    pub status_code: Option<u16>,
    /// Round-trip time in milliseconds.
    pub response_time_ms: Option<u64>,
    /// Error message on failure.
    pub error: Option<String>,
    /// When `true`, the failure is permanent (e.g. 4xx)
    /// and should not be retried.
    pub permanent_failure: bool,
}

impl DeliveryResult {
    /// Creates a successful delivery result.
    ///
    /// Records the transport name, optional HTTP status code,
    /// and elapsed time in milliseconds.
    pub fn success(
        transport: &'static str,
        status_code: Option<u16>,
        response_time_ms: u64,
    ) -> Self {
        Self {
            success: true,
            transport,
            status_code,
            response_time_ms: Some(response_time_ms),
            error: None,
            permanent_failure: false,
        }
    }

    /// Creates a failed delivery result.
    ///
    /// Set `permanent` to `true` for non-retryable failures
    /// (e.g. invalid endpoint, 4xx response).
    pub fn failure(transport: &'static str, error: String, permanent: bool) -> Self {
        Self {
            success: false,
            transport,
            status_code: None,
            response_time_ms: None,
            error: Some(error),
            permanent_failure: permanent,
        }
    }

    /// Creates a not-connected delivery result.
    ///
    /// Indicates the agent has no active connection on this
    /// transport. This is a transient, non-permanent failure.
    pub fn not_connected(transport: &'static str) -> Self {
        Self {
            success: false,
            transport,
            status_code: None,
            response_time_ms: None,
            error: Some("agent not connected".to_string()),
            permanent_failure: false,
        }
    }
}

/// Retry policy for delivery attempts.
///
/// Controls exponential backoff parameters. The
/// [`Default`] implementation provides sensible production
/// defaults: 6 attempts, 1 s base delay, 32 s maximum delay.
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// Maximum number of retry attempts (default: 6).
    pub max_attempts: u32,
    /// Base delay in milliseconds (default: 1000).
    pub base_delay_ms: u64,
    /// Maximum delay cap in milliseconds (default: 32000).
    pub max_delay_ms: u64,
}

impl Default for RetryPolicy {
    /// Returns a policy with 6 attempts, 1 s base delay,
    /// and 32 s maximum delay.
    fn default() -> Self {
        Self {
            max_attempts: 6,
            base_delay_ms: 1_000,
            max_delay_ms: 32_000,
        }
    }
}

impl RetryPolicy {
    /// Computes the backoff delay for a 1-indexed attempt.
    ///
    /// Uses exponential backoff: `base_delay * 2^(attempt-1)`,
    /// capped at [`max_delay_ms`](Self::max_delay_ms).
    pub fn delay_for_attempt(&self, attempt: u32) -> std::time::Duration {
        let exp = attempt.saturating_sub(1);
        let delay_ms = (self.base_delay_ms * 2u64.pow(exp)).min(self.max_delay_ms);
        std::time::Duration::from_millis(delay_ms)
    }
}

/// Core transport adapter trait.
///
/// Each delivery mechanism (SSE, WebSocket, webhook, HTTP/2)
/// implements this trait. Adapters are composed into a
/// [`DeliveryChain`] for priority-ordered delivery.
///
/// # Implementor notes
///
/// - [`deliver`](Self::deliver) should return
///   `Ok(DeliveryResult)` for expected outcomes (success,
///   not-connected, 4xx). Reserve `Err` for unexpected
///   internal errors only.
/// - [`is_connected`](Self::is_connected) must be cheap to
///   call; the [`DeliveryChain`] invokes it before each
///   delivery attempt.
#[async_trait]
pub trait TransportAdapter: Send + Sync {
    /// Returns the human-readable transport name
    /// (e.g. `"sse"`, `"webhook"`).
    fn name(&self) -> &'static str;

    /// Whether this transport can actively push events
    /// to agents (as opposed to requiring polling).
    fn supports_push(&self) -> bool;

    /// Delivers an event to a target agent (single attempt).
    ///
    /// # Errors
    ///
    /// Returns `Err` only for unexpected internal errors.
    /// Recoverable failures (not connected, HTTP 4xx) are
    /// returned as `Ok(DeliveryResult)` with
    /// `success = false`.
    async fn deliver(
        &self,
        event: &DeliveryEvent,
        target: &DeliveryTarget,
    ) -> Result<DeliveryResult>;

    /// Checks whether the given agent is connected via
    /// this transport.
    async fn is_connected(&self, agent_id: &str) -> bool;
}

/// Priority-ordered delivery chain.
///
/// Holds a `Vec` of [`TransportAdapter`] trait objects and
/// tries them in order. The first adapter where
/// [`is_connected`](TransportAdapter::is_connected) returns
/// `true` and [`deliver`](TransportAdapter::deliver) succeeds
/// wins. Disconnected adapters are skipped. If an adapter
/// returns a permanent failure, iteration stops immediately.
pub struct DeliveryChain {
    adapters: Vec<Box<dyn TransportAdapter>>,
}

impl DeliveryChain {
    /// Creates a new delivery chain from an ordered list of
    /// adapters.
    ///
    /// Adapters are tried in the order provided: put the
    /// lowest-latency adapter first (e.g. SSE before webhook).
    pub fn new(adapters: Vec<Box<dyn TransportAdapter>>) -> Self {
        Self { adapters }
    }

    /// Returns `true` if the agent is connected on any
    /// adapter in the chain.
    pub async fn is_connected(&self, agent_id: &str) -> bool {
        for adapter in &self.adapters {
            if adapter.is_connected(agent_id).await {
                return true;
            }
        }
        false
    }

    /// Tries delivery in priority order.
    ///
    /// Returns the first successful result, or the last
    /// failure if all adapters fail or are not connected.
    /// Stops early on permanent failures (e.g. 4xx from
    /// webhook).
    pub async fn deliver(&self, event: &DeliveryEvent, target: &DeliveryTarget) -> DeliveryResult {
        let mut last_result =
            DeliveryResult::failure("none", "no adapters configured".to_string(), false);

        for adapter in &self.adapters {
            if !adapter.is_connected(&target.agent_id).await {
                continue;
            }

            match adapter.deliver(event, target).await {
                Ok(result) => {
                    if result.success {
                        return result;
                    }
                    if result.permanent_failure {
                        return result;
                    }
                    last_result = result;
                }
                Err(e) => {
                    last_result = DeliveryResult::failure(adapter.name(), e.to_string(), false);
                }
            }
        }

        last_result
    }

    /// Returns a reference to the adapter with the given name,
    /// or `None` if no adapter matches.
    pub fn get_adapter(&self, name: &str) -> Option<&dyn TransportAdapter> {
        self.adapters
            .iter()
            .find(|a| a.name() == name)
            .map(|a| a.as_ref())
    }
}

#[cfg(test)]
mod tests;
