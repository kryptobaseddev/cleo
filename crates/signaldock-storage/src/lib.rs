//! Repository trait abstraction and database adapters for
//! `SignalDock`.
//!
//! This crate defines storage-agnostic repository traits
//! ([`traits`]) and concrete adapter implementations for
//! `SQLite` (`adapters::sqlite`) and `PostgreSQL`
//! (`adapters::postgres`).
//!
//! # Feature flags
//!
//! | Flag | Enables |
//! |------|---------|
//! | `sqlite` | [`SqliteStore`] adapter and `SQLite` migrations |
//! | `postgres` | `PostgresStore` adapter and `PostgreSQL` migrations |
//!
//! # Modules
//!
//! - [`types`] — Pagination, query filters, and stats deltas.
//! - [`traits`] — Repository trait definitions.
//! - [`adapters`] — Database-specific implementations.
//!
//! # Design
//!
//! Repository trait abstraction defined in
//! [ADR-002: Storage Abstraction](../../docs/dev/adr/002-storage-abstraction.md).
//! Dynamic query rationale in
//! [ADR-003: Dynamic sqlx Queries](../../docs/dev/adr/003-dynamic-sqlx-queries.md).

/// Database-specific adapter implementations (SQLite, PostgreSQL).
pub mod adapters;
/// Diesel model structs (Row, NewRow, UpdateRow) for all domain tables.
pub mod models;
/// Diesel `table!` macro definitions for the full SignalDock schema.
pub mod schema;
/// Repository trait definitions for all domain entities.
pub mod traits;
/// Pagination, query filters, and stats delta types.
pub mod types;

#[cfg(feature = "sqlite")]
pub use adapters::sqlite::SqliteStore;

#[cfg(feature = "postgres")]
pub use adapters::postgres::PostgresStore;
