/**
 * OpenAI Agents SDK trace processor that writes spans to conduit.db.
 *
 * `CleoConduitTraceProcessor` implements the SDK `TracingProcessor` interface.
 * On every span end it serialises the span and writes a structured event to
 * conduit.db via the shared `conduit-trace-writer` transport layer.
 *
 * Tracing is on by default for all OpenAI SDK spawns. Set
 * `options.tracingDisabled = true` in `SpawnContext.options` to opt out when
 * conduit is unavailable.
 *
 * @task T582
 */

import type { Span, SpanData, Trace, TracingProcessor } from '@openai/agents';
import type { ConduitSpanEvent } from '../shared/conduit-trace-writer.js';
import { writeSpanBatchToConduit } from '../shared/conduit-trace-writer.js';

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * CLEO trace processor that persists OpenAI Agents SDK spans to conduit.db.
 *
 * Implements the `TracingProcessor` interface from `@openai/agents-core`.
 * Each `onSpanEnd` call extracts span metadata and enqueues a write to
 * conduit via the shared `conduit-trace-writer` module. Writes are
 * fire-and-forget — failures are logged but never propagated to the caller.
 *
 * @remarks
 * `onTraceEnd` performs a batch flush of any buffered spans. Individual
 * `onSpanEnd` calls also write immediately so spans are not lost if the run
 * is interrupted.
 *
 * @example
 * ```typescript
 * import { addTraceProcessor } from '@openai/agents';
 * import { CleoConduitTraceProcessor } from './tracing.js';
 *
 * const processor = new CleoConduitTraceProcessor('T582');
 * addTraceProcessor(processor);
 * ```
 */
export class CleoConduitTraceProcessor implements TracingProcessor {
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
  async onTraceStart(_trace: Trace): Promise<void> {
    this.pendingEvents = [];
  }

  /**
   * Called when a trace ends. Flushes all pending span events to conduit.
   *
   * @param _trace - The trace that just ended (unused — spans were captured via `onSpanEnd`).
   */
  async onTraceEnd(_trace: Trace): Promise<void> {
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
  async onSpanStart(_span: Span<SpanData>): Promise<void> {
    // Capture on end so startedAt / endedAt are both populated.
  }

  /**
   * Called when a span ends. Serialises and writes the span to conduit.
   *
   * @param span - The completed span from the SDK.
   */
  async onSpanEnd(span: Span<SpanData>): Promise<void> {
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
   * Extract a {@link ConduitSpanEvent} from an SDK span, or `null` if the
   * span cannot be meaningfully serialised.
   *
   * @param span - The SDK span to serialise.
   * @returns A conduit span event or `null`.
   */
  private extractSpanEvent(span: Span<SpanData>): ConduitSpanEvent | null {
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
