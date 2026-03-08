# T5671 SignalDock-core Integration Research Report

**Agent**: signaldock-lead
**Date**: 2026-03-08
**Task**: #13

---

## 1. SignalDock-core Overview

SignalDock-core is a protocol-first Rust library providing **agent-to-agent messaging infrastructure**. It powers signaldock.io as a hosted SaaS platform. The core value proposition: zero-config messaging infrastructure where any AI agent -- regardless of framework (LangChain, CrewAI, AutoGen, custom) -- can register, discover other agents, and exchange messages through a single API.

**Key characteristics:**
- Written in Rust (workspace of 5 crates + 2 stubbed binding crates)
- Async runtime: Tokio
- Database: sqlx with SQLite and PostgreSQL adapters
- HTTP server: Axum 0.7
- 76 tests (70 unit + 6 doc-tests)
- Clean layered architecture: protocol -> storage -> transport -> sdk -> api

**What it does:**
1. **Agent Registration** -- agents get a unique ID, name, class, and privacy tier
2. **Message Delivery** -- send messages to any registered agent by ID
3. **Transport Priority Chain** -- SSE > Webhook > WebSocket > HTTP/2 > Polling
4. **Conversation Management** -- persistent conversation threads between agents
5. **Agent Discovery** -- privacy-tiered agent listings (public/discoverable/private)
6. **Connection Management** -- agent-to-agent connection requests and status tracking

---

## 2. Public API Surface

### 2.1 Crate Architecture

```
signaldock-protocol  (zero deps, pure types -- LAFS envelopes, domain models, error codes)
signaldock-storage   (repository traits + SQLite/PostgreSQL adapters)
signaldock-transport (TransportAdapter trait + SSE/Webhook/WS/HTTP2 adapters)
signaldock-sdk       (AgentService, MessageService, ConversationService, DeliveryOrchestrator)
signaldock-api       (Axum HTTP server -- reference implementation)
```

### 2.2 Protocol Types (signaldock-protocol)

Key exported types:
- `Agent`, `NewAgent`, `AgentUpdate`, `AgentCard`, `AgentClass`, `AgentStatus`, `AgentStats`, `PrivacyTier`
- `Message`, `NewMessage`, `MessageStatus`, `ContentType`, `DeliveryEvent`
- `Conversation`, `NewConversation`, `ConversationVisibility`
- `Connection`, `NewConnection`, `ConnectionStatus`
- `ClaimCode`, `NewClaimCode`
- `User`
- `ApiResponse<T>`, `PageInfo`, `ResponseMeta` (LAFS envelope)
- `ErrorCode`, `ErrorCategory`, `StructuredError` (22 structured error codes)

### 2.3 Storage Traits (signaldock-storage)

Repository trait interfaces (all `async_trait`):
- `AgentRepository` -- CRUD, search, stats, ownership, heartbeat
- `MessageRepository` -- create, find, list, poll, mark delivered/read
- `ConversationRepository` -- find_or_create, list, visibility
- `UserRepository` -- create, find by ID/email
- `ClaimRepository` -- claim code lifecycle
- `ConnectionRepository` -- agent-to-agent connections

### 2.4 Transport Traits (signaldock-transport)

- `TransportAdapter` trait: `name()`, `supports_push()`, `deliver()`, `is_connected()`
- `DeliveryChain` -- priority-ordered adapter composition
- `DeliveryResult` -- success/failure with transport name, status code, timing
- `RetryPolicy` -- exponential backoff (6 attempts, 1s-32s)
- Four built-in adapters: SSE, Webhook, WebSocket, HTTP/2

### 2.5 SDK Services (signaldock-sdk)

- `AgentService` -- registration, lookup, heartbeat, claim-code lifecycle
- `MessageService` -- send (legacy + conversation-based), poll, acknowledge
- `ConversationService` -- idempotent creation, listing
- `DeliveryOrchestrator` -- prioritized delivery via transport chain

### 2.6 HTTP API (signaldock-api)

20 REST endpoints covering agents, messages, conversations, users, auth, health.
Auth: JWT Bearer (users) + X-Agent-Id header (agents).

### 2.7 Language Bindings

- **Node.js** (napi-rs): Stubbed, not yet implemented. File: `bindings/node/src/lib.rs`
- **Python** (PyO3): Stubbed, not yet implemented. File: `bindings/python/`

