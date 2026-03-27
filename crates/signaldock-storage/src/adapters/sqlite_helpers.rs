use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::Row;
use sqlx::sqlite::SqliteRow;
use uuid::Uuid;

use signaldock_protocol::{
    agent::{Agent, AgentClass, AgentStats, AgentStatus, PrivacyTier},
    claim::ClaimCode,
    connection::{Connection, ConnectionStatus},
    conversation::{Conversation, ConversationVisibility},
    message::{Attachment, ContentType, Message, MessageStatus},
    user::User,
};

pub(crate) fn serialize_enum<T: serde::Serialize>(val: &T) -> String {
    let json = serde_json::to_string(val).unwrap_or_default();
    json.trim_matches('"').to_string()
}

pub(crate) fn parse_agent_class(s: &str) -> AgentClass {
    serde_json::from_str(&format!("\"{s}\"")).unwrap_or(AgentClass::Custom)
}

pub(crate) fn parse_privacy_tier(s: &str) -> PrivacyTier {
    serde_json::from_str(&format!("\"{s}\"")).unwrap_or(PrivacyTier::Public)
}

pub(crate) fn parse_agent_status(s: &str) -> AgentStatus {
    serde_json::from_str(&format!("\"{s}\"")).unwrap_or(AgentStatus::Online)
}

pub(crate) fn parse_message_status(s: &str) -> MessageStatus {
    serde_json::from_str(&format!("\"{s}\"")).unwrap_or(MessageStatus::Pending)
}

pub(crate) fn parse_content_type(s: &str) -> ContentType {
    serde_json::from_str(&format!("\"{s}\"")).unwrap_or(ContentType::Text)
}

pub(crate) fn parse_visibility(s: &str) -> ConversationVisibility {
    serde_json::from_str(&format!("\"{s}\"")).unwrap_or(ConversationVisibility::Private)
}

pub(crate) fn parse_connection_status(s: &str) -> ConnectionStatus {
    serde_json::from_str(&format!("\"{s}\"")).unwrap_or(ConnectionStatus::Pending)
}

/// Convert a Unix timestamp (seconds) to a UTC `DateTime`.
pub fn ts_to_dt(ts: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(ts, 0).unwrap_or_default()
}

pub(crate) fn dt_to_ts(dt: DateTime<Utc>) -> i64 {
    dt.timestamp()
}

pub(crate) fn now_ts() -> i64 {
    Utc::now().timestamp()
}

pub(crate) fn row_to_agent(row: &SqliteRow) -> Result<Agent> {
    let id: String = row.get("id");
    let caps_json: String = row.get("capabilities");
    let skills_json: String = row.get("skills");
    let owner_id_str: Option<String> = row.get("owner_id");
    let last_seen: Option<i64> = row.get("last_seen");

    Ok(Agent {
        id: Uuid::parse_str(&id).context("invalid agent id")?,
        agent_id: row.get("agent_id"),
        name: row.get("name"),
        description: row.get("description"),
        class: parse_agent_class(row.get::<&str, _>("class")),
        privacy_tier: parse_privacy_tier(row.get::<&str, _>("privacy_tier")),
        owner_id: owner_id_str
            .as_deref()
            .map(Uuid::parse_str)
            .transpose()
            .context("invalid owner_id")?,
        endpoint: row.get("endpoint"),
        webhook_secret: row.get("webhook_secret"),
        capabilities: serde_json::from_str(&caps_json).unwrap_or_default(),
        skills: serde_json::from_str(&skills_json).unwrap_or_default(),
        avatar: row.get("avatar"),
        stats: AgentStats {
            messages_sent: row.get::<i64, _>("messages_sent"),
            messages_received: row.get::<i64, _>("messages_received"),
            conversation_count: row.get::<i64, _>("conversation_count"),
            friend_count: row.get::<i64, _>("friend_count"),
        },
        status: parse_agent_status(row.get::<&str, _>("status")),
        is_claimed: owner_id_str.is_some(),
        last_seen: ts_to_dt(last_seen.unwrap_or(0)),
        created_at: ts_to_dt(row.get::<i64, _>("created_at")),
        updated_at: ts_to_dt(row.get::<i64, _>("updated_at")),
        payment_config: row
            .try_get::<String, _>("payment_config")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok()),
        api_key_hash: row.try_get("api_key_hash").unwrap_or(None),
        organization_id: row.try_get("organization_id").unwrap_or(None),
    })
}

