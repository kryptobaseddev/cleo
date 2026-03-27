//! Transport layer for `SignalDock` message delivery.
//!
//! Provides pluggable transport adapters for delivering
//! [`DeliveryEvent`](signaldock_protocol::message::DeliveryEvent)s
//! to connected agents. Four built-in adapters are included:
//!
//! - **SSE** ([`adapters::sse::SseAdapter`]) — server-sent events
//! - **WebSocket** ([`adapters::websocket::WebSocketAdapter`])
//! - **HTTP/2** ([`adapters::http2::Http2Adapter`]) — binary frames
//! - **Webhook** ([`adapters::webhook::WebhookAdapter`]) — signed
//!   HTTP POST
//!
//! The [`traits::TransportAdapter`] trait defines the common
//! interface, and [`traits::DeliveryChain`] orchestrates delivery
//! across multiple adapters in priority order.
//!
//! # Quick start
//!
//! ```no_run
//! use signaldock_transport::adapters::sse::SseAdapter;
//! use signaldock_transport::traits::{DeliveryChain, TransportAdapter};
//!
//! let chain = DeliveryChain::new(vec![
//!     Box::new(SseAdapter::new()),
//! ]);
//! ```
//!
//! # Design
//!
//! Architecture defined in
//! [ADR-001: Transport Protocol](../../docs/dev/adr/001-transport-protocol.md).
//! Delivery guarantee semantics specified in
//! [Spec: Message Delivery Guarantees](../../docs/dev/specs/message-delivery-guarantees.md).

/// Transport adapters for each delivery mechanism.
pub mod adapters;
/// Core traits and shared types for transport delivery.
pub mod traits;
