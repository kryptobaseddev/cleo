//! Core domain model structs for users, agents, conversations, and connections.
//!
//! Each table follows the 3-struct pattern:
//! - `*Row` -- `#[derive(Queryable, Selectable)]` for reading
//! - `New*Row` -- `#[derive(Insertable)]` for creating
//! - `Update*Row` -- `#[derive(AsChangeset)]` for partial updates

use crate::schema::{agents, connections, conversations, users};
use diesel::prelude::*;

// ============================================================================
// Users
// ============================================================================

/// A row read from the `users` table.
#[derive(Queryable, Selectable, Debug, Clone)]
#[diesel(table_name = users)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct UserRow {
    /// Primary key (UUID as TEXT).
    pub id: String,
    /// Unique email address.
    pub email: String,
    /// Bcrypt/argon2 password hash.
    pub password_hash: String,
    /// Display name.
    pub name: Option<String>,
    /// URL-friendly slug (e.g. "keaton-hoskins").
    pub slug: Option<String>,
    /// Preferred sending agent (FK to agents.agent_id).
    pub default_agent_id: Option<String>,
    /// Username for login (better-auth).
    pub username: Option<String>,
    /// Case-preserved display username (better-auth).
    pub display_username: Option<String>,
    /// Whether email has been verified (better-auth).
    pub email_verified: bool,
    /// Profile image URL (better-auth).
    pub image: Option<String>,
    /// Role: "user", "admin", etc. (better-auth).
    pub role: String,
    /// Whether the account is banned (better-auth).
    pub banned: bool,
    /// Reason for ban, if any (better-auth).
    pub ban_reason: Option<String>,
    /// Ban expiration timestamp (better-auth).
    pub ban_expires: Option<String>,
    /// Whether 2FA is enabled (better-auth).
    pub two_factor_enabled: bool,
    /// Arbitrary JSON metadata (better-auth).
    pub metadata: Option<String>,
    /// Unix timestamp of creation.
    pub created_at: i64,
    /// Unix timestamp of last update.
    pub updated_at: i64,
}

/// Insert payload for the `users` table.
#[derive(Insertable, Debug)]
#[diesel(table_name = users)]
pub struct NewUserRow {
    /// Primary key (UUID as TEXT).
    pub id: String,
    /// Unique email address.
    pub email: String,
    /// Bcrypt/argon2 password hash.
    pub password_hash: String,
    /// Display name.
    pub name: Option<String>,
    /// URL-friendly slug.
    pub slug: Option<String>,
    /// Preferred sending agent.
    pub default_agent_id: Option<String>,
    /// Username for login.
    pub username: Option<String>,
    /// Case-preserved display username.
    pub display_username: Option<String>,
    /// Whether email has been verified.
    pub email_verified: bool,
    /// Profile image URL.
    pub image: Option<String>,
    /// Role: "user", "admin", etc.
    pub role: String,
    /// Whether the account is banned.
    pub banned: bool,
    /// Reason for ban, if any.
    pub ban_reason: Option<String>,
    /// Ban expiration timestamp.
    pub ban_expires: Option<String>,
    /// Whether 2FA is enabled.
    pub two_factor_enabled: bool,
    /// Arbitrary JSON metadata.
    pub metadata: Option<String>,
    /// Unix timestamp of creation.
    pub created_at: i64,
    /// Unix timestamp of last update.
    pub updated_at: i64,
}

/// Partial update payload for the `users` table.
#[derive(AsChangeset, Debug, Default)]
#[diesel(table_name = users)]
pub struct UpdateUserRow {
    /// Updated email address.
    pub email: Option<String>,
    /// Updated password hash.
    pub password_hash: Option<String>,
    /// Updated display name.
    pub name: Option<Option<String>>,
    /// Updated slug.
    pub slug: Option<Option<String>>,
    /// Updated default agent.
    pub default_agent_id: Option<Option<String>>,
    /// Updated username.
    pub username: Option<Option<String>>,
    /// Updated display username.
    pub display_username: Option<Option<String>>,
    /// Updated email verification status.
    pub email_verified: Option<bool>,
    /// Updated profile image URL.
    pub image: Option<Option<String>>,
    /// Updated role.
    pub role: Option<String>,
    /// Updated ban status.
    pub banned: Option<bool>,
    /// Updated ban reason.
    pub ban_reason: Option<Option<String>>,
    /// Updated ban expiration.
    pub ban_expires: Option<Option<String>>,
    /// Updated 2FA status.
    pub two_factor_enabled: Option<bool>,
    /// Updated metadata JSON.
    pub metadata: Option<Option<String>>,
    /// Updated timestamp.
    pub updated_at: Option<i64>,
}

// ============================================================================
// Agents
// ============================================================================