---

## 3. Integration Opportunities

### 3.1 Agent-to-Agent Communication (HIGH VALUE)

**CLEO Need**: The multi-tier orchestration spec (Section 7) defines inter-agent communication via `SendMessage` tool, which is provider-specific (Claude Code SDK). This creates a hard dependency on a single provider.

**SignalDock Solution**: SignalDock provides framework-agnostic, persistent agent-to-agent messaging with:
- Agent identity registration (each CLEO agent registers as a SignalDock agent)
- Multiple transport options (SSE for real-time, Webhook for async, Polling for fallback)
- Message persistence and delivery guarantees
- Conversation threads for structured exchanges

**Integration Pattern**: CLEO agents at all tiers (Orchestrator, Team Lead, Subagent) register with SignalDock on spawn. Inter-tier communication flows through SignalDock's message API instead of (or in addition to) the provider-specific SendMessage tool. This would make CLEO's orchestration provider-neutral.

### 3.2 State Coordination Across Tiers (MEDIUM VALUE)

**CLEO Need**: The orchestration spec uses TaskUpdate/TaskGet as the state tracking mechanism, plus `.cleo/agent-outputs/` files for detailed results. State coordination is implicit via task status polling.

**SignalDock Solution**: SignalDock's conversation model + delivery events provide an alternative coordination channel:
- `DeliveryEvent` includes delivery confirmation (SSE, Webhook outcomes)
- `MessageStatus` tracks sent/delivered/read states
- Conversations provide persistent, ordered message threads per agent pair

**Integration Pattern**: Use SignalDock conversations for structured coordination channels (e.g., orchestrator-to-lead, lead-to-subagent). Task status changes could be broadcast as SignalDock messages with delivery confirmation, giving the orchestrator guaranteed delivery semantics that the current polling model lacks.

### 3.3 Wave Execution Synchronization (MEDIUM VALUE)

**CLEO Need**: Wave transitions require the orchestrator to poll task completion (Section 4.3). Currently relies on TaskList/TaskGet polling, which consumes orchestrator context.

**SignalDock Solution**: SignalDock's push-based delivery (SSE/Webhook) enables event-driven wave transitions:
- Team Leads send completion events via SignalDock
- Orchestrator receives via SSE stream -- no polling needed
- Built-in retry/backoff prevents missed notifications

**Integration Pattern**: Each wave creates a "wave coordination" conversation. Team Leads post completion events. The Orchestrator listens on the SSE stream and triggers wave transitions reactively rather than by polling.

### 3.4 Agent Discovery and Privacy (LOW-MEDIUM VALUE)

**CLEO Need**: The orchestration spec (Section 3) spawns agents with specific roles. Agent identity is tracked via task ownership (TaskUpdate owner field).

**SignalDock Solution**: SignalDock's agent registry provides:
- Privacy tiers (public/discoverable/private) -- useful for internal vs. external agents
- Agent classes (code_dev, research, utility_bot, etc.) -- maps to CLEO agent roles
- Agent cards -- public metadata about capabilities
- Heartbeat/presence tracking

**Integration Pattern**: Register CLEO orchestration agents with appropriate privacy tiers and classes. Use agent discovery for dynamic agent selection (e.g., finding available Team Leads with specific capabilities).

### 3.5 Cross-Project Agent Communication (HIGH VALUE - FUTURE)

**CLEO Need**: CLEO's NEXUS system tracks cross-project state but lacks a real-time messaging channel between agents working on different projects.

**SignalDock Solution**: SignalDock is inherently multi-project -- any registered agent can message any other. This enables:
- Agents in different CLEO projects communicating via SignalDock
- Cross-project orchestration coordination
- Global agent registry for the NEXUS ecosystem

---

## 4. Consumption Model

### 4.1 Current State

CLEO is a TypeScript/Node.js project. SignalDock-core is a Rust library. Two consumption paths exist:

**Path A: HTTP API Client (Recommended for Phase 1)**
- CLEO creates a lightweight TypeScript HTTP client for the SignalDock REST API
- Zero Rust build dependency -- CLEO just talks HTTP to a running SignalDock server
- Server runs locally (`cargo run -p signaldock-api`) or hosted at api.signaldock.io
- Minimal integration surface: register agent, send message, poll/stream messages

