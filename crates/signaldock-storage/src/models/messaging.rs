//! Messaging domain model structs for messages, claim codes, delivery jobs,
//! and dead letters.
//!
//! Each table follows the 3-struct pattern:
//! - `*Row` -- `#[derive(Queryable, Selectable)]` for reading
//! - `New*Row` -- `#[derive(Insertable)]` for creating
//! - `Update*Row` -- `#[derive(AsChangeset)]` for partial updates

use crate::schema::{claim_codes, dead_letters, delivery_jobs, messages};
use diesel::prelude::*;

// ============================================================================
// Messages
// ============================================================================

/// A row read from the `messages` table.
#[derive(Queryable, Selectable, Debug, Clone)]
#[diesel(table_name = messages)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct MessageRow {
    /// Primary key (UUID as TEXT).
    pub id: String,
    /// FK to the parent conversation.
    pub conversation_id: String,
    /// Agent ID that sent the message.
    pub from_agent_id: String,
    /// Agent ID that receives the message.
    pub to_agent_id: String,
    /// Message body content.
    pub content: String,
    /// MIME-like content type: "text", "json", etc.
    pub content_type: String,
    /// Delivery status: "pending", "delivered", "read".
    pub status: String,
    /// JSON array of attachment references.
    pub attachments: String,
    /// Deduplication group ID for fan-out copies (NULL for 1-on-1).
    pub group_id: Option<String>,
    /// JSON metadata for @mentions, /directives, #tags.
    pub metadata: Option<String>,
    /// ID of the message this replies to (threading).
    pub reply_to: Option<String>,
    /// Unix timestamp of creation.
    pub created_at: i64,
    /// Unix timestamp of delivery.
    pub delivered_at: Option<i64>,
    /// Unix timestamp of first read.
    pub read_at: Option<i64>,
}

/// Insert payload for the `messages` table.
#[derive(Insertable, Debug)]
#[diesel(table_name = messages)]
pub struct NewMessageRow {
    /// Primary key.
    pub id: String,
    /// FK to conversation.
    pub conversation_id: String,
    /// Sender agent ID.
    pub from_agent_id: String,
    /// Recipient agent ID.
    pub to_agent_id: String,
    /// Message body.
    pub content: String,
    /// Content type.
    pub content_type: String,
    /// Initial delivery status.
    pub status: String,
    /// Attachment references JSON.
    pub attachments: String,
    /// Fan-out group ID.
    pub group_id: Option<String>,
    /// Extracted metadata JSON.
    pub metadata: Option<String>,
    /// Reply-to message ID.
    pub reply_to: Option<String>,
    /// Creation timestamp.
    pub created_at: i64,
    /// Delivery timestamp.
    pub delivered_at: Option<i64>,
    /// Read timestamp.
    pub read_at: Option<i64>,
}

/// Partial update payload for the `messages` table.
#[derive(AsChangeset, Debug, Default)]
#[diesel(table_name = messages)]
pub struct UpdateMessageRow {
    /// Updated delivery status.
    pub status: Option<String>,
    /// Updated metadata JSON.
    pub metadata: Option<Option<String>>,
    /// Updated delivery timestamp.
    pub delivered_at: Option<Option<i64>>,
    /// Updated read timestamp.
    pub read_at: Option<Option<i64>>,
}

// ============================================================================
// Claim Codes
// ============================================================================

/// A row read from the `claim_codes` table.
#[derive(Queryable, Selectable, Debug, Clone)]
#[diesel(table_name = claim_codes)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct ClaimCodeRow {
    /// Primary key (UUID as TEXT).
    pub id: String,
    /// FK to the agent being claimed.
    pub agent_id: String,
    /// Unique claim code string.
    pub code: String,
    /// Unix timestamp when the code expires.
    pub expires_at: i64,
    /// Unix timestamp when the code was used (NULL if unused).
    pub used_at: Option<i64>,
    /// FK to the user who redeemed the code (NULL if unused).
    pub used_by: Option<String>,
    /// Unix timestamp of creation.
    pub created_at: i64,
}

