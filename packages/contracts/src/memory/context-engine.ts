/**
 * ContextEngine interface contract — canonical location.
 *
 * Defines the compression contract used by {@link LlmExecutor} to keep
 * session history within the model's context budget. An engine is injected
 * at executor construction time; when absent the executor silently skips
 * all compression checks.
 *
 * @module memory/context-engine
 * @task T9304
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see ADR-072 §"LlmExecutor — agent-loop level"
 */

import type { TransportMessage } from '../llm/normalized-response.js';

// ---------------------------------------------------------------------------
// CompressedContext
// ---------------------------------------------------------------------------

/**
 * Result returned by {@link ContextEngine.compress}.
 *
 * Carries the compressed message array alongside before/after token counts so
 * the executor can emit a `context_compressed` event with accurate metrics.
 */
export interface CompressedContext {
  /** The compressed message array that replaces the original history. */
  readonly compressedMessages: TransportMessage[];
  /** Estimated token count of the original history before compression. */
  readonly beforeTokens: number;
  /** Estimated token count of the compressed history after compression. */
  readonly afterTokens: number;
}

// ---------------------------------------------------------------------------
// ContextEngine
// ---------------------------------------------------------------------------

/**
 * Optional context-compression engine supplied to {@link LlmExecutor}.
 *
 * When present, the executor calls {@link shouldCompress} before each model
 * turn. If it returns `true`, the executor calls {@link compress} to reduce
 * the session history, replaces it with {@link CompressedContext.compressedMessages},
 * then emits a `context_compressed` event with the before/after token counts.
 *
 * When absent (undefined), the executor skips all compression checks silently.
 *
 * @see ADR-072 §"LlmExecutor — agent-loop level"
 */
export interface ContextEngine {
  /**
   * Returns `true` when the current prompt size warrants compression.
   *
   * The executor passes the estimated prompt token count and the model's
   * effective context budget so the engine can apply a threshold ratio
   * (e.g. compress when `promptTokens / contextBudget >= 0.75`).
   *
   * @param promptTokens - Estimated token count of the current session history.
   * @param contextBudget - Effective context-window budget for the bound model.
   * @returns Whether compression should be applied before the next model turn.
   */
  shouldCompress(promptTokens: number, contextBudget: number): boolean;

  /**
   * Compresses the session history and returns the result.
   *
   * Implementations SHOULD preserve the first few and last few messages
   * verbatim to maintain context anchoring, and summarize the middle window
   * via an auxiliary LLM call.
   *
   * @param messages - Current read-only conversation history snapshot.
   * @param focusTopic - Optional topic hint to guide summarization focus.
   * @returns Promise resolving to the compressed context with token metrics.
   */
  compress(messages: readonly TransportMessage[], focusTopic?: string): Promise<CompressedContext>;
}
