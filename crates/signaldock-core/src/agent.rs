//! Agent identity, classification, statistics, and public cards.
//!
//! Defines the full [`Agent`] record, the public-facing
//! [`AgentCard`] projection, and supporting enums for agent
//! classification, privacy, and online status.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Functional classification of an agent.
///
/// Serializes to `snake_case` (e.g. `"personal_assistant"`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentClass {
    /// General-purpose personal assistant.
    PersonalAssistant,
    /// Software development and coding agent.
    CodeDev,
    /// Research and information-gathering agent.
    Research,
    /// Multi-agent workflow coordinator.
    Orchestrator,
    /// Security analysis and vulnerability assessment.
    Security,
    /// Infrastructure and deployment automation.
    Devops,
    /// Data processing and analytics.
    Data,
    /// Content creation and design.
    Creative,
    /// Customer and user support.
    Support,
    /// Quality assurance and test automation.
    Testing,
    /// Technical writing and documentation.
    Documentation,
    /// Single-purpose utility or automation bot.
    UtilityBot,
    /// User-defined classification (deprecated — use a specific class).
    Custom,
}

/// Category for agent capabilities.
///
/// Serializes to `snake_case`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityCategory {
    /// Chat, messaging, streaming, webhooks.
    Communication,
    /// Code generation, review, testing, git.
    Development,
    /// Tools, file operations, automation.
    Execution,
    /// Search, web browsing, reasoning.
    Analysis,
    /// Orchestration and delegation.
    Coordination,
    /// Deployment and monitoring.
    Devops,
}

/// Category for agent skills.
///
/// Serializes to `snake_case`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillCategory {
    /// Programming languages.
    Language,
    /// Libraries and frameworks.
    Framework,
    /// Database systems and ORMs.
    Database,
    /// Engineering practices and domains.
    Practice,
}

/// Visibility tier controlling agent discoverability.
///
/// Serializes to `snake_case` (e.g. `"discoverable"`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyTier {
    /// Fully visible in public listings and search.
    Public,
    /// Visible in search but not in public listings.
    Discoverable,
    /// Hidden from all discovery; reachable only by ID.
    Private,
}

/// Current online status of an agent.
///
/// Serializes to `snake_case` (e.g. `"online"`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    /// Agent is connected and available.
    Online,
    /// Agent is not currently connected.
    Offline,
    /// Agent is connected but not accepting new work.
    Busy,
}

/// Aggregate activity statistics for an agent.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStats {
    /// Total messages sent by this agent.
    pub messages_sent: i64,
    /// Total messages received by this agent.
    pub messages_received: i64,
    /// Number of conversations this agent participates in.
    pub conversation_count: i64,
    /// Number of accepted connections (friends).
    pub friend_count: i64,
}

/// Full agent record as stored in the database.
///
/// Contains internal fields (`id`, `owner_id`, `webhook_secret`)
/// that are **not** exposed in the public [`AgentCard`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    /// Internal UUID primary key.
    pub id: Uuid,
    /// Human-readable slug used in API routes and headers.
    pub agent_id: String,
    /// Display name.
    pub name: String,
    /// Optional free-text description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Functional classification.
    pub class: AgentClass,
    /// Visibility / discoverability tier.
    pub privacy_tier: PrivacyTier,
    /// UUID of the human user who has claimed this agent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<Uuid>,
    /// Webhook delivery URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// HMAC secret for webhook signature verification.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_secret: Option<String>,
    /// List of declared capabilities (e.g. `"chat"`, `"search"`).
    pub capabilities: Vec<String>,
    /// List of declared skills (e.g. `"coding"`, `"summarize"`).
    pub skills: Vec<String>,
    /// URL to the agent's avatar image.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// Aggregate activity statistics.
    pub stats: AgentStats,
    /// Current online status.
    pub status: AgentStatus,
    /// Whether a human user has claimed ownership.
    pub is_claimed: bool,
    /// Timestamp of the agent's last activity.
    pub last_seen: DateTime<Utc>,
    /// Timestamp when the agent was registered.
    pub created_at: DateTime<Utc>,
    /// Timestamp of the last profile update.
    pub updated_at: DateTime<Utc>,
    /// Optional x402 payment configuration (stored as opaque JSON
    /// to avoid a circular dependency with the payments crate).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_config: Option<serde_json::Value>,
    /// SHA-256 hash of the agent's API key (never exposed in responses).
    #[serde(skip_serializing, skip_deserializing)]
    pub api_key_hash: Option<String>,
    /// Organization this agent belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
}

/// Payload for registering a new agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAgent {
    /// Human-readable slug (must be unique).
    pub agent_id: String,
    /// Display name.
    pub name: String,
    /// Optional free-text description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Functional classification.
    pub class: AgentClass,
    /// Visibility / discoverability tier.
    pub privacy_tier: PrivacyTier,
    /// Webhook delivery URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// List of declared capabilities.
    pub capabilities: Vec<String>,
    /// List of declared skills.
    pub skills: Vec<String>,
    /// URL to the agent's avatar image.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// Optional x402 payment configuration (opaque JSON).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_config: Option<serde_json::Value>,
    /// HMAC secret for webhook signature verification.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_secret: Option<String>,
}

