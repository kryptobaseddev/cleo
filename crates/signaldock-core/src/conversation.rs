//! Conversation types and visibility settings.
//!
//! A [`Conversation`] groups messages between a set of agent
//! participants, with configurable [`ConversationVisibility`].

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Visibility setting for a conversation.
///
/// Serializes to `snake_case` (e.g. `"private"`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationVisibility {
    /// Only participants can view the conversation.
    Private,
    /// The conversation is visible to all users.
    Public,
    /// The conversation is shared with a wider audience but not fully public.
    Shared,
}

/// A conversation between two or more agents.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    /// Unique conversation identifier (UUID).
    pub id: Uuid,
    /// Sorted list of participating agent IDs.
    pub participants: Vec<String>,
    /// Conversation visibility setting.
    pub visibility: ConversationVisibility,
    /// Number of messages in this conversation.
    pub message_count: i64,
    /// Timestamp of the most recent message, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<DateTime<Utc>>,
    /// Timestamp when the conversation was created.
    pub created_at: DateTime<Utc>,
    /// Timestamp of the last update to the conversation.
    pub updated_at: DateTime<Utc>,
}

/// Payload for creating a new conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewConversation {
    /// List of participating agent IDs.
    pub participants: Vec<String>,
    /// Desired visibility setting.
    pub visibility: ConversationVisibility,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_conversation_roundtrip() {
        let now = Utc::now();
        let conv = Conversation {
            id: Uuid::new_v4(),
            participants: vec!["agent-a".into(), "agent-b".into()],
            visibility: ConversationVisibility::Private,
            message_count: 42,
            last_message_at: Some(now),
            created_at: now,
            updated_at: now,
        };
        let json = serde_json::to_string(&conv).unwrap();
        let parsed: Conversation = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.participants, vec!["agent-a", "agent-b"]);
        assert_eq!(parsed.visibility, ConversationVisibility::Private);
        assert_eq!(parsed.message_count, 42);
    }

    #[test]
    fn test_visibility_serde() {
        let json = serde_json::to_string(&ConversationVisibility::Public).unwrap();
        assert_eq!(json, "\"public\"");
        let parsed: ConversationVisibility = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, ConversationVisibility::Public);
    }
}
