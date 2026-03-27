//! Database adapter implementations.
//!
//! Each adapter implements the repository traits defined in
//! [`crate::traits`] for a specific database backend.
//!
//! - `sqlite` — `SQLite` via `sqlx` (feature `sqlite`).
//! - `postgres` — `PostgreSQL` via `sqlx` (feature
//!   `postgres`).

/// `SQLite` adapter — available with feature `sqlite`.
#[cfg(feature = "sqlite")]
pub mod sqlite;
#[cfg(feature = "sqlite")]
mod sqlite_conversations;
#[cfg(feature = "sqlite")]
/// Row-to-struct conversion helpers for `SQLite` queries.
pub mod sqlite_helpers;
#[cfg(feature = "sqlite")]
mod sqlite_jobs;
#[cfg(feature = "sqlite")]
/// `SQLite` message storage with FTS5 full-text search.
pub mod sqlite_messages;
#[cfg(feature = "sqlite")]
mod sqlite_others;
#[cfg(all(test, feature = "sqlite"))]
mod sqlite_tests;

#[cfg(feature = "postgres")]
mod pg_conversations;
#[cfg(feature = "postgres")]
mod pg_helpers;
#[cfg(feature = "postgres")]
mod pg_messages;
#[cfg(feature = "postgres")]
mod pg_others;
/// `PostgreSQL` adapter — available with feature `postgres`.
#[cfg(feature = "postgres")]
pub mod postgres;
