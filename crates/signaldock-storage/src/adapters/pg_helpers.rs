use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::Row;
use sqlx::postgres::PgRow;
use uuid::Uuid;

use signaldock_protocol::{
    agent::{Agent, AgentClass, AgentStats, AgentStatus, PrivacyTier},
    claim::ClaimCode,
    connection::{Connection, ConnectionStatus},
    conversation::{Conversation, ConversationVisibility},
    message::{Attachment, ContentType, Message, MessageStatus},
    user::User,
};

// --- Enum string conversions ---

/// Parses a database string into an [`AgentClass`] enum variant.
pub fn parse_agent_class(s: &str) -> AgentClass {
    match s {
        "personal_assistant" => AgentClass::PersonalAssistant,
        "code_dev" => AgentClass::CodeDev,
        "research" => AgentClass::Research,
        "orchestrator" => AgentClass::Orchestrator,
        "security" => AgentClass::Security,
        "devops" => AgentClass::Devops,
        "data" => AgentClass::Data,
        "creative" => AgentClass::Creative,
        "support" => AgentClass::Support,
        "testing" => AgentClass::Testing,
        "documentation" => AgentClass::Documentation,
        "utility_bot" => AgentClass::UtilityBot,
        _ => AgentClass::Custom,
    }
}

/// Converts an [`AgentClass`] enum variant to its database string representation.
pub fn agent_class_to_str(c: &AgentClass) -> &'static str {
    match c {
        AgentClass::PersonalAssistant => "personal_assistant",
        AgentClass::CodeDev => "code_dev",
        AgentClass::Research => "research",
        AgentClass::Orchestrator => "orchestrator",
        AgentClass::Security => "security",
        AgentClass::Devops => "devops",
        AgentClass::Data => "data",
        AgentClass::Creative => "creative",
        AgentClass::Support => "support",
        AgentClass::Testing => "testing",
        AgentClass::Documentation => "documentation",
        AgentClass::UtilityBot => "utility_bot",
        AgentClass::Custom => "custom",
    }
}

/// Parses a database string into a [`PrivacyTier`] enum variant.
pub fn parse_privacy_tier(s: &str) -> PrivacyTier {
    match s {
        "public" => PrivacyTier::Public,
        "discoverable" => PrivacyTier::Discoverable,
        _ => PrivacyTier::Private,
    }
}

/// Converts a [`PrivacyTier`] enum variant to its database string representation.
pub fn privacy_tier_to_str(p: &PrivacyTier) -> &'static str {
    match p {
        PrivacyTier::Public => "public",
        PrivacyTier::Discoverable => "discoverable",
        PrivacyTier::Private => "private",
    }
}

/// Parses a database string into an [`AgentStatus`] enum variant.
pub fn parse_agent_status(s: &str) -> AgentStatus {
    match s {
        "online" => AgentStatus::Online,
        "busy" => AgentStatus::Busy,
        _ => AgentStatus::Offline,
    }
}

/// Converts an [`AgentStatus`] enum variant to its database string representation.
pub fn agent_status_to_str(s: &AgentStatus) -> &'static str {
    match s {
        AgentStatus::Online => "online",
        AgentStatus::Offline => "offline",
        AgentStatus::Busy => "busy",
    }
}

/// Parses a database string into a [`MessageStatus`] enum variant.
pub fn parse_message_status(s: &str) -> MessageStatus {
    match s {
        "delivered" => MessageStatus::Delivered,
        "read" => MessageStatus::Read,
        _ => MessageStatus::Pending,
    }
}

/// Parses a database string into a [`ContentType`] enum variant.
pub fn parse_content_type(s: &str) -> ContentType {
    match s {
        "image" => ContentType::Image,
        "file" => ContentType::File,
        "video" => ContentType::Video,
        "audio" => ContentType::Audio,
        "link" => ContentType::Link,
        "rich_text" => ContentType::RichText,
        "mixed" => ContentType::Mixed,
        _ => ContentType::Text,
    }
}

/// Converts a [`ContentType`] enum variant to its database string representation.
pub fn content_type_to_str(c: &ContentType) -> &'static str {
    match c {
        ContentType::Text => "text",
        ContentType::Image => "image",
        ContentType::File => "file",
        ContentType::Video => "video",
        ContentType::Audio => "audio",
        ContentType::Link => "link",
        ContentType::RichText => "rich_text",
        ContentType::Mixed => "mixed",
    }
}

/// Parses a database string into a [`ConversationVisibility`] enum variant.
pub fn parse_conversation_visibility(s: &str) -> ConversationVisibility {
    match s {
        "public" => ConversationVisibility::Public,
        _ => ConversationVisibility::Private,
    }
}

/// Parses a database string into a [`ConnectionStatus`] enum variant.
pub fn parse_connection_status(s: &str) -> ConnectionStatus {
    match s {
        "accepted" => ConnectionStatus::Accepted,
        "rejected" => ConnectionStatus::Rejected,
        _ => ConnectionStatus::Pending,
    }
}

