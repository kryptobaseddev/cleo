//! HTTP adapter — POST JSON to any URL.
//!
//! Used by:
//! - OpenClawProvider (POST to /hooks/agent with Bearer token)
//! - WebhookProvider (POST to user-specified URL)
//! - Any future provider that communicates via HTTP

use super::base::{Adapter, TransportResult};
use anyhow::Result;

pub struct HttpAdapter {
    url: String,
    auth_header: Option<String>,
}

impl HttpAdapter {
    pub fn new(url: String, auth_header: Option<String>) -> Self {
        Self { url, auth_header }
    }
}

impl Adapter for HttpAdapter {
    fn name(&self) -> &str {
        "http"
    }

    fn send(&self, payload: &serde_json::Value) -> Result<TransportResult> {
        let client = reqwest::blocking::Client::new();
        let mut req = client
            .post(&self.url)
            .json(payload)
            .timeout(std::time::Duration::from_secs(10));

        if let Some(auth) = &self.auth_header {
            req = req.header("Authorization", auth);
        }

        match req.send() {
            Ok(r) if r.status().is_success() => Ok(TransportResult::Ok),
            Ok(r) if r.status().is_server_error() => Ok(TransportResult::RetryableError(format!(
                "HTTP {}",
                r.status()
            ))),
            Ok(r) => Ok(TransportResult::PermanentError(format!(
                "HTTP {}",
                r.status()
            ))),
            Err(e) if e.is_timeout() || e.is_connect() => {
                Ok(TransportResult::RetryableError(format!("{}", e)))
            }
            Err(e) => Ok(TransportResult::PermanentError(format!("{}", e))),
        }
    }
}
