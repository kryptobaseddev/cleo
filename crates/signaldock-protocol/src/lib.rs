//! Protocol types for the `SignalDock` agent messaging platform.
//!
//! This crate is a **thin re-export layer** over the canonical
//! `SSoT` crates from `cleocode/crates/`:
//!
//! - **Domain types** (`Agent`, `Message`, `Conversation`, etc.) → `signaldock-core`
//! - **Conduit wire types** (`ConduitMessage`, `ConduitState`, etc.) → `conduit-core`
//! - **LAFS envelope types** (`LafsEnvelope`, `LafsMeta`, etc.) → `lafs-core`
//! - **CANT parser** → `cant-core`
//!
//! Server-specific types that remain local:
//! - [`app_error`] — Application-level error type with HTTP status codes
//! - [`error`] — Structured error codes and categories

// ============================================================================
// SSoT re-exports from cleocode/crates/
// ============================================================================

// Domain types (Agent, Message, Conversation, Claim, Connection, User)
pub use signaldock_core::agent;
pub use signaldock_core::claim;
pub use signaldock_core::connection;
pub use signaldock_core::conversation;
pub use signaldock_core::message;
pub use signaldock_core::user;

pub use signaldock_core::{
    Agent, AgentCard, AgentClass, AgentStats, AgentStatus, AgentUpdate, ClaimCode, Connection,
    ConnectionStatus, ContentType, Conversation, ConversationVisibility, DeliveryEvent, Message,
    MessageStatus, NewAgent, NewClaimCode, NewConnection, NewConversation, NewMessage, PrivacyTier,
    User,
};

// Conduit wire types
pub use conduit_core::{
    CantMetadata, CantOperation, ConduitConfig, ConduitMessage, ConduitSendOptions,
    ConduitSendResult, ConduitState, ConduitStateChange,
};

// LAFS envelope types
pub use lafs_core::{
    LafsAgentAction, LafsEnvelope, LafsError, LafsErrorCategory, LafsMeta, LafsPage,
    LafsPageCursor, LafsPageNone, LafsPageOffset, LafsTransport, MviLevel, Warning,
};

// CANT parser
pub use cant_core::{DirectiveType, ParsedCANTMessage, parse as cant_parse};

// ============================================================================
// Server-specific types (NOT in cleocode SSoT)
// ============================================================================

/// Application-level error type with convenient factory methods.
pub mod app_error;
/// Structured error codes, categories, and error payloads.
pub mod error;

pub use app_error::AppError;
pub use error::{ErrorCategory, ErrorCode, StructuredError};
