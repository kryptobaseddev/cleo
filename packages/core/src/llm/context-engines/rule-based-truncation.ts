/**
 * RuleBasedTruncationEngine — deterministic ContextEngine with no LLM dependency.
 *
 * Implements the {@link ContextEngine} contract via token-budget-aware FIFO
 * dropping: the oldest user/assistant pairs are discarded first, and system
 * messages (role `'tool'` treated as structural context) are never dropped.
 *
 * ## Algorithm
 *
 * 1. Split messages into three buckets:
 *    - **Leading system messages** — all leading `tool`-role messages
 *      (preserved unconditionally).
 *    - **Middle window** — the conversation body eligible for dropping.
 *    - **Tail messages** — the last {@link KEEP_TAIL} messages (preserved
 *      unconditionally to maintain recent context).
 * 2. Estimate tokens for all three buckets.
 * 3. If `total tokens <= targetBudget`, return messages unchanged.
 * 4. Otherwise, drop oldest middle messages (FIFO, whole pairs where possible)
 *    until the estimated token count fits within the budget.
 *
 * The engine is **side-effect-free** and **deterministic** — identical inputs
 * always produce identical outputs. It never makes network calls.
 *
 * @module llm/context-engines/rule-based-truncation
 * @task T9312
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see packages/contracts/src/memory/context-engine.ts
 */

import type { TransportMessage } from '@cleocode/contracts/llm/normalized-response.js';
import type {
  CompressedContext,
  ContextEngine,
} from '@cleocode/contracts/memory/context-engine.js';
import { estimateTransportMessageTokens } from '../message-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Compression triggers when `promptTokens / contextBudget >= this ratio`. */
export const TRUNCATION_RATIO = 0.75;

/** Minimum prompt tokens before compression is considered. */
export const MIN_TRUNCATION_TOKENS = 500;

/**
 * Number of messages at the tail of the history to preserve unconditionally.
 *
 * Keeping recent messages verbatim prevents the model from losing immediate
 * task context even after aggressive truncation of older history.
 */
export const KEEP_TAIL = 4;

// ---------------------------------------------------------------------------
// RuleBasedTruncationEngine
// ---------------------------------------------------------------------------

/**
 * Deterministic, non-LLM {@link ContextEngine} that truncates history by
 * dropping the oldest eligible messages until the token estimate fits the
 * budget.
 *
 * @example
 * ```ts
 * const engine = new RuleBasedTruncationEngine();
 * const factory = new DefaultLlmExecutorFactory({ contextEngine: engine });
 * const executor = await factory.createForRole('orchestrator');
 * ```
 */
export class RuleBasedTruncationEngine implements ContextEngine {
  /**
   * Returns `true` when the prompt is large enough to warrant truncation.
   *
   * Truncation triggers when BOTH conditions hold:
   *   - `promptTokens >= MIN_TRUNCATION_TOKENS`
   *   - `promptTokens / contextBudget >= TRUNCATION_RATIO`
   *
   * @param promptTokens - Estimated token count of the current session history.
   * @param contextBudget - Effective context-window budget for the bound model.
   * @returns Whether truncation should be applied before the next model turn.
   */
  shouldCompress(promptTokens: number, contextBudget: number): boolean {
    if (promptTokens < MIN_TRUNCATION_TOKENS) return false;
    return promptTokens / contextBudget >= TRUNCATION_RATIO;
  }

  /**
   * Truncates the session history by dropping the oldest non-system messages.
   *
   * The target budget is `contextBudget * (1 - TRUNCATION_RATIO)` worth of
   * headroom — i.e. after truncation the history should consume at most
   * `TRUNCATION_RATIO - 0.1` of the context window. In practice the method
   * drops messages FIFO from the middle window until the estimated token
   * count is at or below `targetTokens`.
   *
   * This method is intentionally synchronous-compatible (returns a resolved
   * promise) to satisfy the async contract without incurring any I/O.
   *
   * @param messages - Current read-only conversation history snapshot.
   * @param _focusTopic - Unused — included for interface compatibility.
   * @returns Resolved promise with the truncated context and token metrics.
   */
  async compress(
    messages: readonly TransportMessage[],
    _focusTopic?: string,
  ): Promise<CompressedContext> {
    const beforeTokens = estimateTransportMessageTokens(messages);

    // Partition: leading tool messages are treated as structural system context.
    let leadingSystemEnd = 0;
    while (leadingSystemEnd < messages.length && messages[leadingSystemEnd]?.role === 'tool') {
      leadingSystemEnd++;
    }

    const leadingSystem = messages.slice(0, leadingSystemEnd);
    const remaining = messages.slice(leadingSystemEnd);

    // Preserve the tail regardless of token pressure.
    const tailStart = Math.max(0, remaining.length - KEEP_TAIL);
    const middle = remaining.slice(0, tailStart);
    const tail = remaining.slice(tailStart);

    // Target: reduce to 60% of the budget so we have headroom for the reply.
    // We just need to drop enough to clear the pressure — exact budget is
    // supplied by the executor but we don't have it here, so we target
    // dropping enough to get below MIN_TRUNCATION_TOKENS as a safe floor.
    const targetTokens = Math.max(
      MIN_TRUNCATION_TOKENS - 1,
      Math.floor(beforeTokens * (1 - TRUNCATION_RATIO)),
    );

    // FIFO: drop from the front of the middle window.
    let dropCount = 0;
    let currentTokens = estimateTransportMessageTokens([...leadingSystem, ...middle, ...tail]);

    while (currentTokens > targetTokens && dropCount < middle.length) {
      dropCount++;
      currentTokens = estimateTransportMessageTokens([
        ...leadingSystem,
        ...middle.slice(dropCount),
        ...tail,
      ]);
    }

    const compressedMessages: TransportMessage[] = [
      ...leadingSystem,
      ...middle.slice(dropCount),
      ...tail,
    ];

    const afterTokens = estimateTransportMessageTokens(compressedMessages);

    return { compressedMessages, beforeTokens, afterTokens };
  }
}
