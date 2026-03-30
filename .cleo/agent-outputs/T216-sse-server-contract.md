# T216: SSE Server Contract — Client Implementation Guide

**Agent**: cleo-historian
**Date**: 2026-03-30
**Epic**: T211 (Local SignalDock Stack)
**For**: @cleo-dev (SseTransport client implementation)

---

## Summary

The SignalDock v2 backend has a **fully deployed SSE server**. This document specifies the server contract so the client-side `SseTransport` can be implemented correctly.

---

## Server Endpoints

### 1. `GET /sse` — Open SSE Stream

**Auth**: Required. `AgentAuth` middleware extracts agent ID from `Authorization: Bearer <apiKey>` + `X-Agent-Id` header.

**Response**: `text/event-stream` (Server-Sent Events)

**Behavior**:
1. Registers the agent as connected via `SseAdapter.connect(agent_id)`
2. Returns an unbounded channel as an SSE stream
3. Spawns a heartbeat task that pings every **30 seconds**
4. When client disconnects (channel receiver dropped), heartbeat task exits and calls `SseAdapter.disconnect(agent_id)`
5. Uses Axum's built-in `KeepAlive::default()` for HTTP-level keep-alive

**Event format**:
```
data: <JSON payload>\n\n
```

The `data` field contains the raw message payload. Events are `Event::default().data(data)` — no custom event type names, so all events arrive as the default `message` event type.

**Heartbeat events**: Sent every 30s by the server. If `send_heartbeat()` returns false (channel closed), the agent is disconnected.

---

### 2. `GET /messages/stream/status` — SSE Connection Status

**Auth**: None required (public endpoint).

**Response**:
```json
{
  "data": {
    "connectedAgents": 3,
    "agentIds": ["cleo-dev", "cleo-historian", "signaldock-backend"]
  },
  "success": true
}
```

Useful for debugging: check if your agent's SSE connection is registered.

---

## Delivery Architecture (How Messages Reach SSE)

Source: `/mnt/projects/signaldock/backend/src/delivery.rs`

When a message is sent (POST to any message endpoint), the server:

1. **Persists** the message (status = `pending`)
2. **Spawns** `deliver_or_enqueue()` async task
3. **Fast path**: Checks if recipient has active SSE connection via `sse.is_connected(agent_id)`
   - If YES: delivers via SSE push, marks message `delivered`
   - If NO: falls through to slow path
4. **Slow path**: Enqueues a `DeliveryJobPayload` in `delivery_jobs` table
   - Background `DeliveryWorker` retries with exponential backoff
   - Eventually dead-letters if all attempts fail

**Key implication for client**: If your SSE connection is active, you get instant delivery. If not, messages queue up and are available via HTTP polling (`GET /messages/peek`).

---

## Client Implementation Requirements

### Connection

```typescript
// 1. Open EventSource
const url = `${apiBaseUrl}/sse`;
const eventSource = new EventSource(url, {
  // Note: EventSource doesn't support custom headers natively.
  // Auth must be via query param or pre-flight cookie/session.
  // Check if the server supports ?token=<apiKey> or requires
  // a pre-flight auth call.
});

// 2. Handle connection
eventSource.onopen = () => { /* state → connected */ };
eventSource.onerror = () => { /* state → reconnecting or error */ };
eventSource.onmessage = (event) => {
  const message = JSON.parse(event.data);
  // Buffer message for poll() to drain
};
```

### Auth Challenge

The SSE server uses `AgentAuth` middleware which expects `Authorization` and `X-Agent-Id` headers. Standard `EventSource` API does **not** support custom headers.

**Solutions** (in priority order):
1. **Query param auth**: `GET /sse?token=<apiKey>&agentId=<id>` — server needs to support this
2. **Pre-flight session**: POST to `/auth/sse-token` → get a session token → use in SSE URL
3. **Fetch-based SSE**: Use `fetch()` with `ReadableStream` instead of `EventSource` — supports headers but loses auto-reconnect
4. **Proxy**: Local proxy adds headers before forwarding to SSE endpoint

**Recommendation**: Option 3 (fetch-based) is most compatible. Implement auto-reconnect manually (the test scenarios already specify the backoff pattern).

### Message Format

Messages arrive as JSON in the `data` field:
```json
{
  "message_id": "uuid",
  "conversation_id": "uuid",
  "from_agent_id": "cleo-dev",
  "from_agent_name": "CLEO Dev",
  "to_agent_id": "cleo-historian",
  "content": "/status @all ...",
  "content_type": "text",
  "created_at": "2026-03-30T22:00:00Z",
  "attachments": []
}
```

This is `DeliveryEvent` from `signaldock_protocol::message`. Map to `ConduitMessage`:
- `id` ← `message_id`
- `from` ← `from_agent_id`
- `content` ← `content`
- `timestamp` ← `created_at`
- `threadId` ← `conversation_id`

### Heartbeat

Server sends heartbeat every 30s. Client should:
- Reset a 60s timeout on each heartbeat
- If no heartbeat for 60s, assume connection dead → reconnect

### Disconnect Detection

Server detects client disconnect when:
- The unbounded channel receiver is dropped (client closes connection)
- Heartbeat `send_heartbeat()` returns false

Client should call `eventSource.close()` or abort the fetch on disconnect.

---

## Files Reference

| File | Purpose |
|------|---------|
| `/mnt/projects/signaldock/backend/src/routes/sse.rs` | SSE route handlers |
| `/mnt/projects/signaldock/backend/src/delivery.rs` | Message delivery (SSE fast path + queue slow path) |
| `signaldock_transport::adapters::sse::SseAdapter` | In-memory SSE connection registry |
| `signaldock_sdk::services::delivery_worker` | Background retry worker |
| `signaldock_protocol::message::DeliveryEvent` | Wire format for SSE messages |

---

## Linked Tasks

- Epic: T211
- Related: T216 (SseTransport), test scenarios in `conduit/__tests__/sse-transport.test.ts`
