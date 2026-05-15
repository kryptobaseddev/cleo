/**
 * LlmSummarizationEngine — default ContextEngine backed by an LLM.
 *
 * Implements the Hermes §7.6 SUMMARY_PREFIX compression pattern:
 *   1. Keep the first {@link KEEP_FIRST} messages verbatim (system context).
 *   2. Keep the last {@link KEEP_LAST} messages verbatim (recent context).
 *   3. Summarize the middle window via a single {@link LlmExecutor.auxiliary} call
 *      using the `'compression'` role (cheap haiku-class model).
 *
 * Threshold: compress when `promptTokens / contextBudget >= 0.75`.
 *
 * @module memory/context-engines/llm-summarizer
 * @task T9304
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see packages/contracts/src/memory/context-engine.ts
 */

import type { TransportMessage } from '@cleocode/contracts/llm/normalized-response.js';
import type {
  CompressedContext,
  ContextEngine,
} from '@cleocode/contracts/memory/context-engine.js';
import { getLlmExecutor } from '../../llm/executor-factory.js';
import { estimateTransportMessageTokens } from '../../llm/message-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum estimated tokens before compression is even attempted. */
export const MIN_SUMMARY_TOKENS = 2_000;

/** Compression threshold ratio — compress when prompt fills >= 75% of budget. */
export const SUMMARY_RATIO = 0.2;

/** Upper bound on summary output tokens to keep the compressed history small. */
export const SUMMARY_TOKENS_CEILING = 12_000;

/** Number of messages to preserve verbatim from the start of history. */
const KEEP_FIRST = 3;

/** Number of messages to preserve verbatim from the end of history. */
const KEEP_LAST = 6;

/** Hermes §7.6 SUMMARY_PREFIX header injected into the compression prompt. */
const SUMMARY_PREFIX = `## Conversation Summary

The following is a compressed summary of the conversation so far. Key decisions, context, and state are preserved below. Continuation messages follow after this summary.

---
`;

// ---------------------------------------------------------------------------
// LlmSummarizationEngine
// ---------------------------------------------------------------------------

/**
 * Default {@link ContextEngine} implementation using LLM-backed summarization.
 *
 * Uses the `'compression'` role (resolved via `getLlmExecutor('compression')`)
 * so the provider + model + credential come from `config.llm.roles.compression`
 * → `config.llm.default` → `config.llm.daemon` → implicit haiku fallback.
 *
 * @example
 * ```ts
 * const engine = new LlmSummarizationEngine();
 * const factory = new DefaultLlmExecutorFactory({ contextEngine: engine });
 * const executor = await factory.createForRole('orchestrator');
 * ```
 */
export class LlmSummarizationEngine implements ContextEngine {
  /**
   * Returns `true` when the prompt is large enough to warrant compression.
   *
   * Compression triggers when BOTH conditions hold:
   *   - `promptTokens >= MIN_SUMMARY_TOKENS`
   *   - `promptTokens / contextBudget >= 0.75`
   *
   * @param promptTokens - Estimated token count of the current session history.
   * @param contextBudget - Effective context-window budget for the bound model.
   */
  shouldCompress(promptTokens: number, contextBudget: number): boolean {
    if (promptTokens < MIN_SUMMARY_TOKENS) return false;
    return promptTokens / contextBudget >= 0.75;
  }

  /**
   * Compresses the session history using LLM summarization.
   *
   * Preserves the first {@link KEEP_FIRST} and last {@link KEEP_LAST} messages
   * verbatim. The middle window is summarized via an auxiliary LLM call with the
   * {@link SUMMARY_PREFIX} header, producing a single synthetic `assistant`
   * message that replaces the middle turns.
   *
   * @param messages - Current read-only conversation history snapshot.
   * @param focusTopic - Optional topic hint appended to the summarization prompt.
   * @returns The compressed context with before/after token estimates.
   */
  async compress(
    messages: readonly TransportMessage[],
    focusTopic?: string,
  ): Promise<CompressedContext> {
    const beforeTokens = estimateTransportMessageTokens(messages);

    // When history is short enough to fit entirely in the kept windows,
    // return it unchanged to avoid a no-op LLM call.
    if (messages.length <= KEEP_FIRST + KEEP_LAST) {
      return { compressedMessages: [...messages], beforeTokens, afterTokens: beforeTokens };
    }

    const head = messages.slice(0, KEEP_FIRST);
    const tail = messages.slice(messages.length - KEEP_LAST);
    const middle = messages.slice(KEEP_FIRST, messages.length - KEEP_LAST);

    const summary = await _summarizeMiddle(middle, focusTopic);

    const summaryMsg: TransportMessage = {
      role: 'assistant',
      content: SUMMARY_PREFIX + summary,
    };

    const compressedMessages: TransportMessage[] = [...head, summaryMsg, ...tail];
    const afterTokens = estimateTransportMessageTokens(compressedMessages);

    return { compressedMessages, beforeTokens, afterTokens };
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Ask the compression-role executor to summarize a slice of conversation.
 *
 * Falls back to a static placeholder when the LLM call fails (e.g. no
 * credential configured) so compression never hard-fails.
 */
async function _summarizeMiddle(
  middle: readonly TransportMessage[],
  focusTopic?: string,
): Promise<string> {
  const serialized = middle
    .map((m) => `[${m.role}]: ${typeof m.content === 'string' ? m.content : ''}`)
    .join('\n\n');

  const topicHint = focusTopic ? `\n\nFocus on aspects related to: ${focusTopic}` : '';

  const prompt = `Summarize the following conversation excerpt concisely, preserving all key decisions, context, and state. Use clear markdown with bullet points for facts.${topicHint}\n\n---\n${serialized}\n---`;

  try {
    const executor = await getLlmExecutor('compression');
    const response = await executor.auxiliary([{ role: 'user', content: prompt }]);
    return response.content ?? '[Summary unavailable]';
  } catch {
    return '[Conversation summary omitted — compression role unavailable]';
  }
}