/// A row read from the `agents` table.
#[derive(Queryable, QueryableByName, Selectable, Debug, Clone)]
#[diesel(table_name = agents)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct AgentRow {
    /// Internal primary key (UUID as TEXT).
    pub id: String,
    /// Public-facing unique agent identifier.
    pub agent_id: String,
    /// Human-readable agent name.
    pub name: String,
    /// Optional description of the agent's purpose.
    pub description: Option<String>,
    /// Agent class: "custom", "system", etc.
    pub class: String,
    /// Privacy tier: "public", "private", "unlisted".
    pub privacy_tier: String,
    /// FK to the owning user.
    pub owner_id: Option<String>,
    /// Webhook delivery endpoint URL.
    pub endpoint: Option<String>,
    /// HMAC secret for webhook signature verification.
    pub webhook_secret: Option<String>,
    /// JSON array of capability slugs (legacy freetext).
    pub capabilities: String,
    /// JSON array of skill slugs (legacy freetext).
    pub skills: String,
    /// Avatar image URL.
    pub avatar: Option<String>,
    /// Running count of messages sent.
    pub messages_sent: i32,
    /// Running count of messages received.
    pub messages_received: i32,
    /// Running count of conversations participated in.
    pub conversation_count: i32,
    /// Running count of accepted connections.
    pub friend_count: i32,
    /// Current online status.
    pub status: String,
    /// Unix timestamp of last activity.
    pub last_seen: Option<i64>,
    /// JSON payment configuration.
    pub payment_config: Option<String>,
    /// SHA-256 hash of the agent API key.
    pub api_key_hash: Option<String>,
    /// FK to the owning organization.
    pub organization_id: Option<String>,
    /// Transport type: "http", "sse", or "websocket".
    pub transport_type: String,
    /// Encrypted API key (AES-256-GCM).
    pub api_key_encrypted: Option<String>,
    /// Base URL of the messaging API.
    pub api_base_url: String,
    /// Agent classification (e.g. "code_dev", "orchestrator").
    pub classification: Option<String>,
    /// JSON transport-specific configuration.
    pub transport_config: String,
    /// Whether this agent is currently active.
    pub is_active: bool,
    /// Unix timestamp of last use.
    pub last_used_at: Option<i64>,
    /// Unix timestamp of creation.
    pub created_at: i64,
    /// Unix timestamp of last update.
    pub updated_at: i64,
}

/// Insert payload for the `agents` table.
#[derive(Insertable, Debug)]
#[diesel(table_name = agents)]
pub struct NewAgentRow {
    /// Internal primary key.
    pub id: String,
    /// Public-facing unique agent identifier.
    pub agent_id: String,
    /// Human-readable agent name.
    pub name: String,
    /// Optional description.
    pub description: Option<String>,
    /// Agent class.
    pub class: String,
    /// Privacy tier.
    pub privacy_tier: String,
    /// FK to owning user.
    pub owner_id: Option<String>,
    /// Webhook delivery endpoint URL.
    pub endpoint: Option<String>,
    /// HMAC webhook secret.
    pub webhook_secret: Option<String>,
    /// JSON capability array.
    pub capabilities: String,
    /// JSON skill array.
    pub skills: String,
    /// Avatar URL.
    pub avatar: Option<String>,
    /// Initial messages sent count.
    pub messages_sent: i32,
    /// Initial messages received count.
    pub messages_received: i32,
    /// Initial conversation count.
    pub conversation_count: i32,
    /// Initial friend count.
    pub friend_count: i32,
    /// Initial online status.
    pub status: String,
    /// Last seen timestamp.
    pub last_seen: Option<i64>,
    /// Payment config JSON.
    pub payment_config: Option<String>,
    /// API key hash.
    pub api_key_hash: Option<String>,
    /// FK to organization.
    pub organization_id: Option<String>,
    /// Transport type.
    pub transport_type: String,
    /// Encrypted API key.
    pub api_key_encrypted: Option<String>,
    /// API base URL.
    pub api_base_url: String,
    /// Agent classification.
    pub classification: Option<String>,
    /// Transport config JSON.
    pub transport_config: String,
    /// Active flag.
    pub is_active: bool,
    /// Last used timestamp.
    pub last_used_at: Option<i64>,
    /// Creation timestamp.
    pub created_at: i64,
    /// Last update timestamp.
    pub updated_at: i64,
}

