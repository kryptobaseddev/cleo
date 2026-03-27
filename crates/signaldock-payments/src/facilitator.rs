//! Client for x402 facilitator services.

use anyhow::Result;
use reqwest::Client;
use tracing::{info, warn};

use super::types::{PaymentPayload, SettlementResponse};

/// x402 facilitator client for payment verification and settlement.
pub struct FacilitatorClient {
    client: Client,
    base_url: String,
}

impl FacilitatorClient {
    /// Creates a new facilitator client pointing at `base_url`.
    ///
    /// The client enforces a 30-second timeout and identifies
    /// itself with a `SignalDock-Payments/1.0` user-agent string.
    pub fn new(base_url: &str) -> Self {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("SignalDock-Payments/1.0")
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    /// Creates a client pointing to the x402.org testnet facilitator.
    pub fn testnet() -> Self {
        Self::new("https://x402.org/facilitator")
    }

    /// Creates a client pointing to the Coinbase CDP facilitator.
    pub fn coinbase() -> Self {
        Self::new("https://api.cdp.coinbase.com/platform/v2/x402")
    }

    /// Verifies a payment payload with the facilitator.
    ///
    /// Returns `true` if the facilitator accepts the payment, `false`
    /// if it rejects it.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTP request itself fails (network
    /// errors, timeouts, etc.).
    pub async fn verify(&self, payment: &PaymentPayload) -> Result<bool> {
        let url = format!("{}/verify", self.base_url);
        let resp = self.client.post(&url).json(payment).send().await?;
        if resp.status().is_success() {
            info!("payment verified via facilitator");
            Ok(true)
        } else {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            warn!(%status, %body, "payment verification failed");
            Ok(false)
        }
    }

    /// Settles a payment via the facilitator.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTP request fails or the response
    /// body cannot be deserialized as [`SettlementResponse`].
    pub async fn settle(&self, payment: &PaymentPayload) -> Result<SettlementResponse> {
        let url = format!("{}/settle", self.base_url);
        let resp = self.client.post(&url).json(payment).send().await?;
        let settlement: SettlementResponse = resp.json().await?;
        Ok(settlement)
    }
}