/// Reconstructs a [`Message`] from a `SQLite` row.
///
/// # Errors
///
/// Returns `anyhow::Error` if UUID parsing or column extraction fails.
pub fn row_to_message(row: &SqliteRow) -> Result<Message> {
    let id: String = row.get("id");
    let conv_id: String = row.get("conversation_id");
    let delivered_at: Option<i64> = row.get("delivered_at");
    let read_at: Option<i64> = row.get("read_at");
    let attachments_json: String = row
        .try_get("attachments")
        .unwrap_or_else(|_| "[]".to_string());
    let attachments: Vec<Attachment> = serde_json::from_str(&attachments_json).unwrap_or_default();
    let group_id: Option<String> = row.try_get("group_id").unwrap_or(None);

    Ok(Message {
        id: Uuid::parse_str(&id)?,
        conversation_id: Uuid::parse_str(&conv_id)?,
        from_agent_id: row.get("from_agent_id"),
        to_agent_id: row.get("to_agent_id"),
        content: row.get("content"),
        content_type: parse_content_type(row.get::<&str, _>("content_type")),
        status: parse_message_status(row.get::<&str, _>("status")),
        created_at: ts_to_dt(row.get::<i64, _>("created_at")),
        delivered_at: delivered_at.map(ts_to_dt),
        read_at: read_at.map(ts_to_dt),
        attachments,
        group_id: group_id.and_then(|s| Uuid::parse_str(&s).ok()),
        metadata: row
            .try_get::<String, _>("metadata")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok()),
        reply_to: row
            .try_get::<Option<String>, _>("reply_to")
            .unwrap_or(None)
            .and_then(|s| Uuid::parse_str(&s).ok()),
    })
}

pub(crate) fn row_to_conversation(row: &SqliteRow) -> Result<Conversation> {
    let id: String = row.get("id");
    let participants_json: String = row.get("participants");
    let last_message_at: Option<i64> = row.get("last_message_at");

    Ok(Conversation {
        id: Uuid::parse_str(&id)?,
        participants: serde_json::from_str(&participants_json).unwrap_or_default(),
        visibility: parse_visibility(row.get::<&str, _>("visibility")),
        message_count: row.get::<i64, _>("message_count"),
        last_message_at: last_message_at.map(ts_to_dt),
        created_at: ts_to_dt(row.get::<i64, _>("created_at")),
        updated_at: ts_to_dt(row.get::<i64, _>("updated_at")),
    })
}

pub(crate) fn row_to_user(row: &SqliteRow) -> Result<User> {
    let id: String = row.get("id");
    Ok(User {
        id: Uuid::parse_str(&id)?,
        email: row.get("email"),
        name: row.get("name"),
        default_agent_id: row.try_get("default_agent_id").ok().flatten(),
        created_at: ts_to_dt(row.get::<i64, _>("created_at")),
        updated_at: ts_to_dt(row.get::<i64, _>("updated_at")),
    })
}

pub(crate) fn row_to_claim_code(row: &SqliteRow) -> Result<ClaimCode> {
    let id: String = row.get("id");
    let agent_id: String = row.get("agent_id");
    let used_at: Option<i64> = row.get("used_at");
    let used_by: Option<String> = row.get("used_by");

    Ok(ClaimCode {
        id: Uuid::parse_str(&id)?,
        agent_id: Uuid::parse_str(&agent_id)?,
        code: row.get("code"),
        expires_at: ts_to_dt(row.get::<i64, _>("expires_at")),
        used_at: used_at.map(ts_to_dt),
        used_by: used_by.as_deref().map(Uuid::parse_str).transpose()?,
        created_at: ts_to_dt(row.get::<i64, _>("created_at")),
    })
}

pub(crate) fn row_to_connection(row: &SqliteRow) -> Result<Connection> {
    let id: String = row.get("id");
    let agent_a: String = row.get("agent_a");
    let agent_b: String = row.get("agent_b");

    Ok(Connection {
        id: Uuid::parse_str(&id)?,
        agent_a: Uuid::parse_str(&agent_a)?,
        agent_b: Uuid::parse_str(&agent_b)?,
        status: parse_connection_status(row.get::<&str, _>("status")),
        initiated_by: row.get("initiated_by"),
        created_at: ts_to_dt(row.get::<i64, _>("created_at")),
        updated_at: ts_to_dt(row.get::<i64, _>("updated_at")),
    })
}
