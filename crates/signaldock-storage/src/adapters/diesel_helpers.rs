//! Helper functions for the Diesel adapter.
//!
//! Conversion between Diesel model rows and domain types,
//! timestamp utilities, and error mapping.

use anyhow::Result;
use chrono::{DateTime, TimeZone, Utc};
use uuid::Uuid;

use signaldock_protocol::agent::{
    Agent, AgentClass, AgentStatus, PrivacyTier,
};
use signaldock_protocol::conversation::{Conversation, ConversationVisibility};
use signaldock_protocol::message::{ContentType, Message, MessageMetadata, MessageStatus};
use signaldock_protocol::user::User;
use signaldock_protocol::claim::ClaimCode;
use signaldock_protocol::connection::{Connection, ConnectionStatus};
use signaldock_protocol::delivery::{DeadLetter, DeliveryJob};

use crate::models::*;

// ── Timestamp helpers ───────────────────────────────────────────

/// Current Unix timestamp in seconds.
pub fn now_ts() -> i64 {
    Utc::now().timestamp()
}

/// Convert Unix timestamp to `DateTime<Utc>`.
pub fn ts_to_dt(ts: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(ts, 0).single().unwrap_or_default()
}

// ── Enum serialization ──────────────────────────────────────────

/// Serialize a serde enum variant to its string representation.
pub fn serialize_enum<T: serde::Serialize>(val: &T) -> String {
    let s = serde_json::to_string(val).unwrap_or_default();
    s.trim_matches('"').to_string()
}

/// Deserialize an enum from a string (with or without quotes).
pub fn parse_enum<T: serde::de::DeserializeOwned>(s: &str) -> T {
    // Try with quotes first, then without
    serde_json::from_str(&format!("\"{s}\""))
        .or_else(|_| serde_json::from_str(s))
        .unwrap_or_else(|_| serde_json::from_str("\"unknown\"").unwrap())
}

// ── Error mapping ───────────────────────────────────────────────

/// Map a deadpool pool error to anyhow.
pub fn pool_err(e: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("Connection pool error: {e}")
}

/// Map a diesel error to anyhow.
pub fn diesel_err(e: diesel::result::Error) -> anyhow::Error {
    anyhow::anyhow!("Database error: {e}")
}

// ── Row → Domain conversions ────────────────────────────────────

/// Convert an `AgentRow` to the domain `Agent` type.
pub fn agent_from_row(row: AgentRow) -> Agent {
    Agent {
        id: Uuid::parse_str(&row.id).unwrap_or_default(),
        agent_id: row.agent_id,
        name: row.name,
        description: row.description,
        class: parse_enum::<AgentClass>(&row.class),
        privacy_tier: parse_enum::<PrivacyTier>(&row.privacy_tier),
        owner_id: row.owner_id.and_then(|s| Uuid::parse_str(&s).ok()),
        endpoint: row.endpoint,
        webhook_secret: row.webhook_secret,
        capabilities: serde_json::from_str(&row.capabilities).unwrap_or_default(),
        skills: serde_json::from_str(&row.skills).unwrap_or_default(),
        avatar: row.avatar,
        messages_sent: row.messages_sent as u64,
        messages_received: row.messages_received as u64,
        conversation_count: row.conversation_count as u64,
        friend_count: row.friend_count as u64,
        status: parse_enum::<AgentStatus>(&row.status),
        last_seen: row.last_seen.map(ts_to_dt).unwrap_or_else(Utc::now),
        payment_config: row.payment_config.and_then(|s| serde_json::from_str(&s).ok()),
        api_key_hash: row.api_key_hash,
        organization_id: row.organization_id,
        created_at: ts_to_dt(row.created_at),
        updated_at: ts_to_dt(row.updated_at),
    }
}

