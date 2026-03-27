//! WebSocket transport adapter.
//!
//! Maintains an in-memory registry of connected agents via
//! `DashMap`. Uses unbounded MPSC channels for message
//! delivery: the Axum WebSocket handler reads from the
//! receiver and forwards frames to the actual tungstenite
//! stream.

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use dashmap::DashMap;
use signaldock_protocol::message::DeliveryEvent;
use tokio::sync::mpsc;

use crate::traits::{DeliveryResult, DeliveryTarget, TransportAdapter};

/// A single WebSocket client connection (server-side sender).
struct WsClient {
    sender: mpsc::UnboundedSender<String>,
}

/// WebSocket transport adapter.
///
/// Keeps an in-memory `DashMap` registry mapping agent IDs
/// to unbounded channel senders. The Axum WebSocket handler
/// manages the actual tungstenite stream and calls
/// [`connect`](Self::connect) / [`disconnect`](Self::disconnect).
/// This decoupling keeps the adapter testable without a real
/// WebSocket connection.
///
/// # Connection lifecycle
///
/// 1. [`connect`](Self::connect) registers the agent and
///    returns an [`mpsc::UnboundedReceiver<String>`]. The WS
///    pump task reads from this receiver to send frames.
/// 2. [`deliver`](WebSocketAdapter::deliver) serializes the
///    event as JSON and pushes it through the channel.
/// 3. If the channel send fails (receiver dropped), the
///    stale entry is automatically removed from the registry.
/// 4. [`disconnect`](Self::disconnect) explicitly removes
///    the agent on WS close.
#[derive(Clone)]
pub struct WebSocketAdapter {
    clients: Arc<DashMap<String, WsClient>>,
}

impl WebSocketAdapter {
    /// Creates a new WebSocket adapter with an empty client
    /// registry.
    pub fn new() -> Self {
        Self {
            clients: Arc::new(DashMap::new()),
        }
    }

    /// Registers a new WebSocket connection for an agent.
    ///
    /// Returns an [`mpsc::UnboundedReceiver<String>`] that
    /// the WS pump task reads from to send frames to the
    /// client.
    pub fn connect(&self, agent_id: String) -> mpsc::UnboundedReceiver<String> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.clients.insert(agent_id, WsClient { sender: tx });
        rx
    }

    /// Disconnects an agent, removing it from the registry.
    ///
    /// Called when the WebSocket connection closes.
    pub fn disconnect(&self, agent_id: &str) {
        self.clients.remove(agent_id);
    }

    /// Returns the number of currently connected clients.
    pub fn connected_count(&self) -> usize {
        self.clients.len()
    }

    /// Returns a list of all connected agent IDs.
    pub fn connected_agents(&self) -> Vec<String> {
        self.clients.iter().map(|e| e.key().clone()).collect()
    }
}

impl Default for WebSocketAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl TransportAdapter for WebSocketAdapter {
    fn name(&self) -> &'static str {
        "websocket"
    }

    fn supports_push(&self) -> bool {
        true
    }

    /// Checks whether the agent has an active WebSocket
    /// connection by looking up the `DashMap` registry.
    async fn is_connected(&self, agent_id: &str) -> bool {
        self.clients.contains_key(agent_id)
    }

    /// Delivers an event as a JSON frame to a connected
    /// agent.
    ///
    /// Serializes the [`DeliveryEvent`] as JSON and pushes
    /// it through the agent's unbounded channel. If the send
    /// fails (receiver dropped), the stale registry entry is
    /// automatically cleaned up.
    ///
    /// # Errors
    ///
    /// This method does not return `Err`. Delivery failures
    /// (agent not connected, stale channel) are returned as
    /// `Ok(DeliveryResult)` with `success = false`.
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

        if let Some(client) = self.clients.get(&target.agent_id) {
            if client.sender.send(payload).is_ok() {
                return Ok(DeliveryResult::success(
                    "websocket",
                    None,
                    start.elapsed().as_millis() as u64,
                ));
            }
            // Channel closed -- remove stale entry
            drop(client);
            self.clients.remove(&target.agent_id);
        }

        Ok(DeliveryResult::not_connected("websocket"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use signaldock_protocol::message::{ContentType, DeliveryEvent};
    use uuid::Uuid;

    fn make_event(to: &str) -> DeliveryEvent {
        DeliveryEvent {
            message_id: Uuid::new_v4(),
            conversation_id: Uuid::new_v4(),
            from_agent_id: "sender".into(),
            from_agent_name: "Sender".into(),
            to_agent_id: to.into(),
            content: "hello".into(),
            content_type: ContentType::Text,
            created_at: chrono::Utc::now(),
            attachments: vec![],
        }
    }

    #[tokio::test]
    async fn test_connect_disconnect() {
        let adapter = WebSocketAdapter::new();
        assert!(!adapter.is_connected("a").await);
        let _rx = adapter.connect("a".into());
        assert!(adapter.is_connected("a").await);
        adapter.disconnect("a");
        assert!(!adapter.is_connected("a").await);
    }

    #[tokio::test]
    async fn test_deliver_connected() {
        let adapter = WebSocketAdapter::new();
        let mut rx = adapter.connect("a".into());
        let event = make_event("a");
        let target = DeliveryTarget {
            agent_id: "a".into(),
            endpoint: None,
            webhook_secret: None,
        };
        let result = adapter.deliver(&event, &target).await.unwrap();
        assert!(result.success);
        let msg = rx.try_recv().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["event"], "message");
    }

    #[tokio::test]
    async fn test_deliver_not_connected() {
        let adapter = WebSocketAdapter::new();
        let event = make_event("nobody");
        let target = DeliveryTarget {
            agent_id: "nobody".into(),
            endpoint: None,
            webhook_secret: None,
        };
        let result = adapter.deliver(&event, &target).await.unwrap();
        assert!(!result.success);
        assert!(!result.permanent_failure);
    }
}
