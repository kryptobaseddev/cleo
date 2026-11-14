---
id: ADR-071
title: CLEO Observability — Vendor-Agnostic Agent Event Bus
status: accepted
date: 2026-05-12
task: T1135
linkedTasks: [T1650, T1651, T1652]
supersedes: null
supersededBy: null
---

# ADR-071: CLEO Observability — Vendor-Agnostic Agent Event Bus

## Context

Autonomous workers (spawned via `cleo orchestrate spawn`) produce structured
lifecycle events (spawn, heartbeat, tool-start, tool-end, commit, blocked,
complete) that are invisible to the orchestrator unless explicitly reported.
Multiple agent harnesses (Claude Agent SDK, OpenAI Agents SDK, LangGraph,
future) must all be able to emit and consume these events without being locked
to a specific transport.

Three transport options were evaluated:

| Option | Mechanism | Tradeoff |
|--------|-----------|----------|
| **A — File-based append-log** | Worker appends JSON lines to `.cleo/agent-events/<agentId>.jsonl` | Simplest. Works for any harness. No dependencies. Hard to tail remotely. |
| **B — Conduit topic** | Worker publishes to `agent.events.<agentId>` topic via `LocalTransport` (SQLite) or `HttpTransport` (cloud) | Already-wired infrastructure. Supports remote/distributed orchestration. Requires Conduit setup. |
| **C — WebSocket/SSE server** | Daemon exposes a streaming endpoint | Real-time push. High operational overhead; adds a new network surface. |

## Decision

**Choose option B (Conduit topic) as the primary transport** with option A
as a local fallback when Conduit is unavailable.

Rationale:
1. Conduit already exists with working LocalTransport (SQLite) and HttpTransport
   (cloud). Reusing it avoids a new persistence layer.
2. `agent.events.<agentId>` is a natural topic namespace consistent with
   `epic-<T>.wave-<N>` (T1252 A2A topics).
3. File-based fallback (`CLEO_EVENTS_TRANSPORT=file`) keeps the zero-infra
   path open for bare harnesses that cannot initialize Conduit.
4. Zero vendor lock-in — the `appendEvent` SDK op abstracts the transport.

## Transport Selection

The `appendEvent` function resolves the transport at runtime:

```
CLEO_EVENTS_TRANSPORT=conduit (default) → ConduitClient(LocalTransport | HttpTransport)
CLEO_EVENTS_TRANSPORT=file             → .cleo/agent-events/<agentId>.jsonl (NDJSON)
```

When `CLEO_EVENTS_TRANSPORT=conduit` and Conduit init fails, the function
silently falls back to file transport and logs a `[events] WARN` line.

## Event Schema

All events share this stable envelope:

```typescript
interface CleoAgentEvent {
  kind: 'spawn' | 'heartbeat' | 'tool-start' | 'tool-end' | 'commit' | 'blocked' | 'complete';
  taskId: string;
  agentId: string;
  timestamp: string;     // ISO-8601
  payload?: Record<string, unknown>;
}
```

## Spawn Prompt Injection

The `buildSpawnPrompt` function SHALL inject a standard event-emit preamble
at tier 1+ so workers automatically emit heartbeats without manual
instrumentation (acceptance criterion: auto-inject in spawn prompt macro).

This ADR implementation covers the SDK op and CLI commands; spawn-prompt
injection is tracked as a follow-up.

## Consequences

- **Positive**: Single `appendEvent` call works across all harnesses.
- **Positive**: `cleo orchestrator tail --epic <id>` can subscribe to
  `agent.events.*` without polling files.
- **Positive**: Conduit fan-out already works for remote orchestration.
- **Negative**: Conduit must be initialized before event emission (mitigated
  by file fallback).
- **Negative**: File fallback events are not observable in real-time unless
  the caller polls the file.
