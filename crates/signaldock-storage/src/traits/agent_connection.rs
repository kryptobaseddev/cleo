//! Repository trait for agent connection lifecycle (SSE/WebSocket tracking).

use anyhow::Result;
use async_trait::async_trait;

/// Represents an active agent connection record.
#[derive(Debug, Clone)]
pub struct AgentConnection {
    /// Internal primary key.
    pub id: String,
    /// The agent this connection belongs to.
    pub agent_id: String,
    /// Transport type: "http", "sse", or "websocket".
    pub transport_type: String,
    /// Unique connection identifier (per SSE stream or WS session).
    pub connection_id: Option<String>,
    /// Unix timestamp when the connection was established.
    pub connected_at: i64,
    /// Unix timestamp of last heartbeat received.
    pub last_heartbeat: i64,
    /// Optional JSON metadata about the connection.
    pub connection_metadata: Option<String>,
    /// Unix timestamp of record creation.
    pub created_at: i64,
}

/// Persistence operations for agent connection lifecycle.
///
/// Tracks active SSE and WebSocket connections for heartbeat monitoring
/// and stale connection detection. HTTP agents use polling and do not
/// create connection records.
#[async_trait]
pub trait AgentConnectionRepository: Send + Sync {
    /// Register a new agent connection (SSE/WebSocket stream opened).
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure or duplicate connection_id.
    async fn open_connection(
        &self,
        agent_id: &str,
        transport_type: &str,
        connection_id: Option<&str>,
        metadata: Option<&str>,
    ) -> Result<AgentConnection>;

    /// Update the heartbeat timestamp for an active connection.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` if the connection is not found or on database failure.
    async fn heartbeat(&self, id: &str) -> Result<()>;

    /// Close a connection (SSE/WebSocket stream ended).
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn close_connection(&self, id: &str) -> Result<()>;

    /// List all active connections for a given agent.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn list_connections(&self, agent_id: &str) -> Result<Vec<AgentConnection>>;

    /// Remove stale connections that haven't sent a heartbeat since `before_ts`.
    ///
    /// Returns the number of connections removed.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn reap_stale(&self, before_ts: i64) -> Result<u64>;
}
