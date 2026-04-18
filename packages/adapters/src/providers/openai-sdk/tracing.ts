/**
 * CLEO trace processor that writes spans to conduit.db.
 *
 * `CleoConduitTraceProcessor` implements a CLEO-native tracing processor
 * interface that records spans emitted by the OpenAI SDK adapter. Post T933
 * (ADR-052 — Vercel AI SDK consolidation) the processor no longer implements
 * `@openai/agents` type surfaces; instead it consumes `CleoSpan` events
 * produced by `OpenAiSdkSpawnProvider` during a run.
 *
 * Tracing is on by default for all OpenAI SDK spawns. Set
 * `options.tracingDisabled = true` in `SpawnContext.options` to opt out when
 * conduit is unavailable.
 *
 * @task T582 (original)
 * @task T933 (SDK consolidation — provider-neutral rewrite)
 */

import type { ConduitSpanEvent } from '../shared/conduit-trace-writer.js';
import { writeSpanBatchToConduit } from '../shared/conduit-trace-writer.js';

// ---------------------------------------------------------------------------
// CLEO-native span shape
// ---------------------------------------------------------------------------

/** Span category emitted by the OpenAI SDK adapter. */
export type CleoSpanKind = 'agent' | 'handoff' | 'function' | 'model' | 'custom';

/**
 * CLEO-native span payload produced by the OpenAI SDK adapter.
 *
 * @remarks
 * Intentionally mirrors the subset of `@openai/agents` span data CLEO
 * actually consumed, rebuilt as a provider-neutral record.
 */
export interface CleoSpan {
  /** Deterministic span identifier. */
  spanId: string;
  /** ISO timestamp when the span started. */
  startedAt?: string;
  /** ISO timestamp when the span ended. */
  endedAt?: string;
  /** Structured span data (type discriminates payload shape). */
  spanData?: CleoSpanData;
}

/** Agent-kind span payload. */
export interface CleoAgentSpanData {
  type: 'agent';
  name: string;
}

/** Handoff-kind span payload (agent delegation). */
export interface CleoHandoffSpanData {
  type: 'handoff';
  from_agent?: string;
  to_agent?: string;
}

/** Function-kind span payload (tool invocation). */
export interface CleoFunctionSpanData {
  type: 'function';
  name: string;
}

/** Catch-all for future span kinds. */
export interface CleoGenericSpanData {
  type: Exclude<CleoSpanKind, 'agent' | 'handoff' | 'function'>;
  [key: string]: unknown;
}

/** Tagged union of all span payloads. */
export type CleoSpanData =
  | CleoAgentSpanData
  | CleoHandoffSpanData
  | CleoFunctionSpanData
  | CleoGenericSpanData;

/** CLEO-native trace envelope — currently opaque to the processor. */
export interface CleoTrace {
  /** Trace identifier. */
  traceId?: string;
  /** Free-form metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * CLEO-native trace processor contract.
 *
 * @remarks
 * Replaces `TracingProcessor` from `@openai/agents`. The shape is compatible
 * with the legacy interface so downstream consumers can continue to invoke
 * the same methods.
 */
export interface CleoTraceProcessor {
  onTraceStart(trace: CleoTrace): Promise<void>;
  onTraceEnd(trace: CleoTrace): Promise<void>;
  onSpanStart(span: CleoSpan): Promise<void>;
  onSpanEnd(span: CleoSpan): Promise<void>;
  shutdown(timeout?: number): Promise<void>;
  forceFlush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * CLEO trace processor that persists OpenAI SDK adapter spans to conduit.db.
 *
 * Each `onSpanEnd` call extracts span metadata and enqueues a write to conduit
 * via the shared `conduit-trace-writer` module. Writes are fire-and-forget —
 * failures are logged but never propagated to the caller.
 *
 * @remarks
 * `onTraceEnd` performs a batch flush of any buffered spans. Individual
 * `onSpanEnd` calls also write immediately so spans are not lost if the run
 * is interrupted.
 *
 * @example
 * ```typescript
 * import { registerTraceProcessor } from './spawn.js';
 * import { CleoConduitTraceProcessor } from './tracing.js';
 *
 * const processor = new CleoConduitTraceProcessor('T582');
 * registerTraceProcessor(processor);
 * ```
 */
export class CleoConduitTraceProcessor implements CleoTraceProcessor {
  /** CLEO task ID included in every span event for correlation. */
  private readonly taskId: string;

