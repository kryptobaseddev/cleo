//! Redis pub/sub transport adapter for cross-instance SSE fan-out.
//!
//! Publishes [`DeliveryEvent`] payloads to Redis channels keyed by
//! agent ID. Subscribers (typically SSE handlers on other API
//! instances) receive events in real time, enabling horizontal
//! scaling and zero-downtime deploys.
//!
//! # Channel naming
//!
//! - `signaldock:agent:{agent_id}:messages` — per-agent event channel
//! - `signaldock:presence` — agent online/offline notifications
//!
//! # Feature flag
//!
//! This module is gated behind the `redis-pubsub` feature. When the
//! feature is disabled, the adapter compiles to a no-op stub.

use anyhow::Result;
use async_trait::async_trait;
use redis::AsyncCommands as _;
use tracing::{debug, warn};

use signaldock_protocol::message::DeliveryEvent;

use crate::traits::{DeliveryResult, DeliveryTarget, TransportAdapter};

/// Channel prefix for per-agent message delivery.
const CHANNEL_PREFIX: &str = "signaldock:agent:";

/// Channel suffix for message events.
const CHANNEL_SUFFIX: &str = ":messages";

/// Redis pub/sub transport adapter.
///
/// Publishes serialized delivery events to Redis channels. Each
/// agent has a dedicated channel. Other API instances subscribe
/// to these channels and forward events to their local SSE
/// connections.
///
/// This adapter does NOT manage subscriptions — that is handled
/// by the SSE adapter's Redis backing (see [`super::sse`]).
#[derive(Clone)]
pub struct RedisPubSubAdapter {
    client: redis::Client,
}

impl RedisPubSubAdapter {
    /// Creates a new Redis pub/sub adapter from a connection URL.
    ///
    /// # Errors
    ///
    /// Returns an error if the Redis URL is invalid.
    pub fn new(redis_url: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url)?;
        Ok(Self { client })
    }

    /// Creates a new adapter from an existing [`redis::Client`].
    pub fn from_client(client: redis::Client) -> Self {
        Self { client }
    }

    /// Returns the Redis channel name for an agent.
    fn channel_for(agent_id: &str) -> String {
        format!("{CHANNEL_PREFIX}{agent_id}{CHANNEL_SUFFIX}")
    }

    /// Publishes a raw JSON payload to an agent's channel.
    ///
    /// # Errors
    ///
    /// Returns an error if the Redis connection or publish fails.
    pub async fn publish_raw(&self, agent_id: &str, payload: &str) -> Result<()> {
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        let channel = Self::channel_for(agent_id);
        conn.publish::<_, _, ()>(&channel, payload).await?;
        debug!(agent_id, channel, "Published event to Redis");
        Ok(())
    }

    /// Buffers a message in a Redis list for SSE reconnect replay.
    ///
    /// Stores the last `max_buffer` messages per agent in a Redis
    /// list with a TTL. When an SSE client reconnects with
    /// `Last-Event-ID`, these buffered messages are replayed.
    ///
    /// # Errors
    ///
    /// Returns an error if the Redis connection fails.
    pub async fn buffer_message(
        &self,
        agent_id: &str,
        payload: &str,
        max_buffer: usize,
        ttl_secs: u64,
    ) -> Result<()> {
        let key = format!("signaldock:buffer:{agent_id}");
        let mut conn = self.client.get_multiplexed_async_connection().await?;

        // Push to list, trim to max, set TTL
        redis::pipe()
            .rpush(&key, payload)
            .ltrim(&key, -(max_buffer as isize), -1)
            .expire(&key, ttl_secs as i64)
            .exec_async(&mut conn)
            .await?;

        Ok(())
    }

    /// Retrieves buffered messages for SSE reconnect replay.
    ///
    /// Returns all messages buffered for the agent, up to the
    /// buffer limit.
    ///
    /// # Errors
    ///
    /// Returns an error if the Redis connection fails.
    pub async fn get_buffered_messages(&self, agent_id: &str) -> Result<Vec<String>> {
        let key = format!("signaldock:buffer:{agent_id}");
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        let messages: Vec<String> = conn.lrange(&key, 0, -1).await?;
        Ok(messages)
    }
}

#[async_trait]
impl TransportAdapter for RedisPubSubAdapter {
    fn name(&self) -> &'static str {
        "redis-pubsub"
    }

    fn supports_push(&self) -> bool {
        true
    }

    /// Redis pub/sub is always "connected" — subscribers listen
    /// independently. This returns `true` as a signal that the
    /// adapter can attempt delivery.
    async fn is_connected(&self, _agent_id: &str) -> bool {
        true
    }

    /// Publishes a delivery event to the agent's Redis channel.
    ///
    /// Also buffers the message for SSE reconnect replay (last
    /// 100 messages, 5-minute TTL).
    ///
    /// # Errors
    ///
    /// Returns `Ok(DeliveryResult)` with `success = false` if
    /// the Redis publish fails.
    async fn deliver(
        &self,
        event: &DeliveryEvent,
        target: &DeliveryTarget,
    ) -> Result<DeliveryResult> {
        let start = std::time::Instant::now();

        let payload = serde_json::json!({
            "messageId": event.message_id,
            "conversationId": event.conversation_id,
            "from": event.from_agent_id,
            "fromName": event.from_agent_name,
            "to": event.to_agent_id,
            "content": event.content,
            "contentType": event.content_type,
            "createdAt": event.created_at.to_rfc3339(),
            "attachments": event.attachments,
        });
        let payload_str = serde_json::to_string(&payload)?;

        match self.publish_raw(&target.agent_id, &payload_str).await {
            Ok(()) => {
                // Buffer for SSE reconnect replay
                if let Err(e) = self
                    .buffer_message(&target.agent_id, &payload_str, 100, 300)
                    .await
                {
                    warn!(agent_id = target.agent_id, error = %e, "Failed to buffer message");
                }

                Ok(DeliveryResult::success(
                    "redis-pubsub",
                    None,
                    start.elapsed().as_millis() as u64,
                ))
            }
            Err(e) => {
                warn!(agent_id = target.agent_id, error = %e, "Redis publish failed");
                Ok(DeliveryResult {
                    success: false,
                    transport: "redis-pubsub",
                    status_code: None,
                    response_time_ms: Some(start.elapsed().as_millis() as u64),
                    error: Some(e.to_string()),
                    permanent_failure: false,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_channel_naming() {
        assert_eq!(
            RedisPubSubAdapter::channel_for("my-agent"),
            "signaldock:agent:my-agent:messages"
        );
    }
}
