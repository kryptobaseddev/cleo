//! Webhook transport adapter.
//!
//! Delivers events via signed HTTP POST requests. Uses
//! HMAC-SHA256 for payload signing with a timestamp-based
//! freshness check (default 300 s window).

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use async_trait::async_trait;
use hmac::{Hmac, Mac};
use reqwest::Client;
use sha2::Sha256;
use signaldock_protocol::message::DeliveryEvent;

use crate::traits::{DeliveryResult, DeliveryTarget, TransportAdapter};

type HmacSha256 = Hmac<Sha256>;

/// Webhook transport adapter.
///
/// Sends [`DeliveryEvent`]s as signed HTTP POST requests to
/// agent-configured endpoints. Each request includes:
///
/// - `X-SignalDock-Signature` — HMAC-SHA256 signature
/// - `X-SignalDock-Timestamp` — Unix epoch seconds
/// - `X-SignalDock-Delivery-Id` — unique delivery identifier
///
/// # Delivery semantics
///
/// - **No endpoint configured** — permanent failure
///   (no retry).
/// - **4xx response** — permanent failure (client error).
/// - **5xx response** — transient error returned as `Err`,
///   eligible for retry via `RetryPolicy`.
/// - **Timeout** — transient `Err` after 30 s.
///
/// # HTTPS enforcement
///
/// In production (`SIGNALDOCK_ENV=production`), only HTTPS
/// endpoints are accepted. HTTP endpoints cause a permanent
/// failure.
pub struct WebhookAdapter {
    /// HTTP client with 30 s timeout.
    client: Client,
    /// Whether HTTPS is enforced.
    is_production: bool,
}

impl WebhookAdapter {
    /// Creates a new webhook adapter.
    ///
    /// Builds a [`reqwest::Client`] with a 30 s timeout and
    /// a `SignalDock-Webhook/1.0` user-agent. Reads
    /// `SIGNALDOCK_ENV` to determine HTTPS enforcement.
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("SignalDock-Webhook/1.0")
            .build()
            .unwrap_or_else(|_| Client::new());
        let is_production = std::env::var("SIGNALDOCK_ENV").as_deref() == Ok("production");
        Self {
            client,
            is_production,
        }
    }

    /// Generates an HMAC-SHA256 signature for a payload.
    ///
    /// The signature covers `{payload}{timestamp}` and is
    /// returned as `sha256={hex_digest}`.
    pub fn generate_signature(payload: &str, secret: &str, timestamp: u64) -> String {
        let data = format!("{payload}{timestamp}");
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
            .unwrap_or_else(|e| unreachable!("HMAC accepts any key size: {e}"));
        mac.update(data.as_bytes());
        format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
    }

    /// Verifies a webhook signature.
    ///
    /// Returns `false` if the timestamp is stale (older than
    /// `max_age_secs` from the current time) or if the
    /// signature does not match the expected HMAC. Uses
    /// constant-time comparison to prevent timing attacks.
    pub fn verify_signature(
        payload: &str,
        signature: &str,
        secret: &str,
        timestamp: u64,
        max_age_secs: u64,
    ) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if now.abs_diff(timestamp) > max_age_secs {
            return false;
        }
        let expected = Self::generate_signature(payload, secret, timestamp);
        // Constant-time comparison
        expected.len() == signature.len()
            && expected.bytes().zip(signature.bytes()).all(|(a, b)| a == b)
    }

    /// Validates the target endpoint URL.
    ///
    /// Returns `Err(DeliveryResult)` with a permanent failure
    /// if the endpoint is missing, unparseable, or uses HTTP
    /// in production mode.
    fn validate_endpoint(
        &self,
        target: &DeliveryTarget,
    ) -> std::result::Result<String, DeliveryResult> {
        let endpoint = match &target.endpoint {
            Some(ep) => ep.clone(),
            None => {
                return Err(DeliveryResult::failure(
                    "webhook",
                    "no endpoint configured".into(),
                    true,
                ));
            }
        };
        let url = match reqwest::Url::parse(&endpoint) {
            Ok(u) => u,
            Err(e) => {
                return Err(DeliveryResult::failure(
                    "webhook",
                    format!("invalid endpoint URL: {e}"),
                    true,
                ));
            }
        };
        if self.is_production && url.scheme() != "https" {
            return Err(DeliveryResult::failure(
                "webhook",
                "HTTPS required in production".into(),
                true,
            ));
        }
        Ok(endpoint)
    }

    /// Builds the JSON payload for a delivery event.
    fn build_payload(event: &DeliveryEvent) -> String {
        serde_json::json!({
            "event": "message.received",
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "data": {
                "messageId": event.message_id,
                "conversationId": event.conversation_id,
                "from": {
                    "agentId": event.from_agent_id,
                    "name": event.from_agent_name,
                },
                "content": event.content,
                "contentType": event.content_type,
                "createdAt": event.created_at.to_rfc3339(),
                "attachments": event.attachments,
            }
        })
        .to_string()
    }

    /// Interprets an HTTP status into a [`DeliveryResult`].
    ///
    /// - 2xx -> success
    /// - 4xx -> permanent failure (no retry)
    /// - 5xx -> transient `Err` (eligible for retry)
    ///
    /// # Errors
    ///
    /// Returns `Err` for 5xx server errors to signal the
    /// caller that a retry may succeed.
    fn interpret_response(status: u16, is_success: bool, elapsed: u64) -> Result<DeliveryResult> {
        if is_success {
            Ok(DeliveryResult::success("webhook", Some(status), elapsed))
        } else if (400..500).contains(&status) {
            Ok(DeliveryResult {
                success: false,
                transport: "webhook",
                status_code: Some(status),
                response_time_ms: Some(elapsed),
                error: Some(format!("client error: {status}")),
                permanent_failure: true,
            })
        } else {
            Err(anyhow::anyhow!("server error: {status}"))
        }
    }
}

