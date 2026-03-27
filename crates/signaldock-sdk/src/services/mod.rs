//! Application services for the `SignalDock` platform.
//!
//! Composes storage and transport traits into high-level operations
//! for agents, messages, conversations, and delivery orchestration.

/// Agent registration, lookup, heartbeat, and claim-code lifecycle.
pub mod agent_service;
/// Idempotent conversation creation and paginated listing.
pub mod conversation_service;
/// Priority-based delivery orchestration via SSE, webhook, and polling.
pub mod delivery_service;
/// Background worker that drains the persistent delivery job queue.
pub mod delivery_worker;
/// Message sending, polling, and acknowledgement.
pub mod message_service;