  /** Pending span events buffered within the current trace. */
  private pendingEvents: ConduitSpanEvent[] = [];

  /**
   * @param taskId - CLEO task ID to attach to every written span.
   */
  constructor(taskId: string) {
    this.taskId = taskId;
  }

  /**
   * Called when a new trace starts. Resets the pending event buffer.
   *
   * @param _trace - The trace that just started (unused).
   */
  async onTraceStart(_trace: CleoTrace): Promise<void> {
    this.pendingEvents = [];
  }

  /**
   * Called when a trace ends. Flushes all pending span events to conduit.
   *
   * @param _trace - The trace that just ended (unused — spans were captured via `onSpanEnd`).
   */
  async onTraceEnd(_trace: CleoTrace): Promise<void> {
    if (this.pendingEvents.length > 0) {
      await writeSpanBatchToConduit(this.pendingEvents);
      this.pendingEvents = [];
    }
  }

  /**
   * Called when a new span starts. No-op — we capture on end to have full timing.
   *
   * @param _span - The span that just started (unused).
   */
  async onSpanStart(_span: CleoSpan): Promise<void> {
    // Capture on end so startedAt / endedAt are both populated.
  }

  /**
   * Called when a span ends. Serialises and writes the span to conduit.
   *
   * @param span - The completed span from the adapter.
   */
  async onSpanEnd(span: CleoSpan): Promise<void> {
    const event = this.extractSpanEvent(span);
    if (event) {
      this.pendingEvents.push(event);
      // Also write immediately to survive partial run interruptions.
      await writeSpanBatchToConduit([event]);
    }
  }

  /**
   * Called during graceful shutdown. Flushes any remaining pending events.
   *
   * @param _timeout - Shutdown timeout in milliseconds (unused).
   */
  async shutdown(_timeout?: number): Promise<void> {
    if (this.pendingEvents.length > 0) {
      await writeSpanBatchToConduit(this.pendingEvents);
      this.pendingEvents = [];
    }
  }

  /**
   * Force-flush all pending span events to conduit immediately.
   */
  async forceFlush(): Promise<void> {
    if (this.pendingEvents.length > 0) {
      await writeSpanBatchToConduit(this.pendingEvents);
      this.pendingEvents = [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract a {@link ConduitSpanEvent} from an adapter span, or `null` if the
   * span cannot be meaningfully serialised.
   *
   * @param span - The adapter span to serialise.
   * @returns A conduit span event or `null`.
   */
  private extractSpanEvent(span: CleoSpan): ConduitSpanEvent | null {
    const spanId =
      span.spanId ?? `span-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    // Guard against malformed/empty spans (e.g. in unit tests with minimal mocks).
    if (!span.spanData) return null;

    const data = span.spanData;
    const spanType = data.type;

    // Extract agent name from span data shape based on type.
    let agentName = 'unknown';
    let handoffTarget: string | undefined;

    if (data.type === 'agent') {
      agentName = data.name;
    } else if (data.type === 'handoff') {
      agentName = data.from_agent ?? 'unknown';
      handoffTarget = data.to_agent ?? undefined;
    } else if (data.type === 'function') {
      agentName = data.name;
    }

    const startTime = span.startedAt ?? new Date().toISOString();
    const endTime = span.endedAt ?? new Date().toISOString();

    return {
      spanId,
      taskId: this.taskId,
      agentName,
      spanType,
      startTime,
      endTime,
      handoffTarget,
      metadata: {
        rawSpanData: data,
      },
    };
  }
}
