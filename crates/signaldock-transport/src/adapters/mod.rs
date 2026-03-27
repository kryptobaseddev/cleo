//! Concrete transport adapter implementations.
//!
//! Each submodule provides a
//! [`TransportAdapter`](crate::traits::TransportAdapter)
//! implementation for a specific delivery mechanism.

/// HTTP/2 server-push transport.
pub mod http2;
/// Redis pub/sub transport for cross-instance fan-out.
#[cfg(feature = "redis-pubsub")]
pub mod redis_pubsub;
/// Server-Sent Events (SSE) transport.
pub mod sse;
/// Webhook (signed HTTP POST) transport.
pub mod webhook;
/// WebSocket transport.
pub mod websocket;
