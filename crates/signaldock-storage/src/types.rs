//! Pagination, query filters, and atomic stats deltas.
//!
//! These types are used as parameters and return values
//! across all repository trait methods in [`crate::traits`].

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use signaldock_protocol::agent::{AgentClass, AgentStatus, PrivacyTier};
use uuid::Uuid;

/// A paginated result set wrapping a `Vec<T>` with metadata.
///
/// Returned by repository `list` methods to convey items
/// alongside total count, current page, and page size.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page<T> {
    /// The items on this page.
    pub items: Vec<T>,
    /// Total number of items across all pages.
    pub total: u64,
    /// The current 1-based page number.
    pub page: u32,
    /// Maximum items per page.
    pub limit: u32,
}

impl<T> Page<T> {
    /// Creates a new [`Page`] from its constituent parts.
    pub fn new(items: Vec<T>, total: u64, page: u32, limit: u32) -> Self {
        Self {
            items,
            total,
            page,
            limit,
        }
    }

    /// Returns the total number of pages.
    ///
    /// Returns 0 when `limit` is 0 to avoid division by zero.
    pub fn total_pages(&self) -> u32 {
        if self.limit == 0 {
            return 0;
        }
        ((self.total as f64) / (self.limit as f64)).ceil() as u32
    }

    /// Returns `true` if there is a subsequent page.
    pub fn has_next(&self) -> bool {
        self.page < self.total_pages()
    }
}

/// Sort field for agent queries.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum AgentSortField {
    /// Sort by creation time (default).
    #[default]
    Created,
    /// Sort by total messages sent.
    Messages,
    /// Sort by last seen timestamp.
    LastSeen,
}

/// Query parameters for listing and filtering agents.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentQuery {
    /// Free-text search across name, `agent_id`, and
    /// description.
    pub search: Option<String>,
    /// Filter by [`AgentClass`].
    pub class: Option<AgentClass>,
    /// Filter by [`PrivacyTier`].
    pub privacy_tier: Option<PrivacyTier>,
    /// Filter by owner (user) UUID.
    pub owner_id: Option<uuid::Uuid>,
    /// Filter by [`AgentStatus`].
    pub status: Option<AgentStatus>,
    /// Filter to agents that declare this capability.
    pub capability: Option<String>,
    /// Filter to agents that declare this skill.
    pub skill: Option<String>,
    /// Filter by organization ID.
    pub organization_id: Option<String>,
    /// Sort field for results.
    #[serde(skip)]
    pub sort: AgentSortField,
    /// 1-based page number.
    pub page: u32,
    /// Maximum results per page.
    pub limit: u32,
}

impl AgentQuery {
    /// Computes the SQL `OFFSET` from `page` and `limit`.
    ///
    /// Page 0 and page 1 both return offset 0.
    pub fn offset(&self) -> u32 {
        if self.page == 0 {
            return 0;
        }
        (self.page.saturating_sub(1)) * self.limit
    }
}

/// Sort direction for query results.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SortDirection {
    /// Oldest first (default).
    #[default]
    Asc,
    /// Newest first.
    Desc,
}

/// Query parameters for listing messages.
#[derive(Debug, Clone, Default)]
pub struct MessageQuery {
    /// Restrict to a specific conversation.
    pub conversation_id: Option<uuid::Uuid>,
    /// Restrict to messages addressed to this agent slug.
    pub to_agent_id: Option<String>,
    /// Only return messages created after this message ID.
    pub since_message_id: Option<uuid::Uuid>,
    /// Filter to messages that @mention this agent ID.
    pub mentioned: Option<String>,
    /// Only return messages created after this ISO 8601 timestamp.
    pub after_timestamp: Option<DateTime<Utc>>,
    /// Sort direction for results.
    pub sort: SortDirection,
    /// 1-based page number.
    pub page: u32,
    /// Maximum results per page.
    pub limit: u32,
}

/// Query parameters for listing conversations.
#[derive(Debug, Clone, Default)]
pub struct ConversationQuery {
    /// Filter to conversations that include this agent slug.
    pub participant_agent_id: Option<String>,
    /// 1-based page number.
    pub page: u32,
    /// Maximum results per page.
    pub limit: u32,
}

/// Atomic stats increment delta for agent counters.
///
/// Used with [`AgentRepository::increment_stats`] to
/// atomically adjust one or more counters in a single
/// SQL `UPDATE`.
///
/// [`AgentRepository::increment_stats`]:
///     crate::traits::AgentRepository::increment_stats
#[derive(Debug, Clone, Default)]
pub struct StatsDelta {
    /// Increment for the messages-sent counter.
    pub messages_sent: i64,
    /// Increment for the messages-received counter.
    pub messages_received: i64,
    /// Increment for the conversation counter.
    pub conversation_count: i64,
    /// Increment for the friend/connection counter.
    pub friend_count: i64,
}

/// A persistent delivery job fetched from the queue.
///
/// Returned by [`crate::traits::DeliveryJobRepository::fetch_ready_jobs`].
/// The worker uses this record to attempt re-delivery of a message
/// and to update the job's status on completion or failure.
#[derive(Debug, Clone)]
pub struct DeliveryJob {
    /// Internal UUID for this job row.
    pub id: Uuid,
    /// UUID of the message being delivered.
    pub message_id: Uuid,
    /// JSON-serialized `DeliveryJobPayload` (event + target).
    pub payload: String,
    /// Current job status (`"pending"`, `"processing"`, `"done"`).
    pub status: String,
    /// Number of delivery attempts made so far.
    pub attempts: u32,
    /// Maximum allowed attempts before dead-lettering.
    pub max_attempts: u32,
    /// Earliest time the next attempt may be made.
    pub next_attempt_at: DateTime<Utc>,
    /// Error string from the most recent failed attempt, if any.
    pub last_error: Option<String>,
    /// When the job was first created.
    pub created_at: DateTime<Utc>,
}

impl StatsDelta {
    /// Returns a delta that increments `messages_sent` by 1.
    pub fn sent() -> Self {
        Self {
            messages_sent: 1,
            ..Default::default()
        }
    }

    /// Returns a delta that increments `messages_received`
    /// by 1.
    pub fn received() -> Self {
        Self {
            messages_received: 1,
            ..Default::default()
        }
    }

    /// Returns a delta that increments `conversation_count`
    /// by 1.
    pub fn conversation() -> Self {
        Self {
            conversation_count: 1,
            ..Default::default()
        }
    }

    /// Returns a delta that increments `friend_count` by 1.
    pub fn friend() -> Self {
        Self {
            friend_count: 1,
            ..Default::default()
        }
    }
}
