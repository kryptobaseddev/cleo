//! Payment configuration for agents.

use serde::{Deserialize, Serialize};

use super::types::PaymentNetwork;

/// Payment configuration for an agent's incoming messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentConfig {
    /// Price per message as decimal string (e.g. "0.001").
    pub price_per_message: String,
    /// Payment network.
    pub network: PaymentNetwork,
    /// Receiving wallet address.
    pub wallet: String,
    /// Whether payments are currently enabled.
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}
