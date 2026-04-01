//! Generic providers that wrap adapters directly.
//!
//! These use the adapter layer for transport:
//! - WebhookProvider → HttpAdapter
//! - StdoutProvider → StdoutAdapter  
//! - FileProvider → FileAdapter

use anyhow::Result;
use crate::adapters::{self, base::{Adapter, TransportResult}};
use super::provider::*;

// ============================================================
// Webhook — wraps HttpAdapter
// ============================================================

pub struct WebhookProvider {
    http: adapters::HttpAdapter,
}

impl WebhookProvider {
    pub fn new(url: String) -> Self {
        Self { http: adapters::HttpAdapter::new(url, None) }
    }
}

impl Provider for WebhookProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo { name: "webhook", display_name: "Webhook", version: "-", config_paths: &[], docs_url: "" }
    }
    fn detect() -> Option<Box<dyn Provider>> { None }
    fn deliver(&self, msg: &Message) -> Result<DeliveryResult> {
        let payload = serde_json::json!({
            "from": msg.from, "content": msg.content,
            "messageId": msg.id, "conversationId": msg.conversation_id,
            "contentType": msg.content_type, "createdAt": msg.created_at,
        });
        match self.http.send(&payload)? {
            TransportResult::Ok => Ok(DeliveryResult::Delivered),
            TransportResult::RetryableError(e) => Ok(DeliveryResult::Retry(e)),
            TransportResult::PermanentError(e) => Ok(DeliveryResult::Failed(e)),
        }
    }
}

// ============================================================
// Stdout — wraps StdoutAdapter
// ============================================================

pub struct StdoutProvider;

impl Provider for StdoutProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo { name: "stdout", display_name: "Stdout", version: "-", config_paths: &[], docs_url: "" }
    }
    fn detect() -> Option<Box<dyn Provider>> { None }
    fn deliver(&self, msg: &Message) -> Result<DeliveryResult> {
        let payload = serde_json::json!({
            "from": msg.from, "content": msg.content,
            "messageId": msg.id, "conversationId": msg.conversation_id,
            "createdAt": msg.created_at,
        });
        let adapter = adapters::StdoutAdapter;
        match adapter.send(&payload)? {
            TransportResult::Ok => Ok(DeliveryResult::Delivered),
            _ => Ok(DeliveryResult::Failed("stdout error".into())),
        }
    }
}

// ============================================================
// File — wraps FileAdapter
// ============================================================

pub struct FileProvider {
    file: adapters::FileAdapter,
}

impl FileProvider {
    pub fn new(dir: String) -> Self {
        Self { file: adapters::FileAdapter::new(dir) }
    }
}

impl Provider for FileProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo { name: "file", display_name: "File Output", version: "-", config_paths: &[], docs_url: "" }
    }
    fn detect() -> Option<Box<dyn Provider>> { None }
    fn deliver(&self, msg: &Message) -> Result<DeliveryResult> {
        let payload = serde_json::json!({
            "from": msg.from, "content": msg.content,
            "messageId": msg.id, "conversationId": msg.conversation_id,
            "contentType": msg.content_type, "createdAt": msg.created_at,
        });
        match self.file.send(&payload)? {
            TransportResult::Ok => Ok(DeliveryResult::Delivered),
            _ => Ok(DeliveryResult::Failed("file write error".into())),
        }
    }
}
