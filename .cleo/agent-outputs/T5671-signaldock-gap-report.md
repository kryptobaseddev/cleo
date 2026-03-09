# SignalDock Transport Gap Analysis Report

**Task**: T5671
**Date**: 2026-03-08
**Status**: COMPLETE

---

## 1. Test Coverage Summary

| Test Suite | File | Tests | Status |
|------------|------|-------|--------|
| Unit: SignalDockTransport | `src/core/signaldock/__tests__/signaldock-transport.test.ts` | 29 | All pass |
| Unit: ClaudeCodeTransport | `src/core/signaldock/__tests__/claude-code-transport.test.ts` | 18 | All pass |
| Unit: Factory | `src/core/signaldock/__tests__/factory.test.ts` | 5 | All pass |
| Integration (live daemon) | `tests/integration/signaldock-integration.test.ts` | 7 | Skip (daemon unavailable) |
| E2E Orchestration | `tests/e2e/signaldock-orchestration.test.ts` | 4 | All pass |
| **Total** | **5 files** | **63** | **56 pass, 7 skip** |

---

## 2. What Works

### SignalDockTransport (HTTP client)
- Agent registration with configurable prefix
- Agent deregistration (DELETE)
- Message sending with auto-conversation creation
- Message polling (GET with X-Agent-Id header)
- Heartbeat POST
- Conversation creation with sorted participants
- Agent lookup (GET by ID, null on miss)
- Error handling: non-200 responses, envelope errors, network failures
- URL encoding for agent IDs with special characters
- Proper header management (Content-Type, Accept, X-Agent-Id)

### ClaudeCodeTransport (fallback adapter)
- Full AgentTransport interface compliance
- In-memory message storage and delivery
- Deterministic IDs (cc- prefix)
- Conversation deduplication by participant set
- Message filtering by recipient and timestamp
- Immediate delivery semantics (status always "delivered")

### Factory
- Default to ClaudeCodeTransport when no config or disabled
- SignalDockTransport creation when enabled
- Config passthrough

---

## 3. What Does NOT Work

### Critical: API Response Envelope Mismatch

**Severity**: BLOCKING for production use with the SignalDock daemon

The CLEO `SignalDockTransport.request<T>()` method (line 194) parses the response as:
```typescript
const envelope = (await response.json()) as ApiResponse<T>;
return envelope.data as T;
```

The SignalDock daemon wraps data in **nested domain objects**:
```json
{
  "success": true,
  "data": { "agent": { "id": "...", "name": "..." } },
  "timestamp": "..."
}
```

CLEO expects `envelope.data` to be the `Agent` directly, but the daemon returns `{ agent: Agent }`. This means:

| Operation | CLEO expects `data` to be | Daemon returns `data` as |
|-----------|---------------------------|--------------------------|
| POST /agents | `Agent` | `{ agent: Agent }` |
| GET /agents/:id | `Agent` | `{ agent: Agent }` |
| POST /conversations | `Conversation` | `{ conversation: Conversation }` |
| POST /messages | `Message` | `{ message: Message }` |
| GET /messages/poll/new | `Message[]` | `{ messages: Message[] }` |
| GET /agents | `Agent[]` (unused) | `{ agents: Agent[] }` |

**Fix required**: Either unwrap the nested key in `request<T>()`, or add a response transformer per endpoint.

### Minor: `since` Parameter Not Sent on Poll

`SignalDockTransport.poll()` accepts a `_since` parameter (prefixed with underscore = unused). The daemon's `/messages/poll/new` endpoint uses `X-Agent-Id` header for poll identity but the `since` parameter is never passed as a query parameter. This means CLEO always polls ALL new messages rather than messages since a specific timestamp.

### Minor: `listAgents` Not Exposed

The daemon has `GET /agents` to list all agents, but `SignalDockTransport` does not expose a `listAgents()` method. The `AgentTransport` interface also lacks this method.

---

## 4. What's Missing for Production

