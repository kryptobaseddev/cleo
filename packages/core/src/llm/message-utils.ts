/**
 * Shared transport-message utilities used across the LLM layer.
 *
 * Centralises the character/4 token-count heuristic that was previously
 * duplicated in concrete-executor.ts, llm-summarizer.ts, and concrete-session.ts.
 *
 * @module llm/message-utils
 */

import type { TransportMessage } from '@cleocode/contracts/llm/normalized-response.js';

/**
 * Approximate token count for a `TransportMessage` array.
 *
 * Uses the character / 4 heuristic — fast, dependency-free, and accurate
 * enough for budget-gating decisions (thinking budget, context compression).
 * For multimodal messages, only text blocks contribute to the estimate;
 * image blocks are skipped.
 *
 * @param messages - Conversation messages to measure.
 * @returns Estimated token count (ceiling of char-count / 4).
 */
export function estimateTransportMessageTokens(messages: readonly TransportMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') {
          chars += block.text.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}
