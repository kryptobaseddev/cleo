//! Server-Sent Events (SSE) transport adapter.
//!
//! Maintains an in-memory registry of connected agents via
//! `DashMap`. Each agent gets an unbounded channel; the
//! Axum SSE handler reads from the receiver and streams
//! events to the HTTP client.
//!
//! When the `redis-pubsub` feature is enabled, each SSE
//! connection also subscribes to a per-agent Redis channel
//! for cross-instance fan-out.

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use dashmap::DashMap;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use signaldock_protocol::message::DeliveryEvent;

use crate::traits::{DeliveryResult, DeliveryTarget, TransportAdapter};

/// A single SSE client connection.
struct SseClient {
    sender: mpsc::UnboundedSender<String>,
    /// Handle to the Redis subscription task (if Redis is enabled).
    /// Dropped on disconnect to cancel the subscription.
    #[allow(dead_code)]
    redis_task: Option<JoinHandle<()>>,
}

/// SSE transport adapter.
///
/// Keeps an in-memory `DashMap` registry mapping agent IDs
/// to unbounded channel senders. When a message is delivered,
/// the adapter serializes it as an SSE frame and sends it
/// through the channel. The Axum handler pumps the
/// corresponding receiver into the HTTP response stream.
///
/// When the `redis-pubsub` feature is enabled and a Redis
/// client is provided via [`with_redis`](Self::with_redis),
/// each SSE connection also subscribes to the agent's Redis
/// channel for cross-instance event delivery.
///
/// # Connection lifecycle
///
/// 1. [`connect`](Self::connect) registers the agent and
///    returns an [`mpsc::UnboundedReceiver<String>`]. The
///    HTTP handler streams this receiver to the client.
/// 2. [`deliver`](SseAdapter::deliver) formats the event as
///    an SSE frame (`id: / event: / data:`) and pushes it
///    through the channel.
/// 3. [`disconnect`](Self::disconnect) removes the agent
///    from the registry (also happens automatically if the
///    channel closes).
#[derive(Clone)]
pub struct SseAdapter {
    clients: Arc<DashMap<String, SseClient>>,
    #[cfg(feature = "redis-pubsub")]
    redis_client: Option<redis::Client>,
}

impl SseAdapter {
    /// Creates a new SSE adapter with an empty client
    /// registry and no Redis backing.
    pub fn new() -> Self {
        Self {
            clients: Arc::new(DashMap::new()),
            #[cfg(feature = "redis-pubsub")]
            redis_client: None,
        }
    }

    /// Creates a new SSE adapter with Redis pub/sub backing.
    ///
    /// When Redis is configured, SSE connections subscribe to
    /// per-agent Redis channels for cross-instance event delivery.
    #[cfg(feature = "redis-pubsub")]
    pub fn with_redis(redis_client: redis::Client) -> Self {
        Self {
            clients: Arc::new(DashMap::new()),
            redis_client: Some(redis_client),
        }
    }

    /// Registers a new SSE connection for an agent.
    ///
    /// Returns an [`mpsc::UnboundedReceiver<String>`] that
    /// the HTTP handler streams to the client. The connection
    /// is cleaned up when the receiver is dropped or
    /// [`disconnect`](Self::disconnect) is called.
    ///
    /// If Redis is configured, a background task subscribes
    /// to the agent's Redis channel and forwards events to
    /// the local SSE stream.
    pub fn connect(&self, agent_id: String) -> mpsc::UnboundedReceiver<String> {
        let (tx, rx) = mpsc::unbounded_channel();

        let redis_task = self.spawn_redis_subscriber(&agent_id, &tx);

        self.clients.insert(
            agent_id,
            SseClient {
                sender: tx,
                redis_task,
            },
        );
        rx
    }

    /// Spawns a Redis subscription task if Redis is configured.
    #[cfg(feature = "redis-pubsub")]
    fn spawn_redis_subscriber(
        &self,
        agent_id: &str,
        sender: &mpsc::UnboundedSender<String>,
    ) -> Option<JoinHandle<()>> {
        use futures::StreamExt as _;

        let client = self.redis_client.as_ref()?.clone();
        let sender = sender.clone();
        let channel = format!("signaldock:agent:{agent_id}:messages");
        let aid = agent_id.to_string();

        Some(tokio::spawn(async move {
            let pubsub_result = async {
                let mut pubsub = client.get_async_pubsub().await?;
                pubsub.subscribe(&channel).await?;
                tracing::debug!(channel = channel.as_str(), "Redis subscription started");

                loop {
                    let msg: redis::Msg = pubsub
                        .on_message()
                        .next()
                        .await
                        .ok_or_else(|| anyhow::anyhow!("Redis stream ended"))?;
                    let payload: String = msg.get_payload()?;
                    let sse_frame = format!("event: message\ndata: {payload}\n\n");
                    if sender.send(sse_frame).is_err() {
                        break;
                    }
                }
                Ok::<(), anyhow::Error>(())
            }
            .await;

            if let Err(e) = pubsub_result {
                tracing::warn!(
                    agent_id = aid.as_str(),
                    error = %e,
                    "Redis subscription ended"
                );
            }
        }))
    }

    /// No-op when Redis feature is disabled.
    #[cfg(not(feature = "redis-pubsub"))]
    fn spawn_redis_subscriber(
        &self,
        _agent_id: &str,
        _sender: &mpsc::UnboundedSender<String>,
    ) -> Option<JoinHandle<()>> {
        None
    }

