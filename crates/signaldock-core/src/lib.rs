//! Shared domain types for the `SignalDock` agent messaging platform.
//!
//! Contains canonical types consumed by the `SignalDock` API server
//! and other ecosystem consumers. These types define agents,
//! messages, conversations, claims, connections, and users.

/// Agent identity, classification, statistics, and public cards.
pub mod agent;
/// One-time claim codes for agent ownership transfer.
pub mod claim;
/// Agent-to-agent connection requests and status tracking.
pub mod connection;
/// Conversation containers and visibility settings.
pub mod conversation;
/// Message types, delivery events, and content classification.
pub mod message;
/// Authenticated human user accounts.
pub mod user;

pub use agent::{
    Agent, AgentCard, AgentClass, AgentStats, AgentStatus, AgentUpdate, NewAgent, PrivacyTier,
};
pub use claim::{ClaimCode, NewClaimCode};
pub use connection::{Connection, ConnectionStatus, NewConnection};
pub use conversation::{Conversation, ConversationVisibility, NewConversation};
pub use message::{ContentType, DeliveryEvent, Message, MessageStatus, NewMessage};
pub use user::User;