**Path B: napi-rs Native Bindings (Future)**
- SignalDock's Node.js bindings (`bindings/node/`) are stubbed but not implemented
- When implemented, CLEO could consume SignalDock as a native Node.js module
- Zero network overhead -- in-process Rust library calls
- Requires napi-rs build toolchain in CLEO's CI

### 4.2 Recommended Consumption

**Phase 1: HTTP Client**
1. CLEO adds a `src/core/signaldock/client.ts` module with typed HTTP calls
2. SignalDock runs as a sidecar process (local SQLite) or connects to hosted instance
3. Agent registration happens at session start; cleanup at session end
4. Messages flow through SignalDock API alongside existing SendMessage

**Phase 2: Native Bindings**
1. SignalDock implements napi-rs bindings exposing SDK services
2. CLEO consumes `@signaldock/core` as an npm package with native addon
3. In-process delivery eliminates network latency
4. SignalDock's SQLite adapter runs embedded in CLEO's process

### 4.3 Configuration

CLEO would need:
```json
{
  "signaldock": {
    "enabled": false,
    "mode": "http",
    "endpoint": "http://localhost:4000",
    "agentPrefix": "cleo-",
    "privacyTier": "private"
  }
}
```

---

## 5. Recommendations

### Priority 1: Provider-Neutral Messaging Layer
- **What**: Create a `TransportAdapter` interface in CLEO that abstracts inter-agent communication
- **Why**: Current SendMessage is Claude Code-specific. SignalDock enables framework-agnostic orchestration.
- **How**: Define a CLEO `AgentTransport` interface with `send(agentId, message)` and `receive()`. Implement for both Claude Code SDK (current) and SignalDock HTTP API.
- **Sizing**: Medium

### Priority 2: Event-Driven Wave Coordination
- **What**: Replace task polling with push-based completion notifications via SignalDock SSE
- **Why**: Reduces orchestrator context consumption (no repeated TaskList calls)
- **How**: Team Leads post completion events to a wave conversation. Orchestrator listens on SSE stream.
- **Sizing**: Medium

### Priority 3: Agent Registry for Dynamic Orchestration
- **What**: Use SignalDock's agent registry for dynamic agent discovery and capability matching
- **Why**: Enables more flexible orchestration -- agents can be selected by capability rather than hardcoded
- **How**: Register agents with classes and capabilities. Orchestrator queries registry before spawning.
- **Sizing**: Small

### Priority 4: Cross-Project Communication via NEXUS
- **What**: Bridge SignalDock messaging with CLEO's NEXUS cross-project system
- **Why**: Enables real-time coordination between agents working on different projects
- **How**: NEXUS registers project-level agents; SignalDock handles cross-project message routing
- **Sizing**: Large (depends on NEXUS maturity)

---

## 6. Next Steps

1. **Design ADR**: Write an Architecture Decision Record for SignalDock integration approach (HTTP vs. native, opt-in vs. default)
2. **TypeScript Client**: Implement a typed HTTP client for SignalDock's REST API in `src/core/signaldock/`
3. **Transport Abstraction**: Define a CLEO `AgentTransport` interface that can be backed by either Claude Code SendMessage or SignalDock
4. **Prototype**: Run SignalDock locally alongside a CLEO multi-tier orchestration to validate the event-driven wave coordination pattern
5. **napi-rs Bindings**: Coordinate with SignalDock to prioritize Node.js binding implementation for Phase 2 in-process integration
6. **Configuration**: Add SignalDock configuration to `.cleo/config.json` schema with feature flag

### Dependencies
- SignalDock Node.js bindings (stubbed, not implemented) -- needed for Phase 2
- CLEO provider abstraction layer -- needed before SignalDock can replace SendMessage
- NEXUS stability -- needed for Priority 4 cross-project integration

### Risks
- **Deployment complexity**: Running SignalDock as a sidecar adds operational overhead
- **Network latency**: HTTP API adds round-trip time vs. in-process SendMessage
- **Binding maturity**: napi-rs bindings are stubbed; timeline for implementation unknown
- **Single point of failure**: If SignalDock server is down, agent communication fails (mitigated by keeping SendMessage as fallback)
