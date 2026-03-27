//! Message sending and retrieval service.
//!
//! Supports two send paths: a legacy path that auto-creates a
//! conversation between two agents, and a conversation-based
//! path that targets an existing conversation. Both paths
//! atomically increment sender/receiver stats.

use std::sync::Arc;

use anyhow::{Context, Result};
use uuid::Uuid;

use signaldock_protocol::message::{Attachment, ContentType, Message, MessageMetadata, NewMessage};

/// Converts a [`cant_core::ParsedCANTMessage`] into a [`MessageMetadata`].
fn cant_to_metadata(parsed: &cant_core::ParsedCANTMessage) -> MessageMetadata {
    MessageMetadata {
        mentions: parsed.addresses.clone(),
        directives: parsed.directive.iter().cloned().collect(),
        tags: parsed.tags.clone(),
        task_refs: parsed.task_refs.clone(),
    }
}
use signaldock_storage::{
    traits::{AgentRepository, ConversationRepository, MessageRepository},
    types::StatsDelta,
};

/// Service for sending, polling, and acknowledging messages.
///
/// `R` must implement [`MessageRepository`],
/// [`ConversationRepository`], and `AgentRepository`.
pub struct MessageService<R> {
    repo: Arc<R>,
}

impl<R: MessageRepository + ConversationRepository + AgentRepository + Send + Sync>
    MessageService<R>
{
    /// Creates a new [`MessageService`] backed by the given
    /// repository.
    pub fn new(repo: Arc<R>) -> Self {
        Self { repo }
    }

    /// Sends a message via the legacy path.
    ///
    /// Automatically finds or creates a conversation between
    /// `from_agent_id` and `to_agent_id`, then persists the
    /// message and increments both agents' stats.
    ///
    /// # Errors
    ///
    /// Returns an error if either agent is not found, the
    /// conversation cannot be created, or message persistence
    /// fails.
    pub async fn send(
        &self,
        from_agent_id: &str,
        to_agent_id: &str,
        content: String,
        content_type: ContentType,
        attachments: Vec<Attachment>,
    ) -> Result<Message> {
        let from = self
            .repo
            .find_by_agent_id(from_agent_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("sender agent not found: {from_agent_id}"))?;
        let to = self
            .repo
            .find_by_agent_id(to_agent_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("recipient agent not found: {to_agent_id}"))?;
        let conversation = self
            .repo
            .find_or_create(from_agent_id, to_agent_id)
            .await
            .context("failed to find or create conversation")?;

        let extracted = cant_to_metadata(&cant_core::parse(&content));
        let metadata = if extracted.is_empty() {
            None
        } else {
            Some(extracted)
        };

        let new_msg = NewMessage {
            conversation_id: conversation.id,
            from_agent_id: from_agent_id.to_string(),
            to_agent_id: to_agent_id.to_string(),
            content,
            content_type,
            attachments,
            group_id: None,
            metadata,
            reply_to: None,
        };

        let message = MessageRepository::create(self.repo.as_ref(), new_msg)
            .await
            .context("failed to create message")?;

        self.repo
            .increment_stats(from.id, StatsDelta::sent())
            .await?;
        self.repo
            .increment_stats(to.id, StatsDelta::received())
            .await?;
        self.repo.increment_message_count(conversation.id).await?;

        // Increment conversation_count on both agents when the
        // conversation was just created (message_count == 0 means no
        // prior messages existed before this one).
        if conversation.message_count == 0 {
            self.repo
                .increment_stats(from.id, StatsDelta::conversation())
                .await?;
            self.repo
                .increment_stats(to.id, StatsDelta::conversation())
                .await?;
        }

        Ok(message)
    }

    /// Sends a message within an existing conversation.
    ///
    /// Unlike [`send`](Self::send), this method requires an
    /// existing `conversation_id` and works for both user and
    /// agent callers.
    ///
    /// # Errors
    ///
    /// Returns an error if either agent is not found or message
    /// persistence fails.
    #[allow(clippy::too_many_arguments)]
    pub async fn send_to_conversation(
        &self,
        conversation_id: Uuid,
        from_agent_id: &str,
        to_agent_id: &str,
        content: String,
        content_type: ContentType,
        attachments: Vec<Attachment>,
        group_id: Option<Uuid>,
    ) -> Result<Message> {
        let from = self
            .repo
            .find_by_agent_id(from_agent_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("sender not found"))?;
        let to = self
            .repo
            .find_by_agent_id(to_agent_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("recipient not found"))?;

        let extracted = cant_to_metadata(&cant_core::parse(&content));
        let metadata = if extracted.is_empty() {
            None
        } else {
            Some(extracted)
        };

        let new_msg = NewMessage {
            conversation_id,
            from_agent_id: from_agent_id.to_string(),
            to_agent_id: to_agent_id.to_string(),
            content,
            content_type,
            attachments,
            group_id,
            metadata,
            reply_to: None,
        };

        let message = MessageRepository::create(self.repo.as_ref(), new_msg).await?;

        self.repo
            .increment_stats(from.id, StatsDelta::sent())
            .await?;
        self.repo
            .increment_stats(to.id, StatsDelta::received())
            .await?;
        self.repo.increment_message_count(conversation_id).await?;

        Ok(message)
    }

    /// Polls for new messages delivered to the given agent.
    ///
    /// When `since_id` is provided, only messages created after
    /// that message ID are returned.
    ///
    /// # Errors
    ///
    /// Returns an error if the repository query fails.
    pub async fn poll_new(&self, agent_id: &str, since_id: Option<Uuid>) -> Result<Vec<Message>> {
        self.repo.poll_new(agent_id, since_id).await
    }

    /// Marks a message as read/acknowledged.
    ///
    /// # Errors
    ///
    /// Returns an error if the message does not exist or the
    /// repository operation fails.
    pub async fn acknowledge(&self, message_id: Uuid) -> Result<()> {
        self.repo.mark_read(message_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::MockStore;
    use signaldock_protocol::agent::{AgentClass, NewAgent, PrivacyTier};

    fn test_new_agent(agent_id: &str, name: &str) -> NewAgent {
        NewAgent {
            agent_id: agent_id.into(),
            name: name.into(),
            description: None,
            class: AgentClass::Custom,
            privacy_tier: PrivacyTier::Public,
            endpoint: None,
            capabilities: vec![],
            skills: vec![],
            avatar: None,
            payment_config: None,
            webhook_secret: None,
        }
    }

    #[tokio::test]
    async fn test_send_message() {
        let store = Arc::new(MockStore::new());

        // Register both agents
        AgentRepository::create(store.as_ref(), test_new_agent("alice", "Alice"))
            .await
            .unwrap();
        AgentRepository::create(store.as_ref(), test_new_agent("bob", "Bob"))
            .await
            .unwrap();

        let svc = MessageService::new(store.clone());
        let msg = svc
            .send(
                "alice",
                "bob",
                "Hello Bob!".into(),
                ContentType::Text,
                vec![],
            )
            .await
            .unwrap();

        assert_eq!(msg.from_agent_id, "alice");
        assert_eq!(msg.to_agent_id, "bob");
        assert_eq!(msg.content, "Hello Bob!");
    }

    #[tokio::test]
    async fn test_send_missing_sender() {
        let store = Arc::new(MockStore::new());
        let svc = MessageService::new(store);

        let result = svc
            .send("ghost", "bob", "Hello".into(), ContentType::Text, vec![])
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("sender"));
    }

    #[tokio::test]
    async fn test_poll_new() {
        let store = Arc::new(MockStore::new());

        AgentRepository::create(store.as_ref(), test_new_agent("alice", "Alice"))
            .await
            .unwrap();
        AgentRepository::create(store.as_ref(), test_new_agent("bob", "Bob"))
            .await
            .unwrap();

        let svc = MessageService::new(store.clone());
        svc.send(
            "alice",
            "bob",
            "Message 1".into(),
            ContentType::Text,
            vec![],
        )
        .await
        .unwrap();

        let messages = svc.poll_new("bob", None).await.unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "Message 1");
    }

    #[tokio::test]
    async fn test_acknowledge() {
        let store = Arc::new(MockStore::new());

        AgentRepository::create(store.as_ref(), test_new_agent("alice", "Alice"))
            .await
            .unwrap();
        AgentRepository::create(store.as_ref(), test_new_agent("bob", "Bob"))
            .await
            .unwrap();

        let svc = MessageService::new(store.clone());
        let msg = svc
            .send("alice", "bob", "Read me".into(), ContentType::Text, vec![])
            .await
            .unwrap();

        svc.acknowledge(msg.id).await.unwrap();
    }
}
