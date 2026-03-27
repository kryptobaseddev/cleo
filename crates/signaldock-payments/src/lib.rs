//! x402 payment protocol for `SignalDock` agent services.
//!
//! Implements the HTTP 402 Payment Required flow with support
//! for Base (EVM) and Solana networks via external facilitators.

/// Agent payment configuration (price, network, wallet).
pub mod config;
/// HTTP client for x402 facilitator verification and settlement.
pub mod facilitator;
/// Axum middleware for enforcing payment requirements on routes.
pub mod middleware;
/// Shared payment protocol types (networks, options, payloads, responses).
pub mod types;
