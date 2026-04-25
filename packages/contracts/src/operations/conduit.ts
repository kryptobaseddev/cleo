/**
 * Conduit Domain Operations (8 operations: 3 query, 5 mutate)
 *
 * Query operations: 3
 *   - conduit.status   — connection status + unread count
 *   - conduit.peek     — one-shot poll for messages
 *   - conduit.listen   — one-shot poll for topic messages (A2A, T1252)
 * Mutate operations: 5
 *   - conduit.start    — start continuous polling
 *   - conduit.stop     — stop polling
 *   - conduit.send     — send a message
 *   - conduit.subscribe — subscribe agent to a topic (A2A, T1252)
 *   - conduit.publish  — publish message to a topic (A2A, T1252)
 *
 * CONDUIT is the agent-to-agent messaging subsystem. The protocol wraps a
 * pluggable Transport (HTTP to cloud SignalDock, LocalTransport over
 * `conduit.db`, future SSE). These wire-format contracts describe the CLI +
 * HTTP dispatch surface for `cleo agent` and equivalent programmatic calls.
 *
 * SYNC: Canonical runtime implementation at
 *   packages/cleo/src/dispatch/engines/conduit-engine.ts (T1435 Wave 1)
 * and the dispatch handler at
 *   packages/cleo/src/dispatch/domains/conduit.ts (ConduitHandler)
 * and the lower-level interfaces at
 *   packages/contracts/src/conduit.ts (Conduit, ConduitMessage, ...).
 *
 * Registry note (T964 — supersedes ADR-042 Decision 1): the dispatcher
 * registers these operations under `domain: 'conduit'` with short operation
 * names (`status`, `peek`, `start`, `stop`, `send`, `subscribe`, `publish`,
 * `listen`). The public/HTTP identifier `conduit.<op>` remains the stable
 * wire-format surface and what these contracts describe; CLI and HTTP adapters
 * map between the two forms.
 *
 * @task T910 — Orchestration Coherence v4 (contract surface completion)
 * @task T964 — CONDUIT promotion to canonical domain #15
 * @task T1422 — Typed-dispatch migration (Wave D, T975 follow-on)
 * @task T1435-W1 — Conduit dispatch refactor (OpsFromCore inference, T1436 helper)
 * @see packages/cleo/src/dispatch/engines/conduit-engine.ts
 * @see packages/cleo/src/dispatch/domains/conduit.ts
 * @see packages/contracts/src/conduit.ts
 */

// ============================================================================
// Shared Conduit wire-format types
// ============================================================================

/** Transport implementation backing a conduit call. */
export type ConduitTransportKind = 'local' | 'http' | 'sse' | 'ws';

/**
 * Compact inbox message projection returned by `conduit.peek`.
 *
 * @remarks
 * This is the LAFS-friendly wire format — a reduction of the richer
 * `ConduitMessage` interface at `../conduit.ts` that drops internal fields
 * (tags, metadata, threadId) unless the receiving client needs them. Clients
 * that want the full envelope should use the transport directly.
 */
export interface ConduitInboxMessage {
  /** Unique message id. */
  id: string;
  /** Sender agent id. */
  from: string;
  /** Message content (text). */
  content: string;
  /** Conversation / thread id when the message belongs to one. */
  conversationId?: string;
  /** ISO 8601 timestamp of delivery. */
  timestamp?: string;
}

// ============================================================================
// Note: Per-op Params/Result types removed (T1435 Wave 1)
//
// As of T1435 Wave 1, the dispatch domain infers operation types directly from
// Core function signatures using OpsFromCore<typeof coreOps>. This eliminates
// the drift class where dispatch and contracts had to be kept in sync.
//
// The per-operation *Params and *Result types that were previously defined
// here (ConduitStatusParams, ConduitStatusResult, etc.) are no longer needed
// in the contracts file. If you are building a programmatic client that
// needs these types, either:
//
// 1. Import from the Core engine wrapper:
//    import type { conduitStatus } from '@cleocode/cleo/dispatch/engines/conduit-engine';
//    (and extract Params/Result via Parameters<> and ReturnType<>)
//
// 2. Define them locally in your client based on the CLI wire format
//
// 3. Generate them from the LAFS envelope schema (future work)
//
// ============================================================================
