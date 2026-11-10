/**
 * CLEO-native tracing contract for the OpenAI SDK adapter.
 *
 * `OpenAiSdkSpawnProvider` emits `CleoSpan` events during a run and dispatches
 * them to every processor registered through `registerTraceProcessor`
 * (`spawn.ts`). No processor is registered by default: the former conduit
 * writer shelled out to `cleo conduit send`, which no longer exists (T14376).
 *
 * Set `options.tracingDisabled = true` in `SpawnContext.options` to suppress
 * dispatch for a run.
 *
 * @task T582 (original)
 * @task T933 (SDK consolidation — provider-neutral rewrite)
 * @task T14376 (dead conduit writer removed)
 */

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
