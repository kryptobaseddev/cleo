/**
 * Session and executor interface contracts for the unified LLM provider architecture.
 *
 * Introduces the two missing abstraction layers that wire Phase 3 utility
 * modules into the live execution path:
 *
 * - {@link LlmSession} — stateful per-conversation layer (history, OAuth refresh,
 *   rate-limit guard, credential pool rotation, retry policy).
 * - {@link LlmExecutor} — agent-loop layer (tool-call orchestration, multi-turn
 *   replay, context compression, usage aggregation).
 *
 * Supporting types: {@link ExecutionRequest}, {@link ExecutionEvent},
 * {@link AggregatedUsage}, {@link ToolCall}, {@link RetryPolicy},
 * {@link SendOptions}, {@link TransportContext}, {@link NormalizedDelta}.
 *
 * Factory interfaces: {@link LlmSessionFactory}, {@link LlmExecutorFactory}.
 *
 * @module llm/interfaces
 * @task T9281
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see ADR-072 §Decision
 */

import type { ClassifiedError } from './failover-reason.js';
import type {
  LlmTransport,
  NormalizedResponse,
  NormalizedUsage,
  TransportMessage,
  TransportRequest,
  TransportTool,
} from './normalized-response.js';
import type { ProviderId } from './provider-id.js';

// Re-export canonical ContextEngine types from their new home in memory/.
// The definition was moved to packages/contracts/src/memory/context-engine.ts
// (T9304) so that the memory package can import it without a circular dep on
// the llm/ subtree. This re-export preserves back-compat for all existing
// consumers that import ContextEngine from llm/interfaces.js.
export type { CompressedContext, ContextEngine } from '../memory/context-engine.js';
// Re-export LlmTransport so consumers of this module can reference it without
// an additional import from normalized-response.js.
export type { LlmTransport };

// ---------------------------------------------------------------------------
// Streaming delta
// ---------------------------------------------------------------------------

/**
 * A single streaming chunk emitted by {@link LlmTransport.stream}.
 *
 * `text` carries the incremental visible content. `reasoning` carries
 * incremental reasoning/thinking output (Anthropic extended-thinking,
 * OpenAI o1-series). Either field may be an empty string when the delta
 * carries content for the other field only.
 *
 * `toolCallDelta` is populated for streaming tool-call argument deltas —
 * consumers must accumulate these to reconstruct the full JSON arguments string.
 */
export interface NormalizedDelta {
  /** Incremental visible text content. Empty string when delta is tool-call-only. */
  readonly text: string;
  /** Incremental reasoning/thinking output. Empty string when not present. */
  readonly reasoning: string;
  /** Partial tool-call argument delta, if this chunk is part of a tool call. */
  readonly toolCallDelta?: {
    /** Index of the tool call being streamed (for multi-tool-call responses). */
    readonly index: number;
    /** Tool name (only present on the first delta for this index). */
    readonly name?: string;
    /** Partial arguments JSON fragment. */
    readonly argumentsChunk: string;
  };
  /** Stop reason, populated on the final delta only. null for non-final deltas. */
  readonly stopReason: string | null;
  /** Usage accounting, populated on the final delta only. null for non-final deltas. */
  readonly usage: NormalizedUsage | null;
}

// ---------------------------------------------------------------------------
// Transport execution context
// ---------------------------------------------------------------------------

/**
 * Contextual metadata supplied to {@link LlmTransport.complete} and
 * {@link LlmTransport.stream} alongside the request payload.
 *
 * Transports use this to set per-request metadata (request IDs, abort signals,
 * feature flags) without polluting {@link TransportRequest}.
 */
