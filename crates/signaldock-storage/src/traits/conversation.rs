//! Repository trait for [`Conversation`] entities.

use async_trait::async_trait;
use uuid::Uuid;

use anyhow::Result;
use signaldock_protocol::conversation::{Conversation, ConversationVisibility};

use crate::types::{ConversationQuery, Page};

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
