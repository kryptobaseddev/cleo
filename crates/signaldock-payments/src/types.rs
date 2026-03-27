//! Payment protocol types for x402 flow.

use serde::{Deserialize, Serialize};

/// Supported payment networks in CAIP-2 format.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PaymentNetwork {
    /// Base mainnet (eip155:8453).
    BaseMainnet,
    /// Base Sepolia testnet (eip155:84532).
    BaseSepolia,
    /// Solana mainnet.
    SolanaMainnet,
    /// Solana devnet.
    SolanaDevnet,
}

impl PaymentNetwork {
    /// Returns the CAIP-2 chain identifier.
    pub fn caip2(&self) -> &'static str {
        match self {
            Self::BaseMainnet => "eip155:8453",
            Self::BaseSepolia => "eip155:84532",
            Self::SolanaMainnet => "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            Self::SolanaDevnet => "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        }
    }
}

/// A single payment option offered by an agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentOption {
    /// Payment scheme (e.g. "exact").
    pub scheme: String,
    /// Price as a decimal string (e.g. "0.001").
    pub price: String,
    /// Network in CAIP-2 format.
    pub network: String,
    /// Receiving wallet address.
    pub pay_to: String,
}

/// Payment requirement returned in 402 responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRequired {
    /// List of accepted payment options.
    pub accepts: Vec<PaymentOption>,
    /// Human-readable description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Payment payload sent by the client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentPayload {
    /// Payment scheme used.
    pub scheme: String,
    /// Network the payment was made on.
    pub network: String,
    /// Scheme-specific signed payload data.
    pub payload: serde_json::Value,
}

/// Response from the facilitator after settlement.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettlementResponse {
    /// Whether settlement succeeded.
    pub success: bool,
    /// Transaction hash on-chain.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_hash: Option<String>,
    /// Network the settlement occurred on.
    pub network: String,
    /// Error message if settlement failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
