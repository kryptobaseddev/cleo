//! Message types, delivery events, and content classification.
//!
//! Defines the [`Message`] record, the [`NewMessage`] creation
//! payload, and the [`DeliveryEvent`] dispatched to transport
//! adapters (webhooks, SSE, polling).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Extracted metadata from message content: @mentions, /directives, #tags.
///
/// Server-side extraction parses natural syntax from content text.
/// Clients may also provide explicit metadata alongside content.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageMetadata {
    /// Agent IDs mentioned via `@agent-id` syntax.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<String>,
    /// Directives from `/action`, `/info`, `/review`, `/decision`, `/blocked`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub directives: Vec<String>,
    /// Topic tags from `#tag` syntax.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Task references from `T` + digit patterns (e.g. T1234, T005).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_refs: Vec<String>,
}

impl MessageMetadata {
    /// Merges explicit client-provided metadata with extracted metadata.
    ///
    /// Client values take precedence (are added first), extraction
    /// fills any gaps.
    #[must_use]
    pub fn merge(mut self, other: Self) -> Self {
        for m in other.mentions {
            if !self.mentions.contains(&m) {
                self.mentions.push(m);
            }
        }
        for d in other.directives {
            if !self.directives.contains(&d) {
                self.directives.push(d);
            }
        }
        for t in other.tags {
            if !self.tags.contains(&t) {
                self.tags.push(t);
            }
        }
        for r in other.task_refs {
            if !self.task_refs.contains(&r) {
                self.task_refs.push(r);
            }
        }
        self
    }

    /// Returns `true` if no mentions, directives, or tags are present.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.mentions.is_empty()
            && self.directives.is_empty()
            && self.tags.is_empty()
            && self.task_refs.is_empty()
    }
}

/// Delivery status of a message.
///
/// Serializes to `snake_case` (e.g. `"delivered"`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageStatus {
    /// Message has been created but not yet delivered.
    Pending,
    /// Message has been delivered to the recipient.
    Delivered,
    /// Message has been read by the recipient.
    Read,
}

/// MIME-like content type for message payloads.
///
/// Serializes to `snake_case` (e.g. `"text"`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContentType {
    /// Plain text content.
    Text,
    /// Image content (referenced by URL in attachments).
    Image,
    /// Generic file attachment (referenced by URL).
    File,
    /// Video content (referenced by URL in attachments).
    Video,
    /// Audio content (referenced by URL in attachments).
    Audio,
    /// A hyperlink with optional preview metadata.
    Link,
    /// Rich text (e.g. Markdown or HTML).
    RichText,
    /// Message body with one or more attachments of mixed types.
    Mixed,
}

/// A file or media attachment referenced by URL.
///
/// Agents host assets externally; `SignalDock` stores only the
/// reference URL, not the binary content.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// Unique attachment identifier.
    pub id: Uuid,
    /// MIME type (e.g. `"image/png"`).
    pub content_type: String,
    /// Original filename, if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    /// Reference URL where the attachment is hosted.
    pub url: String,
    /// File size in bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// SHA-256 checksum for integrity verification.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
    /// Extensible metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// A message exchanged between two agents within a conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// Unique message identifier (UUID).
    pub id: Uuid,
    /// Conversation this message belongs to.
    pub conversation_id: Uuid,
    /// Agent ID of the sender.
    pub from_agent_id: String,
    /// Agent ID of the recipient.
    pub to_agent_id: String,
    /// Message body.
    pub content: String,
    /// Content type of the message body.
    pub content_type: ContentType,
    /// Current delivery status.
    pub status: MessageStatus,
    /// Timestamp when the message was created.
    pub created_at: DateTime<Utc>,
    /// Timestamp when the message was delivered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<DateTime<Utc>>,
    /// Timestamp when the message was read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_at: Option<DateTime<Utc>>,
    /// File or media attachments referenced by URL.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    /// Shared ID for fan-out copies in group conversations.
    ///
    /// All copies of the same logical message share this ID.
    /// `None` for 1-on-1 messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Uuid>,
    /// Extracted @mentions, /directives, and #tags.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<MessageMetadata>,
    /// UUID of the message this is a reply to (threading).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Uuid>,
}

/// Payload for creating a new message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMessage {
    /// Conversation to send the message in.
    pub conversation_id: Uuid,
    /// Agent ID of the sender.
    pub from_agent_id: String,
    /// Agent ID of the recipient.
    pub to_agent_id: String,
    /// Message body.
    pub content: String,
    /// Content type of the message body.
    pub content_type: ContentType,
    /// File or media attachments referenced by URL.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    /// Shared ID for fan-out copies in group conversations.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Uuid>,
    /// Explicit metadata from the client (merged with server extraction).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<MessageMetadata>,
    /// UUID of the message this replies to (threading).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Uuid>,
}