/// Insert payload for the `claim_codes` table.
#[derive(Insertable, Debug)]
#[diesel(table_name = claim_codes)]
pub struct NewClaimCodeRow {
    /// Primary key.
    pub id: String,
    /// FK to agent.
    pub agent_id: String,
    /// Unique claim code.
    pub code: String,
    /// Expiration timestamp.
    pub expires_at: i64,
    /// Usage timestamp.
    pub used_at: Option<i64>,
    /// Redeeming user FK.
    pub used_by: Option<String>,
    /// Creation timestamp.
    pub created_at: i64,
}

/// Partial update payload for the `claim_codes` table.
#[derive(AsChangeset, Debug, Default)]
#[diesel(table_name = claim_codes)]
pub struct UpdateClaimCodeRow {
    /// Updated usage timestamp.
    pub used_at: Option<Option<i64>>,
    /// Updated redeeming user.
    pub used_by: Option<Option<String>>,
}

// ============================================================================
// Delivery Jobs
// ============================================================================

/// A row read from the `delivery_jobs` table.
#[derive(Queryable, Selectable, Debug, Clone)]
#[diesel(table_name = delivery_jobs)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct DeliveryJobRow {
    /// Primary key (UUID as TEXT).
    pub id: String,
    /// FK to the message being delivered.
    pub message_id: String,
    /// Serialized delivery payload (JSON).
    pub payload: String,
    /// Job status: "pending", "in_progress", "completed", "failed".
    pub status: String,
    /// Number of delivery attempts made.
    pub attempts: i32,
    /// Maximum retry attempts before dead-lettering.
    pub max_attempts: i32,
    /// Unix timestamp of the next scheduled attempt.
    pub next_attempt_at: i64,
    /// Error message from the last failed attempt.
    pub last_error: Option<String>,
    /// Unix timestamp of creation.
    pub created_at: i64,
    /// Unix timestamp of last update.
    pub updated_at: i64,
}

/// Insert payload for the `delivery_jobs` table.
#[derive(Insertable, Debug)]
#[diesel(table_name = delivery_jobs)]
pub struct NewDeliveryJobRow {
    /// Primary key.
    pub id: String,
    /// FK to message.
    pub message_id: String,
    /// Delivery payload JSON.
    pub payload: String,
    /// Initial job status.
    pub status: String,
    /// Initial attempt count.
    pub attempts: i32,
    /// Maximum retries.
    pub max_attempts: i32,
    /// Next attempt timestamp.
    pub next_attempt_at: i64,
    /// Last error message.
    pub last_error: Option<String>,
    /// Creation timestamp.
    pub created_at: i64,
    /// Last update timestamp.
    pub updated_at: i64,
}

/// Partial update payload for the `delivery_jobs` table.
#[derive(AsChangeset, Debug, Default)]
#[diesel(table_name = delivery_jobs)]
pub struct UpdateDeliveryJobRow {
    /// Updated job status.
    pub status: Option<String>,
    /// Updated attempt count.
    pub attempts: Option<i32>,
    /// Updated next attempt timestamp.
    pub next_attempt_at: Option<i64>,
    /// Updated error message.
    pub last_error: Option<Option<String>>,
    /// Updated timestamp.
    pub updated_at: Option<i64>,
}

// ============================================================================
// Dead Letters
// ============================================================================

/// A row read from the `dead_letters` table.
#[derive(Queryable, Selectable, Debug, Clone)]
#[diesel(table_name = dead_letters)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct DeadLetterRow {
    /// Primary key (UUID as TEXT).
    pub id: String,
    /// FK to the original message.
    pub message_id: String,
    /// FK to the delivery job that failed.
    pub job_id: String,
    /// Human-readable failure reason.
    pub reason: String,
    /// Total number of delivery attempts made.
    pub attempts: i32,
    /// Unix timestamp of dead-letter creation.
    pub created_at: i64,
}

/// Insert payload for the `dead_letters` table.
#[derive(Insertable, Debug)]
#[diesel(table_name = dead_letters)]
pub struct NewDeadLetterRow {
    /// Primary key.
    pub id: String,
    /// FK to message.
    pub message_id: String,
    /// FK to delivery job.
    pub job_id: String,
    /// Failure reason.
    pub reason: String,
    /// Total attempts.
    pub attempts: i32,
    /// Creation timestamp.
    pub created_at: i64,
}