### Authentication
- The daemon has `/auth/register`, `/auth/login`, `/auth/me` endpoints
- CLEO's transport sends NO authentication headers (no Bearer token, no API key)
- Routes requiring `AnyAuth` (agent update, delete) will fail without proper auth
- Agent registration appears to work unauthenticated, but ownership and update/delete require auth

### Message Acknowledgment
- Daemon has `POST /messages/:id/ack` for read receipts
- CLEO transport has no `acknowledge()` method
- Without ACK, polled messages may re-appear on subsequent polls

### SSE/WebSocket Streaming
- Daemon supports `GET /messages/stream` (SSE) and `GET /messages/stream/status`
- CLEO only uses HTTP polling — no real-time push
- For production orchestration, polling latency is a bottleneck

### Conversation Management
- No `getConversation()` or `listConversations()` methods
- No `getConversationMessages()` to fetch history
- No visibility update (`PATCH /conversations/:id`)

### Agent Update
- No `updateAgent()` method (daemon supports PUT/PATCH `/agents/:id`)
- Cannot change agent status, description, or capabilities after registration

### Claim Codes / User Linking
- Daemon has claim code generation and redemption for user-agent linking
- CLEO has no concept of this — agents are ephemeral

### Retry / Resilience
- No retry logic on transient failures (5xx, network timeouts)
- No circuit breaker pattern
- No request timeout configuration

### Error Typing
- All errors are generic `Error` instances with string messages
- No structured error types for callers to catch specific failures

---

## 5. Comparison with Gas Town (Claude Code Agent SDK)

| Capability | SignalDock Transport | Claude Code Transport (Gas Town) |
|------------|---------------------|----------------------------------|
| Provider neutrality | Yes (any AI tool) | No (Claude Code only) |
| Real infrastructure | Yes (HTTP to daemon) | No (in-memory) |
| Delivery guarantees | Yes (persistent storage) | No (process-local) |
| Message persistence | Yes (SQLite in daemon) | No (lost on process exit) |
| Real-time push | Yes (SSE, not yet used) | No |
| Authentication | Yes (JWT, not yet used) | N/A |
| Agent discovery | Yes (public registry) | No |
| Payments | Yes (x402, not yet used) | No |
| Setup complexity | High (requires daemon) | Zero |
| Latency | Higher (network hop) | Near-zero |

---

## 6. Recommendations

### Immediate (before integration tests can pass)
1. **Fix envelope unwrapping** — The response data is nested in domain-specific keys (`agent`, `message`, etc.). Either modify `request<T>()` to accept a data key, or create endpoint-specific parsers.
2. **Fix daemon Clippy error** — `apps/signaldock-api/src/error.rs:38` needs backtick around `CompatResponse` in doc comment. One-line fix.

### Short-term (production readiness)
3. Add message acknowledgment (`ack()` method)
4. Pass `since` as query param in `poll()`
5. Add request timeout (AbortSignal.timeout)
6. Add retry with exponential backoff for transient errors

### Medium-term (feature parity)
7. Add authentication support (API key or JWT)
8. Add SSE streaming transport option alongside polling
9. Add `listAgents()`, `updateAgent()`, conversation management methods
10. Add structured error types (SignalDockApiError class with code/status)

### Long-term (competitive advantage)
11. Leverage x402 payments for cross-organization agent messaging
12. Implement agent discovery and public registry features
13. Add WebSocket transport for lowest-latency orchestration

---

## 7. Files Created

| Path | Purpose |
|------|---------|
| `src/core/signaldock/__tests__/signaldock-transport.test.ts` | 29 unit tests for HTTP client |
| `src/core/signaldock/__tests__/claude-code-transport.test.ts` | 18 unit tests for fallback adapter |
| `src/core/signaldock/__tests__/factory.test.ts` | 5 unit tests for transport factory |
| `tests/integration/signaldock-integration.test.ts` | 7 integration tests (daemon required) |
| `tests/e2e/signaldock-orchestration.test.ts` | 4 E2E orchestration workflow tests |
| `.cleo/agent-outputs/T5671-signaldock-gap-report.md` | This report |