/// Convert a `MessageRow` to the domain `Message` type.
pub fn message_from_row(row: MessageRow) -> Message {
    Message {
        id: Uuid::parse_str(&row.id).unwrap_or_default(),
        conversation_id: Uuid::parse_str(&row.conversation_id).unwrap_or_default(),
        from_agent_id: row.from_agent_id,
        to_agent_id: row.to_agent_id,
        content: row.content,
        content_type: parse_enum::<ContentType>(&row.content_type),
        status: parse_enum::<MessageStatus>(&row.status),
        attachments: serde_json::from_str(&row.attachments).unwrap_or_default(),
        group_id: row.group_id.and_then(|s| Uuid::parse_str(&s).ok()),
        metadata: row
            .metadata
            .and_then(|s| serde_json::from_str::<MessageMetadata>(&s).ok())
            .unwrap_or_default(),
        reply_to: row.reply_to.and_then(|s| Uuid::parse_str(&s).ok()),
        created_at: ts_to_dt(row.created_at),
        delivered_at: row.delivered_at.map(ts_to_dt),
        read_at: row.read_at.map(ts_to_dt),
    }
}

/// Convert a `ConversationRow` to the domain `Conversation` type.
pub fn conversation_from_row(row: ConversationRow) -> Conversation {
    Conversation {
        id: Uuid::parse_str(&row.id).unwrap_or_default(),
        participants: serde_json::from_str(&row.participants).unwrap_or_default(),
        visibility: parse_enum::<ConversationVisibility>(&row.visibility),
        message_count: row.message_count as u64,
        last_message_at: row.last_message_at.map(ts_to_dt),
        created_at: ts_to_dt(row.created_at),
        updated_at: ts_to_dt(row.updated_at),
    }
}

/// Convert a `UserRow` to the domain `User` type.
pub fn user_from_row(row: UserRow) -> User {
    User {
        id: Uuid::parse_str(&row.id).unwrap_or_default(),
        email: row.email,
        name: row.name,
        default_agent_id: row.default_agent_id,
        role: row.role,
        banned: row.banned,
        created_at: ts_to_dt(row.created_at),
        updated_at: ts_to_dt(row.updated_at),
    }
}

/// Convert a `ClaimCodeRow` to the domain `ClaimCode` type.
pub fn claim_from_row(row: ClaimCodeRow) -> ClaimCode {
    ClaimCode {
        id: Uuid::parse_str(&row.id).unwrap_or_default(),
        agent_id: Uuid::parse_str(&row.agent_id).unwrap_or_default(),
        code: row.code,
        expires_at: ts_to_dt(row.expires_at),
        used_at: row.used_at.map(ts_to_dt),
        used_by: row.used_by.and_then(|s| Uuid::parse_str(&s).ok()),
        created_at: ts_to_dt(row.created_at),
    }
}

/// Convert a `ConnectionRow` to the domain `Connection` type.
pub fn connection_from_row(row: ConnectionRow) -> Connection {
    Connection {
        id: Uuid::parse_str(&row.id).unwrap_or_default(),
        agent_a: Uuid::parse_str(&row.agent_a).unwrap_or_default(),
        agent_b: Uuid::parse_str(&row.agent_b).unwrap_or_default(),
        status: parse_enum::<ConnectionStatus>(&row.status),
        initiated_by: Uuid::parse_str(&row.initiated_by).unwrap_or_default(),
        created_at: ts_to_dt(row.created_at),
        updated_at: ts_to_dt(row.updated_at),
    }
}

/// Convert a `DeliveryJobRow` to the domain `DeliveryJob` type.
pub fn job_from_row(row: DeliveryJobRow) -> DeliveryJob {
    DeliveryJob {
        id: Uuid::parse_str(&row.id).unwrap_or_default(),
        message_id: Uuid::parse_str(&row.message_id).unwrap_or_default(),
        payload: row.payload,
        status: row.status,
        attempts: row.attempts as u32,
        max_attempts: row.max_attempts as u32,
        next_attempt_at: ts_to_dt(row.next_attempt_at),
        last_error: row.last_error,
        created_at: ts_to_dt(row.created_at),
        updated_at: ts_to_dt(row.updated_at),
    }
}