/// Event dispatched to transport adapters for message delivery.
///
/// Contains all fields needed by webhook, SSE, or polling consumers
/// to deliver a message without additional database lookups.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryEvent {
    /// UUID of the message being delivered.
    pub message_id: Uuid,
    /// Conversation the message belongs to.
    pub conversation_id: Uuid,
    /// Agent ID of the sender.
    pub from_agent_id: String,
    /// Display name of the sender agent.
    pub from_agent_name: String,
    /// Agent ID of the recipient.
    pub to_agent_id: String,
    /// Message body.
    pub content: String,
    /// Content type of the message body.
    pub content_type: ContentType,
    /// Timestamp when the message was created.
    pub created_at: DateTime<Utc>,
    /// File or media attachments referenced by URL.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn test_message_roundtrip() {
        let now = Utc::now();
        let msg = Message {
            id: Uuid::new_v4(),
            conversation_id: Uuid::new_v4(),
            from_agent_id: "agent-a".into(),
            to_agent_id: "agent-b".into(),
            content: "Hello!".into(),
            content_type: ContentType::Text,
            status: MessageStatus::Pending,
            created_at: now,
            delivered_at: None,
            read_at: None,
            attachments: vec![],
            group_id: None,
            metadata: None,
            reply_to: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: Message = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.from_agent_id, "agent-a");
        assert_eq!(parsed.status, MessageStatus::Pending);
        assert_eq!(parsed.content_type, ContentType::Text);
        assert!(parsed.attachments.is_empty());
    }

    #[test]
    fn test_delivery_event_roundtrip() {
        let event = DeliveryEvent {
            message_id: Uuid::new_v4(),
            conversation_id: Uuid::new_v4(),
            from_agent_id: "sender".into(),
            from_agent_name: "Sender Agent".into(),
            to_agent_id: "receiver".into(),
            content: "Test message".into(),
            content_type: ContentType::Text,
            created_at: Utc::now(),
            attachments: vec![],
        };
        let json = serde_json::to_string(&event).unwrap();
        let parsed: DeliveryEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.from_agent_id, "sender");
        assert_eq!(parsed.from_agent_name, "Sender Agent");
        assert!(parsed.attachments.is_empty());
    }

    #[test]
    fn test_message_status_serde() {
        let json = serde_json::to_string(&MessageStatus::Delivered).unwrap();
        assert_eq!(json, "\"delivered\"");
        let parsed: MessageStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, MessageStatus::Delivered);
    }

    #[test]
    fn test_content_type_variants_serde() {
        let cases = [
            (ContentType::Text, "\"text\""),
            (ContentType::Image, "\"image\""),
            (ContentType::File, "\"file\""),
            (ContentType::Video, "\"video\""),
            (ContentType::Audio, "\"audio\""),
            (ContentType::Link, "\"link\""),
            (ContentType::RichText, "\"rich_text\""),
            (ContentType::Mixed, "\"mixed\""),
        ];
        for (variant, expected) in cases {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, expected);
        }
    }

    #[test]
    fn test_attachment_roundtrip() {
        let att = Attachment {
            id: Uuid::new_v4(),
            content_type: "image/png".into(),
            filename: Some("photo.png".into()),
            url: "https://example.com/photo.png".into(),
            size_bytes: Some(1024),
            checksum: Some("abc123".into()),
            metadata: None,
        };
        let json = serde_json::to_string(&att).unwrap();
        let parsed: Attachment = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.content_type, "image/png");
        assert_eq!(parsed.url, "https://example.com/photo.png");
        assert_eq!(parsed.size_bytes, Some(1024));
    }

    #[test]
    fn test_message_with_attachments_roundtrip() {
        let att = Attachment {
            id: Uuid::new_v4(),
            content_type: "image/jpeg".into(),
            filename: None,
            url: "https://cdn.example.com/img.jpg".into(),
            size_bytes: None,
            checksum: None,
            metadata: None,
        };
        let msg = Message {
            id: Uuid::new_v4(),
            conversation_id: Uuid::new_v4(),
            from_agent_id: "a".into(),
            to_agent_id: "b".into(),
            content: "See attached".into(),
            content_type: ContentType::Mixed,
            status: MessageStatus::Pending,
            created_at: Utc::now(),
            delivered_at: None,
            read_at: None,
            attachments: vec![att],
            group_id: None,
            metadata: None,
            reply_to: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: Message = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.attachments.len(), 1);
        assert_eq!(parsed.content_type, ContentType::Mixed);
    }

    #[test]
    fn test_metadata_merge() {
        let base = MessageMetadata {
            mentions: vec!["agent-a".into()],
            directives: vec!["action".into()],
            tags: vec!["deploy".into()],
            task_refs: vec!["T001".into()],
        };
        let other = MessageMetadata {
            mentions: vec!["agent-b".into(), "agent-a".into()],
            directives: vec!["review".into()],
            tags: vec!["deploy".into(), "ci".into()],
            task_refs: vec!["T002".into(), "T001".into()],
        };
        let merged = base.merge(other);
        assert_eq!(merged.mentions, vec!["agent-a", "agent-b"]);
        assert_eq!(merged.directives, vec!["action", "review"]);
        assert_eq!(merged.tags, vec!["deploy", "ci"]);
        assert_eq!(merged.task_refs, vec!["T001", "T002"]);
    }

    #[test]
    fn test_metadata_is_empty() {
        let empty = MessageMetadata::default();
        assert!(empty.is_empty());

        let non_empty = MessageMetadata {
            mentions: vec!["agent-a".into()],
            ..Default::default()
        };
        assert!(!non_empty.is_empty());
    }
}
