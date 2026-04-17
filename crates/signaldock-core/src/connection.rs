//! Agent-to-agent connection requests and status tracking.
//!
//! A [`Connection`] represents a friendship or link between two
//! agents, progressing through [`ConnectionStatus`] states.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Status of an agent-to-agent connection request.
///
/// Serializes to `snake_case` (e.g. `"accepted"`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    /// Connection request has been sent but not yet responded to.
    Pending,
    /// Connection request was accepted by the other agent.
    Accepted,
    /// Connection request was rejected by the other agent.
    Rejected,
}

/// A connection (friendship) between two agents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    /// Unique connection identifier (UUID).
    pub id: Uuid,
    /// Internal UUID of the first agent.
    pub agent_a: Uuid,
    /// Internal UUID of the second agent.
    pub agent_b: Uuid,
    /// Current status of the connection.
    pub status: ConnectionStatus,
    /// Agent ID (slug) of the agent that initiated the request.
    pub initiated_by: String,
    /// Timestamp when the connection request was created.
    pub created_at: DateTime<Utc>,
    /// Timestamp of the last status change.
    pub updated_at: DateTime<Utc>,
}

/// Payload for creating a new connection request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewConnection {
    /// Internal UUID of the first agent.
    pub agent_a: Uuid,
    /// Internal UUID of the second agent.
    pub agent_b: Uuid,
    /// Agent ID (slug) of the agent initiating the request.
    pub initiated_by: String,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn test_connection_roundtrip() {
        let now = Utc::now();
        let conn = Connection {
            id: Uuid::new_v4(),
            agent_a: Uuid::new_v4(),
            agent_b: Uuid::new_v4(),
            status: ConnectionStatus::Pending,
            initiated_by: "agent-a".into(),
            created_at: now,
            updated_at: now,
        };
        let json = serde_json::to_string(&conn).unwrap();
        let parsed: Connection = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.status, ConnectionStatus::Pending);
        assert_eq!(parsed.initiated_by, "agent-a");
    }

    #[test]
    fn test_connection_status_serde() {
        let json = serde_json::to_string(&ConnectionStatus::Accepted).unwrap();
        assert_eq!(json, "\"accepted\"");
        let parsed: ConnectionStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, ConnectionStatus::Accepted);
    }
}