/// Partial update payload for the `agents` table.
#[derive(AsChangeset, Debug, Default)]
#[diesel(table_name = agents)]
pub struct UpdateAgentRow {
    /// Updated agent name.
    pub name: Option<String>,
    /// Updated description.
    pub description: Option<Option<String>>,
    /// Updated agent class.
    pub class: Option<String>,
    /// Updated privacy tier.
    pub privacy_tier: Option<String>,
    /// Updated endpoint URL.
    pub endpoint: Option<Option<String>>,
    /// Updated webhook secret.
    pub webhook_secret: Option<Option<String>>,
    /// Updated capabilities JSON array.
    pub capabilities: Option<String>,
    /// Updated skills JSON array.
    pub skills: Option<String>,
    /// Updated avatar URL.
    pub avatar: Option<Option<String>>,
    /// Updated messages sent count.
    pub messages_sent: Option<i32>,
    /// Updated messages received count.
    pub messages_received: Option<i32>,
    /// Updated conversation count.
    pub conversation_count: Option<i32>,
    /// Updated friend count.
    pub friend_count: Option<i32>,
    /// Updated online status.
    pub status: Option<String>,
    /// Updated last seen timestamp.
    pub last_seen: Option<Option<i64>>,
    /// Updated payment config JSON.
    pub payment_config: Option<Option<String>>,
    /// Updated API key hash.
    pub api_key_hash: Option<Option<String>>,
    /// Updated organization FK.
    pub organization_id: Option<Option<String>>,
    /// Updated transport type.
    pub transport_type: Option<String>,
    /// Updated encrypted API key.
    pub api_key_encrypted: Option<Option<String>>,
    /// Updated API base URL.
    pub api_base_url: Option<String>,
    /// Updated classification.
    pub classification: Option<Option<String>>,
    /// Updated transport config.
    pub transport_config: Option<String>,
    /// Updated active flag.
    pub is_active: Option<bool>,
    /// Updated last used timestamp.
    pub last_used_at: Option<Option<i64>>,
    /// Updated timestamp.
    pub updated_at: Option<i64>,
}

// ============================================================================
// Conversations
// ============================================================================

/// A row read from the `conversations` table.
#[derive(Queryable, Selectable, Debug, Clone)]
#[diesel(table_name = conversations)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct ConversationRow {
    /// Primary key (UUID as TEXT).
    pub id: String,
    /// JSON array of participant agent IDs.
    pub participants: String,
    /// Visibility: "private" or "public".
    pub visibility: String,
    /// Running message count.
    pub message_count: i32,
    /// Unix timestamp of the most recent message.
    pub last_message_at: Option<i64>,
    /// Unix timestamp of creation.
    pub created_at: i64,
    /// Unix timestamp of last update.
    pub updated_at: i64,
}

/// Insert payload for the `conversations` table.
#[derive(Insertable, Debug)]
#[diesel(table_name = conversations)]
pub struct NewConversationRow {
    /// Primary key.
    pub id: String,
    /// JSON participant array.
    pub participants: String,
    /// Visibility level.
    pub visibility: String,
    /// Initial message count.
    pub message_count: i32,
    /// Last message timestamp.
    pub last_message_at: Option<i64>,
    /// Creation timestamp.
    pub created_at: i64,
    /// Last update timestamp.
    pub updated_at: i64,
}

/// Partial update payload for the `conversations` table.
#[derive(AsChangeset, Debug, Default)]
#[diesel(table_name = conversations)]
pub struct UpdateConversationRow {
    /// Updated participants JSON.
    pub participants: Option<String>,
    /// Updated visibility.
    pub visibility: Option<String>,
    /// Updated message count.
    pub message_count: Option<i32>,
    /// Updated last message timestamp.
    pub last_message_at: Option<Option<i64>>,
    /// Updated timestamp.
    pub updated_at: Option<i64>,
}

// ============================================================================
// Connections
// ============================================================================

/// A row read from the `connections` table.
#[derive(Queryable, Selectable, Debug, Clone)]
#[diesel(table_name = connections)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct ConnectionRow {
    /// Primary key (UUID as TEXT).
    pub id: String,
    /// First agent in the connection (FK to agents.id).
    pub agent_a: String,
    /// Second agent in the connection (FK to agents.id).
    pub agent_b: String,
    /// Connection status: "pending", "accepted", "rejected".
    pub status: String,
    /// Agent ID that initiated the connection request.
    pub initiated_by: String,
    /// Unix timestamp of creation.
    pub created_at: i64,
    /// Unix timestamp of last update.
    pub updated_at: i64,
}

/// Insert payload for the `connections` table.
#[derive(Insertable, Debug)]
#[diesel(table_name = connections)]
pub struct NewConnectionRow {
    /// Primary key.
    pub id: String,
    /// First agent ID.
    pub agent_a: String,
    /// Second agent ID.
    pub agent_b: String,
    /// Initial status.
    pub status: String,
    /// Initiating agent ID.
    pub initiated_by: String,
    /// Creation timestamp.
    pub created_at: i64,
    /// Last update timestamp.
    pub updated_at: i64,
}

/// Partial update payload for the `connections` table.
#[derive(AsChangeset, Debug, Default)]
#[diesel(table_name = connections)]
pub struct UpdateConnectionRow {
    /// Updated connection status.
    pub status: Option<String>,
    /// Updated timestamp.
    pub updated_at: Option<i64>,
}
