//! Repository trait definitions for all domain entities.
//!
//! Each trait declares the storage operations needed by the
//! application layer, independent of the backing database.
//! Implementations live in [`crate::adapters`].
//!
//! # Design
//!
//! See [ADR-002: Storage Abstraction](../../../docs/dev/adr/002-storage-abstraction.md).

use async_trait::async_trait;
use uuid::Uuid;

use anyhow::Result;
use signaldock_protocol::{
    agent::{Agent, AgentUpdate, NewAgent},
    claim::ClaimCode,
    connection::{Connection, ConnectionStatus, NewConnection},
    conversation::{Conversation, ConversationVisibility},
    message::{Message, NewMessage},
};

use crate::types::{AgentQuery, ConversationQuery, DeliveryJob, MessageQuery, Page, StatsDelta};

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

/// Persistence operations for [`Message`] entities.
#[async_trait]
pub trait MessageRepository: Send + Sync {
    /// Persists a new message and returns the stored record.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn create(&self, message: NewMessage) -> Result<Message>;

    /// Finds a message by its UUID.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn find_by_id(&self, id: Uuid) -> Result<Option<Message>>;

    /// Lists messages within a conversation, paginated.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn list_for_conversation(&self, query: MessageQuery) -> Result<Page<Message>>;

    /// Returns new messages for an agent since a cursor.
    ///
    /// When `since_id` is `None`, returns all undelivered
    /// messages for the agent.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn poll_new(&self, agent_id: &str, since_id: Option<Uuid>) -> Result<Vec<Message>>;

    /// Marks a message as delivered.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn mark_delivered(&self, id: Uuid) -> Result<()>;

    /// Marks a message as read.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn mark_read(&self, id: Uuid) -> Result<()>;

    /// Full-text search across message content.
    ///
    /// Returns messages matching the query string, optionally
    /// filtered by conversation. Results are ranked by relevance.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn search(
        &self,
        query: &str,
        conversation_id: Option<Uuid>,
        limit: u32,
    ) -> Result<Vec<Message>>;
}

/// Persistence operations for [`Conversation`] entities.
#[async_trait]
pub trait ConversationRepository: Send + Sync {
    /// Finds an existing conversation between two agents or
    /// creates one if none exists.
    ///
    /// Participant order does not matter; the implementation
    /// normalizes the pair.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn find_or_create(
        &self,
        participant_a: &str,
        participant_b: &str,
    ) -> Result<Conversation>;

    /// Finds a conversation by its UUID.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn find_by_id(&self, id: Uuid) -> Result<Option<Conversation>>;

    /// Lists conversations that include a given agent,
    /// paginated.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn list_for_agent(&self, query: ConversationQuery) -> Result<Page<Conversation>>;

    /// Increments the message counter on a conversation.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn increment_message_count(&self, id: Uuid) -> Result<()>;

    /// Updates the `last_message_at` timestamp to now.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn update_last_message_at(&self, id: Uuid) -> Result<()>;

    /// Updates the visibility setting of a conversation.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` if the conversation is not
    /// found or on database failure.
    async fn update_visibility(
        &self,
        id: Uuid,
        visibility: ConversationVisibility,
    ) -> Result<Conversation>;

    /// Creates a conversation with an arbitrary number of
    /// participants. Participants are sorted for consistency.
    ///
    /// Unlike `find_or_create`, this always creates a new
    /// conversation (no deduplication for group chats).
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn create_with_participants(
        &self,
        participants: Vec<String>,
        visibility: ConversationVisibility,
    ) -> Result<Conversation>;

    /// Adds participants to an existing conversation.
    ///
    /// Returns the updated conversation. Silently ignores
    /// participants that are already in the conversation.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` if the conversation is not
    /// found or on database failure.
    async fn add_participants(
        &self,
        id: Uuid,
        new_participants: Vec<String>,
    ) -> Result<Conversation>;
}

/// Persistence operations for user accounts.
#[async_trait]
pub trait UserRepository: Send + Sync {
    /// Creates a new user with the given credentials.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure or if
    /// the email is already registered.
    async fn create(
        &self,
        email: &str,
        password_hash: &str,
        name: Option<&str>,
    ) -> Result<signaldock_protocol::user::User>;

    /// Finds a user by their internal UUID.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn find_by_id(&self, id: Uuid) -> Result<Option<signaldock_protocol::user::User>>;

    /// Finds a user by their email address.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn find_by_email(&self, email: &str) -> Result<Option<signaldock_protocol::user::User>>;

    /// Sets the user's default sending agent.
    ///
    /// Pass `None` to clear the default (auto-select first owned agent).
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure or if the agent
    /// is not owned by this user.
    async fn set_default_agent(
        &self,
        user_id: Uuid,
        agent_id: Option<&str>,
    ) -> Result<signaldock_protocol::user::User>;
}

/// Persistence operations for agent claim codes.
///
/// Claim codes allow a human user to prove ownership of an
/// agent through a one-time redemption flow.
#[async_trait]
pub trait ClaimRepository: Send + Sync {
    /// Generates a new claim code for an agent.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn create_code(
        &self,
        agent_id: Uuid,
        code: &str,
        expires_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<ClaimCode>;

    /// Looks up a claim code by its string value.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn find_code(&self, code: &str) -> Result<Option<ClaimCode>>;

    /// Redeems a claim code, binding the agent to a user.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` if the code is invalid,
    /// expired, or on database failure.
    async fn redeem_code(&self, code: &str, user_id: Uuid) -> Result<ClaimCode>;

    /// Invalidates all expired claim codes.
    ///
    /// Returns the number of codes invalidated.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn invalidate_expired(&self) -> Result<u64>;
}

/// Persistence operations for the delivery job queue.
///
/// Implementations back the background
/// `signaldock_sdk::services::delivery_worker` that retries failed
/// message deliveries with exponential backoff.
#[async_trait]
pub trait DeliveryJobRepository: Send + Sync {
    /// Enqueues a new delivery job for `message_id`.
    ///
    /// `payload` is the JSON-serialized `DeliveryJobPayload`
    /// containing the [`DeliveryEvent`] and
    /// `signaldock_transport::traits::DeliveryTarget`.
    ///
    /// Returns the UUID assigned to the new job row.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    ///
    /// [`DeliveryEvent`]: signaldock_protocol::message::DeliveryEvent
    async fn enqueue_job(&self, message_id: Uuid, payload: &str) -> Result<Uuid>;

    /// Fetches up to `limit` jobs that are ready to be processed.
    ///
    /// A job is ready when `status = 'pending'` and
    /// `next_attempt_at <= now`.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn fetch_ready_jobs(&self, limit: u32) -> Result<Vec<DeliveryJob>>;

    /// Marks a job as successfully completed (`status = 'done'`).
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn complete_job(&self, job_id: Uuid) -> Result<()>;

    /// Records a failed attempt for a job.
    ///
    /// Increments `attempts` and sets `next_attempt_at` using
    /// exponential backoff (`1s * 2^attempts`, capped at 32 s).
    /// If `attempts >= max_attempts`, the job is dead-lettered
    /// instead of rescheduled.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn fail_job(&self, job_id: Uuid, error: &str) -> Result<()>;

    /// Moves a job to the `dead_letters` table.
    ///
    /// The original job row is deleted after the dead-letter record
    /// is inserted.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn dead_letter_job(&self, job_id: Uuid, reason: &str) -> Result<()>;
}

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
