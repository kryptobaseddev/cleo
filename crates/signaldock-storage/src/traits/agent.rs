//! Repository trait for [`Agent`] entities.

use async_trait::async_trait;
use uuid::Uuid;

use anyhow::Result;
use signaldock_protocol::agent::{Agent, AgentUpdate, NewAgent};

use crate::types::{AgentQuery, Page, StatsDelta};

/// Persistence operations for [`Agent`] entities.
#[async_trait]
pub trait AgentRepository: Send + Sync {
    /// Finds an agent by its human-readable slug.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn find_by_agent_id(&self, agent_id: &str) -> Result<Option<Agent>>;

    /// Finds an agent by its internal UUID.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn find_by_id(&self, id: Uuid) -> Result<Option<Agent>>;

    /// Creates a new agent and returns the persisted record.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure or if
    /// the `agent_id` slug is already taken.
    async fn create(&self, agent: NewAgent) -> Result<Agent>;

    /// Applies a partial update to an existing agent.
    ///
    /// Fields set to `None` in [`AgentUpdate`] retain their
    /// current values.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` if the agent is not found or
    /// on database failure.
    async fn update(&self, id: Uuid, update: AgentUpdate) -> Result<Agent>;

    /// Deletes an agent by its internal UUID.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn delete(&self, id: Uuid) -> Result<()>;

    /// Lists agents matching the given query filters.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn list(&self, query: AgentQuery) -> Result<Page<Agent>>;

    /// Atomically increments agent stats counters.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn increment_stats(&self, id: Uuid, delta: StatsDelta) -> Result<()>;

    /// Assigns an owner (user) to an agent.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` if the agent is not found or
    /// on database failure.
    async fn set_owner(&self, id: Uuid, owner_id: Uuid) -> Result<Agent>;

    /// Refreshes the agent's `last_seen` timestamp to now.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn update_last_seen(&self, id: Uuid) -> Result<()>;
}