/// Converts a [`ConnectionStatus`] enum variant to its database string representation.
pub fn connection_status_to_str(s: &ConnectionStatus) -> &'static str {
    match s {
        ConnectionStatus::Pending => "pending",
        ConnectionStatus::Accepted => "accepted",
        ConnectionStatus::Rejected => "rejected",
    }
}

// --- Row mapping helpers ---

/// Reconstructs an [`Agent`] from a `PostgreSQL` row.
pub fn agent_from_row(row: &PgRow) -> Result<Agent> {
    let caps_json: serde_json::Value = row.try_get("capabilities")?;
    let skills_json: serde_json::Value = row.try_get("skills")?;
    let capabilities: Vec<String> = serde_json::from_value(caps_json)?;
    let skills: Vec<String> = serde_json::from_value(skills_json)?;
    let owner_id: Option<Uuid> = row.try_get("owner_id")?;
    let last_seen: Option<DateTime<Utc>> = row.try_get("last_seen")?;

    Ok(Agent {
        id: row.try_get("id")?,
        agent_id: row.try_get("agent_id")?,
        name: row.try_get("name")?,
        description: row.try_get("description")?,
        class: parse_agent_class(row.try_get::<&str, _>("class")?),
        privacy_tier: parse_privacy_tier(row.try_get::<&str, _>("privacy_tier")?),
        owner_id,
        endpoint: row.try_get("endpoint")?,
        webhook_secret: row.try_get("webhook_secret")?,
        capabilities,
        skills,
        avatar: row.try_get("avatar")?,
        stats: AgentStats {
            messages_sent: row.try_get("messages_sent")?,
            messages_received: row.try_get("messages_received")?,
            conversation_count: row.try_get("conversation_count")?,
            friend_count: row.try_get("friend_count")?,
        },
        status: parse_agent_status(row.try_get::<&str, _>("status")?),
        is_claimed: owner_id.is_some(),
        last_seen: last_seen.unwrap_or_else(Utc::now),
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        payment_config: row.try_get("payment_config").ok(),
        api_key_hash: row.try_get("api_key_hash").unwrap_or(None),
        organization_id: row.try_get("organization_id").unwrap_or(None),
    })
}

/// Reconstructs a [`Message`] from a `PostgreSQL` row.
pub fn message_from_row(row: &PgRow) -> Result<Message> {
    let attachments_val: serde_json::Value = row
        .try_get("attachments")
        .unwrap_or(serde_json::Value::Array(vec![]));
    let attachments: Vec<Attachment> = serde_json::from_value(attachments_val).unwrap_or_default();

    Ok(Message {
        id: row.try_get("id")?,
        conversation_id: row.try_get("conversation_id")?,
        from_agent_id: row.try_get("from_agent_id")?,
        to_agent_id: row.try_get("to_agent_id")?,
        content: row.try_get("content")?,
        content_type: parse_content_type(row.try_get::<&str, _>("content_type")?),
        status: parse_message_status(row.try_get::<&str, _>("status")?),
        created_at: row.try_get("created_at")?,
        delivered_at: row.try_get("delivered_at")?,
        read_at: row.try_get("read_at")?,
        attachments,
        group_id: row.try_get("group_id").unwrap_or(None),
        metadata: row
            .try_get::<serde_json::Value, _>("metadata")
            .ok()
            .and_then(|v| serde_json::from_value(v).ok()),
        reply_to: row.try_get("reply_to").unwrap_or(None),
    })
}

/// Reconstructs a [`Conversation`] from a `PostgreSQL` row.
pub fn conversation_from_row(row: &PgRow) -> Result<Conversation> {
    let pjson: serde_json::Value = row.try_get("participants")?;
    let participants: Vec<String> = serde_json::from_value(pjson)?;

    Ok(Conversation {
        id: row.try_get("id")?,
        participants,
        visibility: parse_conversation_visibility(row.try_get::<&str, _>("visibility")?),
        message_count: row.try_get("message_count")?,
        last_message_at: row.try_get("last_message_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// Reconstructs a [`User`] from a `PostgreSQL` row.
pub fn user_from_row(row: &PgRow) -> Result<User> {
    Ok(User {
        id: row.try_get("id")?,
        email: row.try_get("email")?,
        name: row.try_get("name")?,
        default_agent_id: row.try_get("default_agent_id").unwrap_or(None),
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// Reconstructs a [`ClaimCode`] from a `PostgreSQL` row.
pub fn claim_from_row(row: &PgRow) -> Result<ClaimCode> {
    Ok(ClaimCode {
        id: row.try_get("id")?,
        agent_id: row.try_get("agent_id")?,
        code: row.try_get("code")?,
        expires_at: row.try_get("expires_at")?,
        used_at: row.try_get("used_at")?,
        used_by: row.try_get("used_by")?,
        created_at: row.try_get("created_at")?,
    })
}

/// Reconstructs a [`Connection`] from a `PostgreSQL` row.
pub fn connection_from_row(row: &PgRow) -> Result<Connection> {
    Ok(Connection {
        id: row.try_get("id")?,
        agent_a: row.try_get("agent_a")?,
        agent_b: row.try_get("agent_b")?,
        status: parse_connection_status(row.try_get::<&str, _>("status")?),
        initiated_by: row.try_get("initiated_by")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}