    /// Disconnects an agent, removing it from the registry.
    ///
    /// Typically called when the SSE HTTP connection closes.
    /// Also cancels the Redis subscription task if running.
    pub fn disconnect(&self, agent_id: &str) {
        if let Some((
            _,
            SseClient {
                redis_task: Some(task),
                ..
            },
        )) = self.clients.remove(agent_id)
        {
            task.abort();
        }
    }

    /// Returns the number of currently connected clients.
    pub fn connected_count(&self) -> usize {
        self.clients.len()
    }

    /// Returns a list of all connected agent IDs.
    pub fn connected_agents(&self) -> Vec<String> {
        self.clients.iter().map(|e| e.key().clone()).collect()
    }

    /// Sends a raw SSE-formatted string to an agent.
    ///
    /// Returns `false` if the agent is not connected or the
    /// send fails (stale channel). Automatically cleans up
    /// stale entries on failed send.
    fn send_raw(&self, agent_id: &str, data: &str) -> bool {
        if let Some(client) = self.clients.get(agent_id) {
            if client.sender.send(data.to_string()).is_ok() {
                return true;
            }
            // Channel closed — clean up
            drop(client);
            self.disconnect(agent_id);
        }
        false
    }

    /// Sends a heartbeat SSE event to the specified agent.
    ///
    /// Returns `true` if the heartbeat was delivered, `false`
    /// if the agent is not connected.
    pub fn send_heartbeat(&self, agent_id: &str) -> bool {
        let ts = chrono::Utc::now().to_rfc3339();
        let data = format!(
            "event: heartbeat\ndata: \
             {{\"timestamp\":\"{ts}\"}}\n\n"
        );
        self.send_raw(agent_id, &data)
    }

    /// Replays missed messages as SSE events on reconnect.
    ///
    /// Called when a client reconnects with a `Last-Event-Id`
    /// header. Sends up to 100 messages from the provided
    /// slice.
    pub fn replay_messages(
        &self,
        agent_id: &str,
        messages: &[signaldock_protocol::message::Message],
    ) {
        for msg in messages.iter().take(100) {
            let payload = serde_json::json!({
                "messageId": msg.id,
                "conversationId": msg.conversation_id,
                "from": msg.from_agent_id,
                "content": msg.content,
                "contentType": msg.content_type,
                "createdAt": msg.created_at.to_rfc3339(),
                "attachments": msg.attachments,
            });
            let data = format!("id: {}\nevent: message\ndata: {}\n\n", msg.id, payload);
            self.send_raw(agent_id, &data);
        }
    }
}

impl Default for SseAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl TransportAdapter for SseAdapter {
    fn name(&self) -> &'static str {
        "sse"
    }

    fn supports_push(&self) -> bool {
        true
    }

    /// Checks whether the agent has an active SSE connection
    /// by looking up the `DashMap` registry.
    async fn is_connected(&self, agent_id: &str) -> bool {
        self.clients.contains_key(agent_id)
    }

    /// Delivers an event as an SSE frame to a connected agent.
    ///
    /// Serializes the [`DeliveryEvent`] as a JSON SSE frame
    /// with `id:`, `event: message`, and `data:` fields, then
    /// pushes it through the agent's channel.
    ///
    /// # Errors
    ///
    /// This method does not return `Err`. Delivery failures
    /// (agent not connected) are returned as
    /// `Ok(DeliveryResult)` with `success = false`.
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
            "content": event.content,
            "contentType": event.content_type,
            "createdAt": event.created_at.to_rfc3339(),
            "attachments": event.attachments,
        });

        let data = format!(
            "id: {}\nevent: message\ndata: {}\n\n",
            event.message_id, payload
        );

        if self.send_raw(&target.agent_id, &data) {
            Ok(DeliveryResult::success(
                "sse",
                None,
                start.elapsed().as_millis() as u64,
            ))
        } else {
            Ok(DeliveryResult::not_connected("sse"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use signaldock_protocol::message::ContentType;
    use uuid::Uuid;

    fn make_event() -> DeliveryEvent {
        DeliveryEvent {
            message_id: Uuid::new_v4(),
            conversation_id: Uuid::new_v4(),
            from_agent_id: "sender".into(),
            from_agent_name: "Sender".into(),
            to_agent_id: "receiver".into(),
            content: "Hello!".into(),
            content_type: ContentType::Text,
            created_at: Utc::now(),
            attachments: vec![],
        }
    }

    #[tokio::test]
    async fn test_connect_and_is_connected() {
        let adapter = SseAdapter::new();
        assert!(!adapter.is_connected("agent1").await);
        let _rx = adapter.connect("agent1".into());
        assert!(adapter.is_connected("agent1").await);
        adapter.disconnect("agent1");
        assert!(!adapter.is_connected("agent1").await);
    }

    #[tokio::test]
    async fn test_deliver_to_connected_agent() {
        let adapter = SseAdapter::new();
        let mut rx = adapter.connect("agent1".into());
        let event = make_event();
        let target = DeliveryTarget {
            agent_id: "agent1".into(),
            endpoint: None,
            webhook_secret: None,
        };
        let result = adapter.deliver(&event, &target).await.unwrap();
        assert!(result.success);
        // Verify we received the SSE data
        let msg = rx.try_recv().unwrap();
        assert!(msg.contains("event: message"));
    }

    #[tokio::test]
    async fn test_deliver_to_disconnected_returns_not_connected() {
        let adapter = SseAdapter::new();
        let event = make_event();
        let target = DeliveryTarget {
            agent_id: "not-connected".into(),
            endpoint: None,
            webhook_secret: None,
        };
        let result = adapter.deliver(&event, &target).await.unwrap();
        assert!(!result.success);
        assert!(!result.permanent_failure);
    }
}
