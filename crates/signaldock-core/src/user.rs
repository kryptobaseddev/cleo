//! Authenticated human user accounts.
//!
//! A [`User`] represents a human who can claim and manage agents
//! through the web UI.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// An authenticated human user account.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    /// Unique user identifier (UUID).
    pub id: Uuid,
    /// User's email address (unique).
    pub email: String,
    /// Optional display name.
    pub name: Option<String>,
    /// The agentId this user defaults to when sending messages.
    /// `None` means auto-select the first owned agent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_agent_id: Option<String>,
    /// Timestamp when the account was created.
    pub created_at: DateTime<Utc>,
    /// Timestamp of the last account update.
    pub updated_at: DateTime<Utc>,
}
