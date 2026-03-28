//! Diesel model structs for SignalDock storage tables.
//!
//! Each domain table uses the 3-struct pattern from `better-auth-diesel-sqlite`:
//!
//! - `{Table}Row` -- `Queryable` + `Selectable` for reading rows
//! - `New{Table}Row` -- `Insertable` for creating new rows
//! - `Update{Table}Row` -- `AsChangeset` for partial updates
//!
//! Models are split across submodules to stay within the 800-line file limit:
//!
//! - [`core`] -- Users, agents, conversations, connections
//! - [`messaging`] -- Messages, claim codes, delivery jobs, dead letters

/// Core domain models: users, agents, conversations, connections.
pub mod core;
/// Messaging domain models: messages, claim codes, delivery jobs, dead letters.
pub mod messaging;

// Re-export all model types at the `models` level for convenience.
pub use self::core::*;
pub use self::messaging::*;