export interface TransportContext {
  /**
   * Unique identifier for this transport call.
   * Typically matches the parent session or executor call ID.
   */
  readonly requestId: string;
  /** AbortSignal for request cancellation. */
  readonly signal?: AbortSignal;
  /**
   * Whether to enable extended thinking / reasoning mode.
   * Only honoured by providers that support it (Anthropic, OpenAI o-series).
   */
  readonly enableThinking?: boolean;
  /**
   * Per-provider feature flags surfaced from {@link SendOptions}.
   * Transports MUST ignore keys they do not recognise.
   */
  readonly providerFlags?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * Exponential-backoff retry policy for {@link LlmSession.send}.
 *
 * Backoff delay for attempt `n` (0-indexed) is computed as:
 * `min(baseDelayMs * 2^n + jitter, maxDelayMs)`
 * where `jitter` is a random value in `[0, baseDelayMs * 0.1]` when
 * {@link jitter} is `true`.
 */
export interface RetryPolicy {
  /** Maximum number of send attempts (1 = no retry). */
  readonly maxAttempts: number;
  /** Base delay in milliseconds before the first retry. */
  readonly baseDelayMs: number;
  /** Maximum delay cap in milliseconds. */
  readonly maxDelayMs: number;
  /** Whether to add random jitter to prevent thundering-herd retries. */
  readonly jitter: boolean;
}

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

/**
 * Per-call options passed to {@link LlmSession.send} and
 * {@link LlmSession.stream}.
 *
 * All fields are optional. Unset fields fall back to the session defaults
 * established at construction time.
 */
export interface SendOptions {
  /**
   * Prompt-cache breakpoint injection strategy.
   *
   * - `'system_and_3'` — inject cache breakpoints after the system prompt and
   *   after the last 3 user messages (Anthropic extended-caching strategy).
   * - `'prefix_and_2'` — inject at the shared prefix boundary and after 2
   *   most-recent turns (optimised for Gemini cached content).
   * - `null` — no cache injection (default when not set).
   */
  readonly cacheStrategy?: 'system_and_3' | 'prefix_and_2' | null;
  /**
   * Override the retry policy for this specific call.
   * When omitted, the session-level {@link RetryPolicy} applies.
   */
  readonly retryPolicy?: RetryPolicy;
  /**
   * Additional system prompt text appended to the session default system prompt.
   * Useful for injecting per-call context (e.g. tool result summaries).
   */
  readonly systemSuffix?: string;
  /**
   * Whether to enable extended thinking / reasoning for this call.
   * Defaults to false. Only effective on providers that support it.
   */
  readonly enableThinking?: boolean;
  /**
   * Per-provider feature flags passed through to {@link TransportContext.providerFlags}.
   * Transports MUST ignore flags they do not recognise.
   */
  readonly providerFlags?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Session interface
// ---------------------------------------------------------------------------

/**
 * Stateful per-conversation LLM session.
 *
 * Owns: conversation history, OAuth refresh (pre-call check against
 * `ResolvedCredential.expiresAt < 60s`), `RateLimitGuard` pre-check,
 * `CredentialPool` rotation on retriable errors (driven by
 * `classifyError(err).shouldRotateCredential`), and retry policy with
 * exponential backoff.
 *
 * Sessions are one-per-conversation; NOT shared across parallel agents.
 *
 * @see ADR-072 §Decision §"LlmSession — session level"
 */
export interface LlmSession {
  /** Underlying wire-level transport used by this session. */
  readonly transport: LlmTransport;
  /** Model identifier this session is bound to. */
  readonly model: string;
  /**
   * Returns a snapshot of the current conversation history.
   * The returned array is read-only — mutate via {@link append} or
   * {@link truncateHistory}.
   */
  history(): readonly TransportMessage[];
  /**
   * Appends a message to the conversation history.
   *
   * @param message - The message to append.
   */
  append(message: TransportMessage): void;
  /**
   * Truncates the conversation history, keeping `keepFirst` messages from
   * the start and `keepLast` messages from the end.
   *
   * Messages between the two preserved windows are dropped. If
   * `keepFirst + keepLast >= history.length`, the history is left unchanged.
   *
   * @param keepFirst - Number of messages to preserve from the start.
   * @param keepLast - Number of messages to preserve from the end.
   */
  truncateHistory(keepFirst: number, keepLast: number): void;
  /**
   * Executes a single completion call with the supplied messages.
   *
   * Handles pre-call OAuth refresh, rate-limit guard check, cache-breakpoint
   * injection per `opts.cacheStrategy`, retry with exponential backoff, and
   * credential pool rotation on retriable errors.
   *
   * @param messages - Messages to send (NOT appended to history automatically).
   * @param opts - Optional per-call overrides.
   * @returns A promise resolving to the normalized provider response.
   */
  send(messages: TransportMessage[], opts?: SendOptions): Promise<NormalizedResponse>;
  /**
   * Streaming variant of {@link send}.
   *
   * Yields {@link NormalizedDelta} chunks as they arrive. The final delta
   * carries {@link NormalizedDelta.stopReason} and {@link NormalizedDelta.usage}.
   *
   * @param messages - Messages to send.
   * @param opts - Optional per-call overrides.
   * @returns An async iterable of delta chunks.
   */
  stream(messages: TransportMessage[], opts?: SendOptions): AsyncIterable<NormalizedDelta>;
  /**
   * Refreshes the OAuth credential bound to this session.
   *
   * Called automatically by {@link send} / {@link stream} when
   * `ResolvedCredential.expiresAt` is less than 60 seconds in the future.
   * May also be called manually by callers that track token expiry independently.
   */
  refreshCredential(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Executor types
// ---------------------------------------------------------------------------

/**
 * A resolved tool call produced by the model within an executor run.
 *
 * Distinct from {@link NormalizedToolCall} (which is the wire-level shape).
 * `ToolCall` carries the parsed `args` object so executor consumers do not
 * need to JSON-parse the arguments string themselves.
 */
export interface ToolCall {
  /** Provider-assigned tool-call id (may be null if provider does not surface one). */
  readonly id: string | null;
  /** Tool name as declared in the {@link ExecutionRequest}. */
  readonly name: string;
  /** Parsed arguments object (JSON-parsed from the provider arguments string). */
  readonly args: Record<string, unknown>;
  /** Raw arguments string from the provider (pre-parse). */
  readonly rawArguments: string;
}

/**
 * Usage totals aggregated across all iterations of an executor run.
 *
 * `costUsd` is computed via `computeCost` from `@cleocode/core` using the
 * `usage-pricing` snapshot. It may be `null` when the model is not present
 * in the pricing table.
 */
export interface AggregatedUsage {
  /** Total input tokens consumed across all iterations. */
  readonly totalInputTokens: number;
  /** Total output tokens generated across all iterations. */
  readonly totalOutputTokens: number;
  /** Total tokens served from prompt cache across all iterations. */
  readonly totalCachedTokens: number;
  /** Number of LLM API calls made during the run. */
  readonly iterations: number;
  /**
   * Estimated total cost in USD. null when the model is absent from the
   * pricing table or pricing data is unavailable.
   */
  readonly costUsd: number | null;
}

/**
 * Discriminated-union event emitted by {@link LlmExecutor.run}.
 *
 * Consumers iterate the async generator and switch on `kind` to handle
 * each event type.
 *
 * Six variants:
 * - `response` — model emitted a text response (no tool call).
 * - `tool_call` — model requested a tool call; executor is about to invoke it.
 * - `tool_result` — tool handler returned a result; executor will continue the loop.
 * - `context_compressed` — context engine compressed history to fit the context window.
 * - `done` — run completed; aggregated usage is available.
 * - `error` — an unrecoverable error terminated the run.
 */
export type ExecutionEvent =
  | {
      /** Model emitted a text response (no tool call). */
      readonly kind: 'response';
      /** The full normalized response from the model. */
      readonly response: NormalizedResponse;
    }
  | {
      /** Model requested a tool call. */
      readonly kind: 'tool_call';
      /** The resolved tool call with parsed arguments. */
      readonly toolCall: ToolCall;
      /** Current iteration index (0-indexed). */
      readonly iteration: number;
    }
  | {
      /** Tool handler returned a result; executor will feed it back to the model. */
      readonly kind: 'tool_result';
      /** Id of the tool call this result resolves. */
      readonly toolCallId: string | null;
      /** Tool name. */
      readonly toolName: string;
      /** Raw result as a string (JSON-serialized if the handler returned an object). */
      readonly result: string;
      /** Current iteration index (0-indexed). */
      readonly iteration: number;
    }
  | {
      /** Context engine compressed history to fit the context window. */
      readonly kind: 'context_compressed';
      /** Token count before compression. */
      readonly tokensBefore: number;
      /** Token count after compression. */
      readonly tokensAfter: number;
    }
  | {
      /** Run completed successfully. */
      readonly kind: 'done';
      /** Aggregated usage across all iterations. */
      readonly usage: AggregatedUsage;
      /** Final normalized response from the last model turn. */
      readonly finalResponse: NormalizedResponse;
    }
  | {
      /** An unrecoverable error terminated the run. */
      readonly kind: 'error';
      /** Structured error classification. */
      readonly error: ClassifiedError;
      /** Iteration index at which the error occurred. */
      readonly iteration: number;
    };

/**
 * Parameters for a single {@link LlmExecutor.run} invocation.
 *
 * `tools` is the full set of tools available in this run. The executor
 * routes tool calls to `toolHandler` and feeds results back to the model
 * until the model emits a stop reason other than `'tool_use'` / `'tool_calls'`.
 */
export interface ExecutionRequest {
  /** Initial messages to send to the model. */
  readonly messages: TransportMessage[];
  /**
   * Tools available in this run.
   * When empty or omitted, tool-call orchestration is skipped.
   */
  readonly tools?: TransportTool[];
  /**
   * Handler invoked for each tool call.
   *
   * Receives the resolved {@link ToolCall} and must return the tool result as
   * a string (or a JSON-serializable value that the executor will stringify).
   * Throwing causes the executor to emit an `error` event and terminate.
   */
  readonly toolHandler?: (call: ToolCall) => Promise<string | Record<string, unknown>>;
  /**
   * Maximum number of tool-call iterations before the executor terminates.
   * Defaults to 10. Set to 1 to allow a single model turn with no tool calls.
   */
  readonly maxIterations?: number;
  /** Per-call send options forwarded to {@link LlmSession.send}. */
  readonly sendOptions?: SendOptions;
}

// ---------------------------------------------------------------------------
// Context engine (canonical definition: packages/contracts/src/memory/context-engine.ts)
// ---------------------------------------------------------------------------
// ContextEngine and CompressedContext are re-exported above from their new
// canonical location. This section is intentionally empty — see the re-export
// near the top of this file.

// ---------------------------------------------------------------------------
// Executor interface
// ---------------------------------------------------------------------------

/**
 * Agent-loop level LLM executor.
 *
 * Owns: tool-call orchestration, multi-turn replay, `ContextEngine`
 * integration (compress when `shouldCompress(currentTokens)` returns true),
 * usage aggregation, and {@link ExecutionEvent} discriminated-union emission.
 *
 * `auxiliary()` is the single-turn no-tool-loop side-channel for context
 * compression, dream cycles, and hygiene scans.
 *
 * @see ADR-072 §Decision §"LlmExecutor — agent-loop level"
 */
export interface LlmExecutor {
  /** The underlying session used for all LLM calls. */
  readonly session: LlmSession;
  /**
   * Executes the full agent loop for the given request.
   *
   * Yields {@link ExecutionEvent} values as they occur. The generator
   * terminates when the model returns a non-tool-call stop reason, the
   * `maxIterations` limit is reached, or an unrecoverable error occurs.
   *
   * @param request - The execution parameters including messages, tools, and handler.
   * @returns An async generator of execution events.
   */
  run(request: ExecutionRequest): AsyncIterable<ExecutionEvent>;
  /**
   * Executes a single-turn no-tool-loop completion.
   *
   * Intended for auxiliary calls that must NOT enter the tool-call loop:
   * context compression summaries, dream cycles, hygiene scans. Uses the same
   * underlying {@link LlmSession} but bypasses tool registration and iteration
   * tracking.
   *
   * @param messages - Messages to send.
   * @param opts - Optional per-call overrides.
   * @returns A promise resolving to the normalized provider response.
   */
  auxiliary(messages: TransportMessage[], opts?: SendOptions): Promise<NormalizedResponse>;
}

// ---------------------------------------------------------------------------
// Factory types
// ---------------------------------------------------------------------------

/**
 * Options for constructing an {@link LlmSession} via {@link LlmSessionFactory}.
 */
export interface SessionFactoryOptions {
  /**
   * Role name used to resolve the provider and model via `resolveLLMForRole`.
   * Mutually exclusive with {@link providerId} + {@link model}.
   */
  readonly role?: string;
  /**
   * Explicit provider id. Must be paired with {@link model}.
   * Mutually exclusive with {@link role}.
   */
  readonly providerId?: ProviderId;
  /**
   * Explicit model identifier. Must be paired with {@link providerId}.
   * Mutually exclusive with {@link role}.
   */
  readonly model?: string;
  /** Retry policy for the session. Falls back to the factory default when omitted. */
  readonly retryPolicy?: RetryPolicy;
}

/**
 * Factory for creating {@link LlmSession} instances.
 *
 * Abstracts the resolution chain:
 * `role → resolveLLMForRole → ProviderRegistry → ResolvedCredential
 *  → transportForProvider(profile, credential) → new ConcreteSession(...)`.
 *
 * @see ADR-072 §2.2
 */
export interface LlmSessionFactory {
  /**
   * Creates a session resolved from the given role name.
   *
   * @param role - CLEO role name (e.g. `'orchestrator'`, `'sentient'`).
   * @returns A promise resolving to an initialized {@link LlmSession}.
   */
  createForRole(role: string): Promise<LlmSession>;
  /**
   * Creates a session with the given options.
   *
   * @param opts - Session construction options.
   * @returns A promise resolving to an initialized {@link LlmSession}.
   */
  create(opts: SessionFactoryOptions): Promise<LlmSession>;
}

/**
 * Options for constructing an {@link LlmExecutor} via {@link LlmExecutorFactory}.
 */
export interface ExecutorFactoryOptions {
  /**
   * Pre-constructed session to use. When provided, the factory wraps it
   * directly without creating a new session.
   * Mutually exclusive with {@link sessionOptions}.
   */
  readonly session?: LlmSession;
  /**
   * Options forwarded to {@link LlmSessionFactory.create} when no explicit
   * {@link session} is supplied.
   * Mutually exclusive with {@link session}.
   */
  readonly sessionOptions?: SessionFactoryOptions;
  /**
   * Maximum number of tool-call iterations. Defaults to 10.
   * Can be overridden per-run via {@link ExecutionRequest.maxIterations}.
   */
  readonly maxIterations?: number;
}

/**
 * Factory for creating {@link LlmExecutor} instances.
 *
 * Wraps {@link LlmSessionFactory.createForRole} and constructs a
 * `ConcreteExecutor` with the resolved session, tool handler registry, and
 * optional context engine.
 *
 * @see ADR-072 §2.2
 */
export interface LlmExecutorFactory {
  /**
   * Creates an executor resolved from the given role name.
   *
   * @param role - CLEO role name (e.g. `'orchestrator'`, `'sentient'`).
   * @returns A promise resolving to an initialized {@link LlmExecutor}.
   */
  createForRole(role: string): Promise<LlmExecutor>;
  /**
   * Creates an executor with the given options.
   *
   * @param opts - Executor construction options.
   * @returns A promise resolving to an initialized {@link LlmExecutor}.
   */
  create(opts: ExecutorFactoryOptions): Promise<LlmExecutor>;
}
