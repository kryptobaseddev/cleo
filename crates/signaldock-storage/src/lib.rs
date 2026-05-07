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
//! - [`sqlite_pragmas`] — Compile-time SQLite pragma SSoT (T9053).
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
/// Compile-time SQLite pragma SSoT (T9053).
///
/// Re-exports the canonical pragma SQL generated from
/// `specs/sqlite-pragmas.json` by `build.rs`. The TS side
/// (`packages/core/src/store/sqlite-pragmas.ts`) consumes the same
/// JSON file at runtime, so both code paths apply byte-identical
/// pragma SQL to every SQLite connection they open.
pub mod sqlite_pragmas;
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
