# signaldock-sdk

<!-- cargo-rdme start -->

High-level service layer for the `SignalDock` platform.

This crate provides application services generic over storage
and transport traits. It contains four primary services:

- [`services::agent_service::AgentService`] -- agent registration,
  lookup, heartbeat, and claim-code lifecycle.
- [`services::message_service::MessageService`] -- message
  sending (legacy and conversation-based), polling, and
  acknowledgement.
- [`services::conversation_service::ConversationService`] --
  idempotent conversation creation and listing.
- [`services::delivery_service::DeliveryOrchestrator`] --
  prioritised delivery via SSE, webhook, or polling fallback.

The `mock` module (test-only, `#[cfg(test)]`) supplies an
in-memory store for unit testing all services without
external dependencies.

<!-- cargo-rdme end -->
