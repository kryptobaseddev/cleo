//! Database adapter implementations.
//!
//! Each adapter implements the repository traits defined in
//! [`crate::traits`] for the Diesel ORM backend.
//!
//! Diesel is the sole Rust ORM (enforcement rule #4). All sqlx adapters
//! were removed in T229.

// ── Diesel (unified) adapter ─────────────────────────────────────
mod diesel_connections_agent;
mod diesel_conversations;
/// Diesel adapter helpers for row-to-domain conversions and error mapping.
pub mod diesel_helpers;
mod diesel_jobs;
mod diesel_messages;
mod diesel_others;
/// Unified Diesel adapter — backend-agnostic via `AsyncConnection`.
pub mod diesel_store;

/// Backward-compatible re-export of the SQLite-backed store.
///
/// Allows existing code to use `signaldock_storage::adapters::sqlite::SqliteStore`
/// without changes.
#[cfg(feature = "sqlite")]
pub mod sqlite {
    /// SQLite-backed Diesel store (type alias for `DieselStore<SyncConnectionWrapper<SqliteConnection>>`).
    pub type SqliteStore = crate::SqliteStore;
}
