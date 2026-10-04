/**
 * Conversation-shaping helpers: token counting + tool-aware truncation.
 *
 * Ported from PSYCHE src/llm/conversation.py. Uses js-tiktoken for token
 * estimation (already a dep of packages/core).
 *
 * @task T1394 (T1386-W8)
 * @epic T1386
 */

import { createRequire } from 'node:module';
import type { getEncoding } from 'js-tiktoken';

/**
 * Lazily-built cl100k_base encoder.
 *
 * T12076: this was `const _enc = getEncoding('cl100k_base')` at MODULE SCOPE.
 * `getEncoding` parses the BPE vocabulary, measured at 156 ms, and this module is
 * reachable from the `@cleocode/core` barrel — so every `cleo` invocation built a
 * tokenizer table before doing anything, including commands that never count a
 * token. Deferring to first use keeps the surrounding API synchronous.
 *
 * T13126: the MODULE load moved too. A static `import` still evaluated
 * js-tiktoken (5.4 MB of source plus its base64 rank tables) in every process
 * that loads the barrel: ~20 MB of peak RSS per `cleo` call, for a tokenizer
 * almost no command uses. `countMessageTokens` is a synchronous public API, so
 * the package is required synchronously on first use. `metrics/token-service.ts`
 * imports it asynchronously; a process that uses both holds two copies of a
 * stateless encoder, which is cheaper than loading one in every process.
 */
const requireFromHere = createRequire(import.meta.url);
let _enc: ReturnType<typeof getEncoding> | null = null;

/**
 * Estimate token count for a string using tiktoken cl100k_base.
 */
function estimateTokens(text: string): number {
  if (_enc === null) {
    const tiktoken: { getEncoding: typeof getEncoding } = requireFromHere('js-tiktoken');
    _enc = tiktoken.getEncoding('cl100k_base');
  }
  return _enc.encode(text).length;
}

/**
 * Count tokens in a list of messages.
 */
export function countMessageTokens(messages: Array<Record<string, unknown>>): number {
  let total = 0;
  for (const msg of messages) {
    const content = msg['content'];
    if (typeof content === 'string') {
      total += estimateTokens(content);
    } else if (Array.isArray(content)) {
      total += estimateTokens(JSON.stringify(content));
    }
    if ('parts' in msg) {
      try {
        total += estimateTokens(JSON.stringify(msg['parts']));
      } catch {
        total += estimateTokens(String(msg['parts']));
      }
    }
  }
  return total;
}

function isToolUseMessage(msg: Record<string, unknown>): boolean {
  const content = msg['content'];
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block['type'] === 'tool_use') return true;
    }
  }
  const parts = msg['parts'];
  if (Array.isArray(parts)) {
    for (const part of parts as Array<Record<string, unknown>>) {
      if ('function_call' in part) return true;
    }
  }
  return Boolean(msg['tool_calls']);
}

function isToolResultMessage(msg: Record<string, unknown>): boolean {
  const content = msg['content'];
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block['type'] === 'tool_result') return true;
    }
  }
  const parts = msg['parts'];
  if (Array.isArray(parts)) {
    for (const part of parts as Array<Record<string, unknown>>) {
      if ('function_response' in part) return true;
    }
  }
  return msg['role'] === 'tool';
}

/**
 * Group messages into logical conversation units.
 *
 * A unit is either:
 * - A tool_use message + ALL consecutive tool_result messages that follow
 * - A single non-tool message
 */
function groupIntoUnits(
  messages: Array<Record<string, unknown>>,
): Array<Array<Record<string, unknown>>> {
  const units: Array<Array<Record<string, unknown>>> = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];
    if (msg === undefined) break;

    if (isToolUseMessage(msg)) {
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j];
        if (next !== undefined && isToolResultMessage(next)) {
          j++;
        } else {
          break;
        }
      }
      const unit = messages.slice(i, j);
      if (unit.length > 1) {
        units.push(unit);
        i = j;
      } else {
        // Orphaned tool_use — skip
        i++;
      }
    } else if (isToolResultMessage(msg)) {
      // Orphaned tool_result — skip
      i++;
    } else {
      units.push([msg]);
      i++;
    }
  }

  return units;
}

/**
 * Truncate messages to fit within a token limit.
 *
 * Strategy:
 * 1. Group messages into units (tool_use + results together, or single messages)
 * 2. Remove oldest units first to preserve recent context
 * 3. Units stay intact so tool_use/tool_result pairs are never broken
 */
export function truncateMessagesToFit(
  messages: Array<Record<string, unknown>>,
  maxTokens: number,
  preserveSystem = true,
): Array<Record<string, unknown>> {
  const currentTokens = countMessageTokens(messages);
  if (currentTokens <= maxTokens) return messages;

  const systemMessages: Array<Record<string, unknown>> = [];
  const conversation: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg['role'] === 'system' && preserveSystem) {
      systemMessages.push(msg);
    } else {
      conversation.push(msg);
    }
  }

  const systemTokens = countMessageTokens(systemMessages);
  const availableTokens = maxTokens - systemTokens;

  if (availableTokens <= 0) {
    return messages;
  }

  const units = groupIntoUnits(conversation);
  if (units.length === 0) {
    return systemMessages;
  }

  while (units.length > 1) {
    const flatMessages = units.flat();
    if (countMessageTokens(flatMessages) <= availableTokens) break;
    units.shift();
  }

  return [...systemMessages, ...units.flat()];
}
