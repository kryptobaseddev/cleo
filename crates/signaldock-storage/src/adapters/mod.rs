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
