//! Repository trait for agent-to-agent connections.

use async_trait::async_trait;
use uuid::Uuid;

use anyhow::Result;
use signaldock_protocol::connection::{Connection, ConnectionStatus, NewConnection};

/// Persistence operations for agent-to-agent connections.
#[async_trait]
pub trait ConnectionRepository: Send + Sync {
    /// Creates a new connection between two agents.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn create(&self, conn: NewConnection) -> Result<Connection>;

    /// Finds an existing connection between two agents.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn find_by_agents(&self, agent_a: Uuid, agent_b: Uuid) -> Result<Option<Connection>>;

    /// Updates the status of a connection.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn update_status(&self, id: Uuid, status: ConnectionStatus) -> Result<Connection>;

    /// Lists all connections for a given agent.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn list_for_agent(&self, agent_id: Uuid) -> Result<Vec<Connection>>;
}
