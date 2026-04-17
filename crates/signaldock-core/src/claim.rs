//! One-time claim codes for agent ownership transfer.
//!
//! An agent generates a [`ClaimCode`] that a human user redeems
//! through the web UI to take ownership of the agent.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A one-time code linking an agent to a human user.
///
/// The code is valid until `expires_at`. Once redeemed, `used_at`
/// and `used_by` are populated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimCode {
    /// Unique identifier for this claim code record.
    pub id: Uuid,
    /// Internal UUID of the agent being claimed.
    pub agent_id: Uuid,
    /// The short alphanumeric claim code string.
    pub code: String,
    /// Timestamp when this code expires.
    pub expires_at: DateTime<Utc>,
    /// Timestamp when the code was redeemed, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_at: Option<DateTime<Utc>>,
    /// UUID of the user who redeemed the code, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_by: Option<Uuid>,
    /// Timestamp when this claim code was created.
    pub created_at: DateTime<Utc>,
}

/// Payload for generating a new claim code.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewClaimCode {
    /// Internal UUID of the agent to claim.
    pub agent_id: Uuid,
    /// The short alphanumeric claim code string.
    pub code: String,
    /// Timestamp when this code should expire.
    pub expires_at: DateTime<Utc>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn test_claim_code_roundtrip() {
        let now = Utc::now();
        let claim = ClaimCode {
            id: Uuid::new_v4(),
            agent_id: Uuid::new_v4(),
            code: "ABC123".into(),
            expires_at: now,
            used_at: None,
            used_by: None,
            created_at: now,
        };
        let json = serde_json::to_string(&claim).unwrap();
        let parsed: ClaimCode = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.code, "ABC123");
        assert!(parsed.used_at.is_none());
    }

    #[test]
    fn test_new_claim_code_roundtrip() {
        let code = NewClaimCode {
            agent_id: Uuid::new_v4(),
            code: "XYZ789".into(),
            expires_at: Utc::now(),
        };
        let json = serde_json::to_string(&code).unwrap();
        let parsed: NewClaimCode = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.code, "XYZ789");
    }
}
