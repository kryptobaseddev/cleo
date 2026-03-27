//! HTTP/2 server-push transport adapter.
//!
//! Maintains an in-memory registry of active HTTP/2
//! connections. Delivers events as [`bytes::Bytes`] frames
//! through unbounded channels. Falls back gracefully
//! (returns not-connected) when no H2 connection exists,
//! allowing the [`DeliveryChain`](crate::traits::DeliveryChain)
//! to try the next adapter.

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use dashmap::DashMap;
use tokio::sync::mpsc;

use signaldock_protocol::message::DeliveryEvent;

use crate::traits::{DeliveryResult, DeliveryTarget, TransportAdapter};

/// Represents an active HTTP/2 connection's push channel.
struct Http2Client {
    sender: mpsc::UnboundedSender<bytes::Bytes>,
}

/// HTTP/2 server-push transport adapter.
///
/// Maintains a `DashMap` registry of active H2 connections
/// per agent. Delivers events as serialized JSON
/// [`bytes::Bytes`] frames through unbounded channels. The
/// connection handler reads from the receiver and sends
/// HTTP/2 DATA frames to the client.
///
/// # Connection lifecycle
///
/// 1. [`connect`](Self::connect) registers the agent and
///    returns an [`mpsc::UnboundedReceiver<bytes::Bytes>`].
///    The H2 connection handler pumps this receiver into
///    DATA frames.
/// 2. [`deliver`](Http2Adapter::deliver) serializes the
///    event as JSON, wraps it in [`bytes::Bytes`], and
///    pushes it through the channel.
/// 3. If the channel send fails (receiver dropped), the
///    stale entry is automatically cleaned up.
/// 4. [`disconnect`](Self::disconnect) explicitly removes
///    the agent from the registry.
#[derive(Clone)]
pub struct Http2Adapter {
    clients: Arc<DashMap<String, Http2Client>>,
}

impl Http2Adapter {
    /// Creates a new HTTP/2 adapter with an empty client
    /// registry.
    pub fn new() -> Self {
        Self {
            clients: Arc::new(DashMap::new()),
        }
    }

    /// Registers an HTTP/2 connection for an agent.
    ///
    /// Returns an [`mpsc::UnboundedReceiver<bytes::Bytes>`]
    /// that the connection handler pumps to send DATA frames
    /// to the client.
    pub fn connect(&self, agent_id: String) -> mpsc::UnboundedReceiver<bytes::Bytes> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.clients.insert(agent_id, Http2Client { sender: tx });
        rx
    }

    /// Disconnects an agent, removing it from the registry.
    pub fn disconnect(&self, agent_id: &str) {
        self.clients.remove(agent_id);
    }

    /// Returns the number of currently connected clients.
    pub fn connected_count(&self) -> usize {
        self.clients.len()
    }
}

impl Default for Http2Adapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl TransportAdapter for Http2Adapter {
    fn name(&self) -> &'static str {
        "http2"
    }

    fn supports_push(&self) -> bool {
        true
    }

    /// Checks whether the agent has an active HTTP/2
    /// connection by looking up the `DashMap` registry.
    async fn is_connected(&self, agent_id: &str) -> bool {
        self.clients.contains_key(agent_id)
    }

    /// Delivers an event as a [`bytes::Bytes`] frame to a
    /// connected agent.
    ///
    /// Serializes the [`DeliveryEvent`] as JSON, wraps it
    /// in [`bytes::Bytes`], and pushes it through the
    /// agent's channel. If the send fails (receiver dropped),
    /// the stale registry entry is cleaned up automatically.
    ///
    /// When no H2 connection exists, returns
    /// `Ok(DeliveryResult::not_connected("http2"))` so the
    /// [`DeliveryChain`](crate::traits::DeliveryChain) can
    /// fall through to the next adapter.
    ///
    /// # Errors
    ///
    /// This method does not return `Err`. Delivery failures
    /// are returned as `Ok(DeliveryResult)` with
    /// `success = false`.
    async fn deliver(
        &self,
        event: &DeliveryEvent,
        target: &DeliveryTarget,
    ) -> Result<DeliveryResult> {
        let start = std::time::Instant::now();

        let payload = serde_json::json!({
            "event": "message",
            "data": {
                "messageId": event.message_id,
                "conversationId": event.conversation_id,
                "from": event.from_agent_id,
                "content": event.content,
                "contentType": event.content_type,
                "createdAt": event.created_at.to_rfc3339(),
            }
        })
        .to_string();

        let frame = bytes::Bytes::from(payload);

        if let Some(client) = self.clients.get(&target.agent_id) {
            if client.sender.send(frame).is_ok() {
                return Ok(DeliveryResult::success(
                    "http2",
                    None,
                    start.elapsed().as_millis() as u64,
                ));
            }
            // Sender failed — receiver dropped, clean up
            drop(client);
            self.clients.remove(&target.agent_id);
        }

        // No H2 connection — fall through to next adapter
        Ok(DeliveryResult::not_connected("http2"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use signaldock_protocol::message::{ContentType, DeliveryEvent};
    use uuid::Uuid;

    fn make_event() -> DeliveryEvent {
        DeliveryEvent {
            message_id: Uuid::new_v4(),
            conversation_id: Uuid::new_v4(),
            from_agent_id: "s".into(),
            from_agent_name: "S".into(),
            to_agent_id: "r".into(),
            content: "hi".into(),
            content_type: ContentType::Text,
            created_at: chrono::Utc::now(),
            attachments: vec![],
        }
    }

    #[tokio::test]
    async fn test_connect_and_deliver() {
        let adapter = Http2Adapter::new();
        let mut rx = adapter.connect("agent1".into());
        let event = make_event();
        let target = DeliveryTarget {
            agent_id: "agent1".into(),
            endpoint: None,
            webhook_secret: None,
        };
        let result = adapter.deliver(&event, &target).await.unwrap();
        assert!(result.success);
        let frame = rx.try_recv().unwrap();
        let json: serde_json::Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(json["event"], "message");
    }

    #[tokio::test]
    async fn test_not_connected_falls_through() {
        let adapter = Http2Adapter::new();
        let event = make_event();
        let target = DeliveryTarget {
            agent_id: "nobody".into(),
            endpoint: None,
            webhook_secret: None,
        };
        let result = adapter.deliver(&event, &target).await.unwrap();
        assert!(!result.success);
        assert!(!result.permanent_failure);
    }

    #[tokio::test]
    async fn test_disconnect_cleans_up() {
        let adapter = Http2Adapter::new();
        let _rx = adapter.connect("a".into());
        assert!(adapter.is_connected("a").await);
        adapter.disconnect("a");
        assert!(!adapter.is_connected("a").await);
    }
}
