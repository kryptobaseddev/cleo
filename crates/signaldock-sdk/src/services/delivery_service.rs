//! Message delivery orchestration service.
//!
//! Implements a priority-based delivery chain:
//!
//! 1. **SSE** -- if the recipient has an active SSE connection,
//!    the event is pushed immediately.
//! 2. **Webhook** -- if an endpoint is configured, delivery is
//!    attempted with exponential-backoff retries (up to 6
//!    attempts via `RetryPolicy`).
//! 3. **Polling** -- if neither SSE nor webhook is available,
//!    the message remains in the store for the agent to poll.
//! 4. **Dead letter** -- webhook failures that exhaust all
//!    retries or encounter a permanent error are marked as
//!    dead-lettered with a reason string.
//!
//! Agent stats (`messages_sent` / `messages_received`) are only
//! incremented on successful SSE or webhook delivery.
//!
//! # Design
//!
//! Priority chain and retry semantics defined in
//! [ADR-001: Transport Protocol](../../../docs/dev/adr/001-transport-protocol.md)
//! and [Spec: Message Delivery Guarantees](../../../docs/dev/specs/message-delivery-guarantees.md).

use std::sync::Arc;

use anyhow::Result;
use signaldock_protocol::message::DeliveryEvent;
use signaldock_storage::{traits::AgentRepository, types::StatsDelta};
use signaldock_transport::{
    adapters::sse::SseAdapter,
    adapters::webhook::WebhookAdapter,
    traits::{DeliveryTarget, RetryPolicy, TransportAdapter},
};
use tracing::{info, warn};

/// Outcome of a delivery attempt through the orchestrator.
#[derive(Debug, Clone)]
pub enum DeliveryOutcome {
    /// Delivered via server-sent events.
    Sse,
    /// Delivered via webhook after the given number of attempts.
    Webhook {
        /// Number of HTTP attempts made (1 = first try succeeded).
        attempts: u32,
    },
    /// No active transport; message awaits agent polling.
    Polling,
    /// Delivery permanently failed.
    DeadLetter {
        /// Human-readable reason for the failure.
        reason: String,
    },
}

/// Orchestrates message delivery through the SSE, webhook, and
/// polling priority chain.
///
/// See the [module-level documentation](self) for the full
/// delivery algorithm.
pub struct DeliveryOrchestrator<R> {
    repo: Arc<R>,
    sse: Arc<SseAdapter>,
    webhook: Arc<WebhookAdapter>,
}

impl<R: AgentRepository + Send + Sync> DeliveryOrchestrator<R> {
    /// Creates a new `DeliveryOrchestrator` with the given
    /// repository, SSE adapter, and webhook adapter.
    pub fn new(repo: Arc<R>, sse: Arc<SseAdapter>, webhook: Arc<WebhookAdapter>) -> Self {
        Self { repo, sse, webhook }
    }

    /// Delivers a message event to the target agent.
    ///
    /// Tries SSE first, then webhook with exponential-backoff
    /// retries, then falls back to polling. Stats are only
    /// incremented on [`DeliveryOutcome::Sse`] or
    /// [`DeliveryOutcome::Webhook`] success.
    ///
    /// # Errors
    ///
    /// Returns an error if the SSE or webhook adapter returns
    /// an unrecoverable transport-level error (distinct from a
    /// delivery failure, which yields
    /// [`DeliveryOutcome::DeadLetter`]).
    pub async fn deliver(
        &self,
        event: &DeliveryEvent,
        target: &DeliveryTarget,
    ) -> Result<DeliveryOutcome> {
        // 1. Try SSE first
        if let Some(outcome) = self.try_sse(event, target).await? {
            self.update_stats(event).await;
            return Ok(outcome);
        }

        // 2. Try webhook with retries
        if target.endpoint.is_some() {
            let outcome = self.try_webhook(event, target).await?;
            if let DeliveryOutcome::Webhook { .. } = &outcome {
                self.update_stats(event).await;
            }
            return Ok(outcome);
        }

        // 3. Polling fallback — no SSE, no endpoint
        info!(
            agent_id = %target.agent_id,
            "no active transport, falling back to polling"
        );
        Ok(DeliveryOutcome::Polling)
    }

    async fn try_sse(
        &self,
        event: &DeliveryEvent,
        target: &DeliveryTarget,
    ) -> Result<Option<DeliveryOutcome>> {
        if !self.sse.is_connected(&target.agent_id).await {
            return Ok(None);
        }
        match self.sse.deliver(event, target).await {
            Ok(result) if result.success => {
                info!(
                    agent_id = %target.agent_id,
                    "delivered via SSE"
                );
                Ok(Some(DeliveryOutcome::Sse))
            }
            _ => {
                warn!(
                    agent_id = %target.agent_id,
                    "SSE delivery failed, falling through"
                );
                Ok(None)
            }
        }
    }