impl Default for WebhookAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl TransportAdapter for WebhookAdapter {
    fn name(&self) -> &'static str {
        "webhook"
    }

    fn supports_push(&self) -> bool {
        true
    }

    /// Always returns `true` because webhook delivery does
    /// not require a persistent connection. Endpoint validity
    /// is checked inside [`deliver`](Self::deliver).
    async fn is_connected(&self, _agent_id: &str) -> bool {
        true
    }

    /// Delivers an event via signed HTTP POST.
    ///
    /// Validates the endpoint, builds the JSON payload,
    /// signs it with HMAC-SHA256 (if a webhook secret is
    /// configured), and sends the POST request.
    ///
    /// # Errors
    ///
    /// Returns `Err` for network failures, timeouts, and
    /// 5xx server errors (transient, retryable). Permanent
    /// failures (missing endpoint, 4xx) are returned as
    /// `Ok(DeliveryResult)` with `permanent_failure = true`.
    async fn deliver(
        &self,
        event: &DeliveryEvent,
        target: &DeliveryTarget,
    ) -> Result<DeliveryResult> {
        let endpoint = match self.validate_endpoint(target) {
            Ok(ep) => ep,
            Err(result) => return Ok(result),
        };

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let payload_str = Self::build_payload(event);

        let mut req = self
            .client
            .post(&endpoint)
            .header("Content-Type", "application/json")
            .header(
                "X-SignalDock-Delivery-Id",
                format!("delivery:{}", event.message_id),
            )
            .header("X-SignalDock-Timestamp", timestamp.to_string())
            .body(payload_str.clone());

        if let Some(secret) = &target.webhook_secret {
            let sig = Self::generate_signature(&payload_str, secret, timestamp);
            req = req.header("X-SignalDock-Signature", sig);
        }

        let start = std::time::Instant::now();
        match req.send().await {
            Ok(resp) => {
                let elapsed = start.elapsed().as_millis() as u64;
                let status = resp.status();
                Self::interpret_response(status.as_u16(), status.is_success(), elapsed)
            }
            Err(e) if e.is_timeout() => Err(anyhow::anyhow!("webhook timeout after 30s")),
            Err(e) => Err(anyhow::anyhow!("network error: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_signature() {
        let sig = WebhookAdapter::generate_signature("payload", "secret", 1234567890);
        assert!(sig.starts_with("sha256="));
        assert_eq!(sig.len(), 7 + 64);
    }

    #[test]
    fn test_verify_signature_valid() {
        let payload = "test payload";
        let secret = "mysecret";
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let sig = WebhookAdapter::generate_signature(payload, secret, timestamp);
        assert!(WebhookAdapter::verify_signature(
            payload, &sig, secret, timestamp, 300
        ));
    }

    #[test]
    fn test_verify_signature_stale() {
        let sig = WebhookAdapter::generate_signature("data", "secret", 1000);
        assert!(!WebhookAdapter::verify_signature(
            "data", &sig, "secret", 1000, 300
        ));
    }

    #[test]
    fn test_verify_signature_wrong_secret() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let sig = WebhookAdapter::generate_signature("data", "correct", timestamp);
        assert!(!WebhookAdapter::verify_signature(
            "data", &sig, "wrong", timestamp, 300
        ));
    }

    #[tokio::test]
    async fn test_deliver_no_endpoint_is_permanent_failure() {
        let adapter = WebhookAdapter::new();
        use signaldock_protocol::message::{ContentType, DeliveryEvent};
        use uuid::Uuid;
        let event = DeliveryEvent {
            message_id: Uuid::new_v4(),
            conversation_id: Uuid::new_v4(),
            from_agent_id: "a".into(),
            from_agent_name: "A".into(),
            to_agent_id: "b".into(),
            content: "hi".into(),
            content_type: ContentType::Text,
            created_at: chrono::Utc::now(),
            attachments: vec![],
        };
        let target = DeliveryTarget {
            agent_id: "b".into(),
            endpoint: None,
            webhook_secret: None,
        };
        let result = adapter.deliver(&event, &target).await.unwrap();
        assert!(!result.success);
        assert!(result.permanent_failure);
    }
}
