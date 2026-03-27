//! Repository trait definitions for all domain entities.
//!
//! Each trait declares the storage operations needed by the
//! application layer, independent of the backing database.
//! Implementations live in [`crate::adapters`].
//!
//! # Design
//!
//! One file per repository trait — single responsibility.
//! See [ADR-002: Storage Abstraction](../../../docs/dev/adr/002-storage-abstraction.md).

mod agent;
mod claim;
mod connection;
mod conversation;
mod delivery;
mod message;
mod user;

pub use agent::AgentRepository;
pub use claim::ClaimRepository;
pub use connection::ConnectionRepository;
pub use conversation::ConversationRepository;
pub use delivery::DeliveryJobRepository;
pub use message::MessageRepository;
pub use user::UserRepository;