    async fn try_webhook(
        &self,
        event: &DeliveryEvent,
        target: &DeliveryTarget,
    ) -> Result<DeliveryOutcome> {
        let policy = RetryPolicy::default();
        for attempt in 1..=policy.max_attempts {
            match self.webhook.deliver(event, target).await {
                Ok(result) if result.success => {
                    info!(
                        agent_id = %target.agent_id,
                        attempt,
                        "delivered via webhook"
                    );
                    return Ok(DeliveryOutcome::Webhook { attempts: attempt });
                }
                Ok(result) if result.permanent_failure => {
                    let reason = result.error.unwrap_or_else(|| "permanent failure".into());
                    warn!(
                        agent_id = %target.agent_id,
                        %reason,
                        "webhook permanent failure"
                    );
                    return Ok(DeliveryOutcome::DeadLetter { reason });
                }
                Ok(_) | Err(_) => {
                    if attempt < policy.max_attempts {
                        let delay = policy.delay_for_attempt(attempt);
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }
        warn!(
            agent_id = %target.agent_id,
            "all webhook retries exhausted"
        );
        Ok(DeliveryOutcome::DeadLetter {
            reason: "max retries exceeded".into(),
        })
    }

    async fn update_stats(&self, event: &DeliveryEvent) {
        let from = self.repo.find_by_agent_id(&event.from_agent_id).await;
        let to = self.repo.find_by_agent_id(&event.to_agent_id).await;
        if let Ok(Some(agent)) = from {
            let _ = self
                .repo
                .increment_stats(agent.id, StatsDelta::sent())
                .await;
        }
        if let Ok(Some(agent)) = to {
            let _ = self
                .repo
                .increment_stats(agent.id, StatsDelta::received())
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::MockStore;
    use chrono::Utc;
    use signaldock_protocol::{
        agent::NewAgent,
        message::{ContentType, DeliveryEvent},
    };
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

    fn make_target(agent_id: &str, endpoint: Option<&str>) -> DeliveryTarget {
        DeliveryTarget {
            agent_id: agent_id.into(),
            endpoint: endpoint.map(String::from),
            webhook_secret: None,
        }
    }

    fn new_agent(agent_id: &str) -> NewAgent {
        NewAgent {
            agent_id: agent_id.into(),
            name: agent_id.into(),
            description: None,
            class: signaldock_protocol::agent::AgentClass::Custom,
            privacy_tier: signaldock_protocol::agent::PrivacyTier::Public,
            endpoint: None,
            capabilities: vec![],
            skills: vec![],
            avatar: None,
            payment_config: None,
            webhook_secret: None,
        }
    }

    #[tokio::test]
    async fn test_sse_delivery_success() {
        let store = Arc::new(MockStore::new());
        store.create(new_agent("sender")).await.unwrap();
        store.create(new_agent("receiver")).await.unwrap();

        let sse = Arc::new(SseAdapter::new());
        let _rx = sse.connect("receiver".into());
        let webhook = Arc::new(WebhookAdapter::new());

        let orch = DeliveryOrchestrator::new(store.clone(), sse, webhook);

        let event = make_event();
        let target = make_target("receiver", None);
        let outcome = orch.deliver(&event, &target).await.unwrap();

        assert!(matches!(outcome, DeliveryOutcome::Sse));

        let sender = store.find_by_agent_id("sender").await.unwrap().unwrap();
        assert_eq!(sender.stats.messages_sent, 1);

        let receiver = store.find_by_agent_id("receiver").await.unwrap().unwrap();
        assert_eq!(receiver.stats.messages_received, 1);
    }

    #[tokio::test]
    async fn test_polling_fallback() {
        let store = Arc::new(MockStore::new());
        let sse = Arc::new(SseAdapter::new());
        let webhook = Arc::new(WebhookAdapter::new());

        let orch = DeliveryOrchestrator::new(store, sse, webhook);

        let event = make_event();
        let target = make_target("receiver", None);
        let outcome = orch.deliver(&event, &target).await.unwrap();

        assert!(matches!(outcome, DeliveryOutcome::Polling));
    }

    #[tokio::test]
    async fn test_webhook_no_endpoint_dead_letter() {
        let store = Arc::new(MockStore::new());
        let sse = Arc::new(SseAdapter::new());
        let webhook = Arc::new(WebhookAdapter::new());

        let orch = DeliveryOrchestrator::new(store, sse, webhook);

        let event = make_event();
        // Endpoint is set (triggering webhook path) but invalid
        // -> WebhookAdapter returns permanent_failure for None endpoint
        // Actually, we pass Some("") which is an invalid URL
        let target = make_target("receiver", Some("not-a-url"));
        let outcome = orch.deliver(&event, &target).await.unwrap();

        assert!(
            matches!(outcome, DeliveryOutcome::DeadLetter { ref reason }
                if reason.contains("invalid endpoint URL")
                    || reason.contains("permanent failure")
            ),
            "expected DeadLetter, got {outcome:?}"
        );
    }
}
