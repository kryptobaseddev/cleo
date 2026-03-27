//! Conversation management service.
//!
//! Provides idempotent conversation creation and paginated
//! listing. Participants are sorted internally so that
//! `find_or_create("a", "b")` and `find_or_create("b", "a")`
//! always return the same conversation.

use std::sync::Arc;

use anyhow::Result;
use uuid::Uuid;

use signaldock_protocol::conversation::Conversation;
use signaldock_storage::{
    traits::ConversationRepository,
    types::{ConversationQuery, Page},
};

/// Service for creating and querying conversations.
///
/// `R` must implement [`ConversationRepository`].
pub struct ConversationService<R> {
    repo: Arc<R>,
}

impl<R: ConversationRepository + Send + Sync> ConversationService<R> {
    /// Creates a new [`ConversationService`] backed by the
    /// given repository.
    pub fn new(repo: Arc<R>) -> Self {
        Self { repo }
    }

    /// Finds an existing conversation between two agents or
    /// creates one.
    ///
    /// This operation is idempotent -- participant order does
    /// not matter because participants are sorted before
    /// lookup.
    ///
    /// # Errors
    ///
    /// Returns an error if the repository operation fails.
    pub async fn find_or_create(
        &self,
        participant_a: &str,
        participant_b: &str,
    ) -> Result<Conversation> {
        self.repo.find_or_create(participant_a, participant_b).await
    }

    /// Retrieves a conversation by its internal UUID.
    ///
    /// # Errors
    ///
    /// Returns an error if the conversation does not exist or
    /// the repository query fails.
    pub async fn get(&self, id: Uuid) -> Result<Conversation> {
        self.repo
            .find_by_id(id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("conversation not found: {id}"))
    }

    /// Creates a conversation with multiple participants.
    ///
    /// Unlike `find_or_create`, this always creates a new
    /// conversation (group chats are not deduplicated).
    ///
    /// # Errors
    ///
    /// Returns an error if the repository operation fails.
    pub async fn create_group(
        &self,
        participants: Vec<String>,
        visibility: signaldock_protocol::conversation::ConversationVisibility,
    ) -> Result<Conversation> {
        self.repo
            .create_with_participants(participants, visibility)
            .await
    }

    /// Adds participants to an existing conversation.
    ///
    /// # Errors
    ///
    /// Returns an error if the conversation does not exist
    /// or the repository query fails.
    pub async fn add_participants(
        &self,
        id: Uuid,
        new_participants: Vec<String>,
    ) -> Result<Conversation> {
        self.repo.add_participants(id, new_participants).await
    }

    /// Lists conversations that include the given agent,
    /// with pagination.
    ///
    /// # Errors
    ///
    /// Returns an error if the repository query fails.
    pub async fn list_for_agent(
        &self,
        agent_id: &str,
        page: u32,
        limit: u32,
    ) -> Result<Page<Conversation>> {
        self.repo
            .list_for_agent(ConversationQuery {
                participant_agent_id: Some(agent_id.to_string()),
                page,
                limit,
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::MockStore;

    #[tokio::test]
    async fn test_find_or_create() {
        let store = Arc::new(MockStore::new());
        let svc = ConversationService::new(store);

        let conv1 = svc.find_or_create("alice", "bob").await.unwrap();
        let conv2 = svc.find_or_create("alice", "bob").await.unwrap();
        assert_eq!(conv1.id, conv2.id, "should return same conversation");

        // Reversed order should also find the same conversation
        let conv3 = svc.find_or_create("bob", "alice").await.unwrap();
        assert_eq!(conv1.id, conv3.id);
    }

    #[tokio::test]
    async fn test_get_not_found() {
        let store = Arc::new(MockStore::new());
        let svc = ConversationService::new(store);

        let result = svc.get(Uuid::new_v4()).await;
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("conversation not found")
        );
    }

    #[tokio::test]
    async fn test_list_for_agent() {
        let store = Arc::new(MockStore::new());
        let svc = ConversationService::new(store);

        svc.find_or_create("alice", "bob").await.unwrap();
        svc.find_or_create("alice", "charlie").await.unwrap();

        let page = svc.list_for_agent("alice", 1, 10).await.unwrap();
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.total, 2);
    }
}
