/**
 * Provider-native message history adapters.
 *
 * Ported from PSYCHE src/llm/history_adapters.py. Each adapter knows how to
 * format assistant tool-call messages and tool-result messages in the native
 * shape expected by its provider SDK.
 *
 * @task T1394 (T1386-W8)
 * @epic T1386
 */

import type { CompletionResult } from './backend.js';

/** Protocol for history adapters. */
export interface HistoryAdapter {
  formatAssistantToolMessage(result: CompletionResult): Record<string, unknown>;
  formatToolResults(
    toolResults: Array<{
      toolId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    }>,
  ): Array<Record<string, unknown>>;
}

/** Anthropic-native tool message formatting. */
export class AnthropicHistoryAdapter implements HistoryAdapter {
  formatAssistantToolMessage(result: CompletionResult): Record<string, unknown> {
    const contentBlocks: Array<Record<string, unknown>> = [];

    if (result.thinkingBlocks.length > 0) {
      contentBlocks.push(...result.thinkingBlocks);
    }
    if (typeof result.content === 'string' && result.content) {
      contentBlocks.push({ type: 'text', text: result.content });
    }
    for (const toolCall of result.toolCalls) {
      contentBlocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
      });
    }
    return { role: 'assistant', content: contentBlocks };
  }

  formatToolResults(
    toolResults: Array<{
      toolId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    }>,
  ): Array<Record<string, unknown>> {
    return [
      {
        role: 'user',
        content: toolResults.map((tr) => ({
          type: 'tool_result',
          tool_use_id: tr.toolId,
          content: String(tr.result),
          is_error: tr.isError ?? false,
        })),
      },
    ];
  }
}

/** Gemini-native tool message formatting. */
export class GeminiHistoryAdapter implements HistoryAdapter {
  formatAssistantToolMessage(result: CompletionResult): Record<string, unknown> {
    const parts: Array<Record<string, unknown>> = [];

    if (typeof result.content === 'string' && result.content) {
      parts.push({ text: result.content });
    }
    for (const toolCall of result.toolCalls) {
      const part: Record<string, unknown> = {
        function_call: {
          name: toolCall.name,
          args: toolCall.input,
        },
      };
      if (toolCall.thoughtSignature !== null && toolCall.thoughtSignature !== undefined) {
        part['thought_signature'] = toolCall.thoughtSignature;
      }
      parts.push(part);
    }
    return { role: 'model', parts };
  }

  formatToolResults(
    toolResults: Array<{
      toolId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    }>,
  ): Array<Record<string, unknown>> {
    return [
      {
        role: 'user',
        parts: toolResults.map((tr) => ({
          function_response: {
            name: tr.toolName,
            response: { result: String(tr.result) },
          },
        })),
      },
    ];
  }
}

/** OpenAI-native tool message formatting. */
export class OpenAIHistoryAdapter implements HistoryAdapter {
  formatAssistantToolMessage(result: CompletionResult): Record<string, unknown> {
    const message: Record<string, unknown> = {
      role: 'assistant',
      content: typeof result.content === 'string' ? result.content : null,
      tool_calls: result.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        },
      })),
    };
    if (result.reasoningDetails.length > 0) {
      message['reasoning_details'] = result.reasoningDetails;
    }
    return message;
  }

  formatToolResults(
    toolResults: Array<{
      toolId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    }>,
  ): Array<Record<string, unknown>> {
    return toolResults.map((tr) => ({
      role: 'tool',
      tool_call_id: tr.toolId,
      content: String(tr.result),
    }));
  }
}

// ---------------------------------------------------------------------------
// historyAdapterForProvider
// ---------------------------------------------------------------------------

/**
 * Provider-appropriate HistoryAdapter for assistant/tool message formatting.
 *
 * Relocated from `registry.ts` as part of D-ph4-01 factory retirement
 * (T9356/T9369). Lives here alongside the adapter classes it constructs.
 *
 * @param provider - Target transport identifier.
 * @returns A history adapter appropriate for the provider wire format.
 */
export function historyAdapterForProvider(provider: string): HistoryAdapter {
  if (provider === 'anthropic') return new AnthropicHistoryAdapter();
  if (provider === 'gemini') return new GeminiHistoryAdapter();
  return new OpenAIHistoryAdapter();
}
