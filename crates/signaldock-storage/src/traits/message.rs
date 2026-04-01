//! Repository trait for [`Message`] entities.

use async_trait::async_trait;
use uuid::Uuid;

use anyhow::Result;
use signaldock_protocol::message::{Message, NewMessage};

use crate::types::{ActionItem, MessageQuery, Page, UnreadConversation};

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

    /// Counts unread messages (status `pending` or `delivered`)
    /// addressed to the given agent.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn count_unread(&self, agent_id: &str) -> Result<i64>;

    /// Returns per-conversation unread counts for an agent.
    ///
    /// Groups unread messages by `conversation_id` and returns
    /// each group's count and most recent timestamp, ordered
    /// by recency (newest conversation first).
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn unread_by_conversation(&self, agent_id: &str) -> Result<Vec<UnreadConversation>>;

    /// Returns inbox action items — unread messages with non-empty
    /// metadata — for the given agent.
    ///
    /// Results include a 200-character content preview and the raw
    /// metadata JSON, ordered by creation time (newest first),
    /// capped at `limit` rows.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn action_items(&self, agent_id: &str, limit: i64) -> Result<Vec<ActionItem>>;
}