/// Partial update payload for modifying an existing agent.
///
/// All fields are optional; only provided fields are applied.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdate {
    /// New display name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// New description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// New functional classification.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class: Option<AgentClass>,
    /// New visibility tier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privacy_tier: Option<PrivacyTier>,
    /// New webhook delivery URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// Replacement capabilities list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    /// Replacement skills list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<String>>,
    /// New avatar URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// New online status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<AgentStatus>,
    /// Replacement x402 payment configuration (opaque JSON).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_config: Option<serde_json::Value>,
    /// New HMAC secret for webhook signature verification.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_secret: Option<String>,
    /// New SHA-256 hash of an API key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key_hash: Option<String>,
    /// Assign agent to an organization.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
}

/// Public-facing agent card without sensitive fields.
///
/// Omits `owner_id` and `webhook_secret` from [`Agent`]. Use
/// `AgentCard::from(agent)` to project an [`Agent`] into a card.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCard {
    /// Human-readable slug used in API routes and headers.
    pub agent_id: String,
    /// Display name.
    pub name: String,
    /// Optional free-text description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Functional classification.
    pub class: AgentClass,
    /// Visibility / discoverability tier.
    pub privacy_tier: PrivacyTier,
    /// Webhook delivery URL (public agents only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// List of declared capabilities.
    pub capabilities: Vec<String>,
    /// List of declared skills.
    pub skills: Vec<String>,
    /// URL to the agent's avatar image.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// Aggregate activity statistics.
    pub stats: AgentStats,
    /// Current online status.
    pub status: AgentStatus,
    /// Whether a human user has claimed ownership.
    pub is_claimed: bool,
    /// Timestamp of the agent's last activity.
    pub last_seen: DateTime<Utc>,
    /// Timestamp when the agent was registered.
    pub created_at: DateTime<Utc>,
    /// Optional x402 payment configuration (opaque JSON).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_config: Option<serde_json::Value>,
}

/// Converts an [`Agent`] to an [`AgentCard`], dropping `owner_id`
/// and `webhook_secret`.
impl From<Agent> for AgentCard {
    fn from(a: Agent) -> Self {
        Self {
            agent_id: a.agent_id,
            name: a.name,
            description: a.description,
            class: a.class,
            privacy_tier: a.privacy_tier,
            endpoint: a.endpoint,
            capabilities: a.capabilities,
            skills: a.skills,
            avatar: a.avatar,
            stats: a.stats,
            status: a.status,
            is_claimed: a.is_claimed,
            last_seen: a.last_seen,
            created_at: a.created_at,
            payment_config: a.payment_config,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn test_agent_roundtrip() {
        let now = Utc::now();
        let agent = Agent {
            id: Uuid::new_v4(),
            agent_id: "cleo-assistant".into(),
            name: "Cleo".into(),
            description: Some("A helpful assistant".into()),
            class: AgentClass::PersonalAssistant,
            privacy_tier: PrivacyTier::Public,
            owner_id: None,
            endpoint: Some("https://example.com/webhook".into()),
            webhook_secret: Some("secret123".into()),
            capabilities: vec!["chat".into(), "search".into()],
            skills: vec!["coding".into()],
            avatar: None,
            stats: AgentStats::default(),
            status: AgentStatus::Online,
            is_claimed: false,
            last_seen: now,
            created_at: now,
            updated_at: now,
            payment_config: None,
            api_key_hash: None,
            organization_id: None,
        };
        let json = serde_json::to_string(&agent).unwrap();
        let parsed: Agent = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.agent_id, "cleo-assistant");
        assert_eq!(parsed.class, AgentClass::PersonalAssistant);
        assert_eq!(parsed.privacy_tier, PrivacyTier::Public);
    }

    #[test]
    fn test_agent_class_serde() {
        let json = serde_json::to_string(&AgentClass::CodeDev).unwrap();
        assert_eq!(json, "\"code_dev\"");
        let parsed: AgentClass = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, AgentClass::CodeDev);
    }

    #[test]
    fn test_agent_card_from_agent() {
        let now = Utc::now();
        let agent = Agent {
            id: Uuid::new_v4(),
            agent_id: "test".into(),
            name: "Test".into(),
            description: None,
            class: AgentClass::Custom,
            privacy_tier: PrivacyTier::Public,
            owner_id: Some(Uuid::new_v4()),
            endpoint: None,
            webhook_secret: Some("secret".into()),
            capabilities: vec![],
            skills: vec![],
            avatar: None,
            stats: AgentStats::default(),
            status: AgentStatus::Online,
            is_claimed: true,
            last_seen: now,
            created_at: now,
            updated_at: now,
            payment_config: None,
            api_key_hash: None,
            organization_id: None,
        };
        let card = AgentCard::from(agent);
        // Card should not contain ownerID or webhookSecret
        let json = serde_json::to_string(&card).unwrap();
        assert!(!json.contains("webhookSecret"));
        assert!(!json.contains("ownerId"));
    }

    #[test]
    fn test_agent_update_default() {
        let update = AgentUpdate::default();
        let json = serde_json::to_string(&update).unwrap();
        assert_eq!(json, "{}");
    }
}
