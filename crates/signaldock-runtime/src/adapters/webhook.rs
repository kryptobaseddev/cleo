//! Generic webhook adapter — POSTs message JSON to any URL.
//!
//! Usage: signaldock connect --platform webhook --webhook http://localhost:3000/messages

use anyhow::Result;
use super::base::{PlatformAdapter, Message, DeliveryResult};

pub struct WebhookAdapter {
    url: String,
}

impl WebhookAdapter {
    pub fn new(url: String) -> Self {
        Self { url }
    }
}

impl PlatformAdapter for WebhookAdapter {
    fn name(&self) -> &str { "webhook" }

    fn deliver(&self, msg: &Message) -> Result<DeliveryResult> {
        let payload = serde_json::json!({
            "from": msg.from,
            "content": msg.content,
            "messageId": msg.id,
            "conversationId": msg.conversation_id,
            "contentType": msg.content_type,
            "createdAt": msg.created_at,
            "metadata": msg.metadata,
        });

        let client = reqwest::blocking::Client::new();
        let resp = client.post(&self.url)
            .json(&payload)
            .timeout(std::time::Duration::from_secs(10))
            .send();

        match resp {
            Ok(r) if r.status().is_success() => {
                eprintln!("[signaldock] Delivered to webhook {}", self.url);
                Ok(DeliveryResult::Delivered)
            }
            Ok(r) if r.status().is_server_error() => {
                Ok(DeliveryResult::Retry(format!("Webhook returned {}", r.status())))
            }
            Ok(r) => {
                Ok(DeliveryResult::Failed(format!("Webhook returned {}", r.status())))
            }
            Err(e) if e.is_timeout() || e.is_connect() => {
                Ok(DeliveryResult::Retry(format!("{}", e)))
            }
            Err(e) => {
                Ok(DeliveryResult::Failed(format!("{}", e)))
            }
        }
    }
}
