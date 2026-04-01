//! Repository trait abstraction and Diesel database adapters for
//! `SignalDock`.
//!
//! This crate defines storage-agnostic repository traits
//! ([`traits`]) and a unified Diesel adapter that supports both
//! `SQLite` and `PostgreSQL` backends via `diesel-async`.
//!
//! # Feature flags
//!
//! | Flag | Enables |
//! |------|---------|
//! | `sqlite` | SQLite backend via Diesel |
//! | `postgres` | PostgreSQL backend via Diesel |
//!
//! # Modules
//!
//! - [`types`] — Pagination, query filters, and stats deltas.
//! - [`traits`] — Repository trait definitions.
//! - [`adapters`] — Diesel adapter implementations.
//!
//! # Design
//!
//! Repository trait abstraction defined in
//! [ADR-002: Storage Abstraction](../../docs/dev/adr/002-storage-abstraction.md).
//! Diesel is the sole Rust ORM (enforcement rule #4, T229).

/// Diesel database adapter implementations.
pub mod adapters;
/// Diesel model structs (Row, NewRow, UpdateRow) for all domain tables.
pub mod models;
/// Diesel `table!` macro definitions for the full SignalDock schema.
pub mod schema;
/// Repository trait definitions for all domain entities.
pub mod traits;
/// Pagination, query filters, and stats delta types.
pub mod types;

pub use adapters::diesel_store::DieselStore;

/// Convenience type alias for the SQLite-backed Diesel store.
#[cfg(feature = "sqlite")]
pub type SqliteStore = DieselStore<
    diesel_async::sync_connection_wrapper::SyncConnectionWrapper<diesel::SqliteConnection>,
>;

/// Convenience type alias for the PostgreSQL-backed Diesel store.
#[cfg(feature = "postgres")]
pub type PgStore = DieselStore<diesel_async::AsyncPgConnection>;
