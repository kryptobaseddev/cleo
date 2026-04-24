/**
 * Anthropic provider backend.
 *
 * Ported from Honcho src/llm/backends/anthropic.py (347 LOC).
 *
 * CRITICAL INVARIANT (R2): Claude 4-class models reject assistant-prefill.
 * `_supportsAssistantPrefill` returns false for claude-opus-4*, claude-sonnet-4*,
 * claude-haiku-4*. CLEO's primary claude-sonnet-4-6 MUST use the non-prefill
 * JSON schema injection path. Correctness bug if omitted.
 *
 * @task T1389 (T1386-W3)
 * @epic T1386
 */

import type { Anthropic } from '@anthropic-ai/sdk';
import { z } from 'zod';

import type {
  BackendCallParams,
  CompletionResult,
  ProviderBackend,
  StreamChunk,
  ToolCallResult,
} from '../backend.js';
import { makeCompletionResult } from '../backend.js';
import { repairResponseModelJson } from '../structured-output.js';

export class AnthropicBackend implements ProviderBackend {
  private readonly _client: Anthropic;

  constructor(client: Anthropic) {
    this._client = client;
  }

  async complete(params: BackendCallParams): Promise<CompletionResult> {
    const {
      model,
      messages,
      maxTokens,
      temperature,
      stop,
      tools,
      toolChoice,
      responseFormat,
      thinkingBudgetTokens,
      thinkingEffort,
      extraParams,
    } = params;

    if (thinkingEffort !== null && thinkingEffort !== undefined) {
      throw new Error(
        'Anthropic backend does not support thinkingEffort; use thinkingBudgetTokens instead',
      );
    }

    const { requestMessages, systemMessages } = this._extractSystem(messages);

    const reqParams: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: requestMessages,
    };

    if (temperature !== null && temperature !== undefined) reqParams['temperature'] = temperature;
    if (stop && stop.length > 0) reqParams['stop_sequences'] = stop;
    if (systemMessages.length > 0) {
      reqParams['system'] = [
        {
          type: 'text',
          text: systemMessages.join('\n\n'),
          cache_control: { type: 'ephemeral' },
        },
      ];
    }
    if (tools && tools.length > 0) {
      reqParams['tools'] = tools;
      const convertedToolChoice = this._convertToolChoice(toolChoice);
      if (convertedToolChoice !== null) reqParams['tool_choice'] = convertedToolChoice;
    }
    if (thinkingBudgetTokens) {
      reqParams['thinking'] = { type: 'enabled', budget_tokens: thinkingBudgetTokens };
    }
    if (extraParams) {
      for (const key of ['top_p', 'top_k']) {
        if (key in extraParams) reqParams[key] = extraParams[key];
      }
    }

    const useJsonPrefill =
      ((responseFormat !== null && responseFormat !== undefined) || this._jsonMode(extraParams)) &&
      !thinkingBudgetTokens &&
      AnthropicBackend._supportsAssistantPrefill(model);

    const msgs = reqParams['messages'] as Array<Record<string, unknown>>;

    if (useJsonPrefill && msgs.length > 0) {
      if (responseFormat && typeof responseFormat === 'function') {
        const schemaJson = this._getJsonSchema(responseFormat);
        this._appendTextToLastMessage(
          msgs,
          `\n\nRespond with valid JSON matching this schema:\n${schemaJson}`,
        );
      }
      msgs.push({ role: 'assistant', content: '{' });
    } else if (
      responseFormat !== null &&
      responseFormat !== undefined &&
      typeof responseFormat === 'function' &&
      msgs.length > 0
    ) {
      const schemaJson = this._getJsonSchema(responseFormat);
      this._appendTextToLastMessage(
        msgs,
        `\n\nRespond with valid JSON matching this schema:\n${schemaJson}`,
      );
    }

    const response = (await (this._client as Anthropic).messages.create(
      reqParams as unknown as Parameters<Anthropic['messages']['create']>[0],
    )) as Anthropic.Message;

    return this._normalizeResponse({
      response,
      responseFormat: typeof responseFormat === 'function' ? responseFormat : null,
      prefillJson: useJsonPrefill,
      modelName: model,
    });
  }

  async *stream(params: BackendCallParams): AsyncGenerator<StreamChunk> {
    const {
      model,
      messages,
      maxTokens,
      temperature,
      stop,
      tools,
      toolChoice,
      responseFormat,
      thinkingBudgetTokens,
      thinkingEffort,
      extraParams,
    } = params;

    const isJsonMode = this._jsonMode(extraParams);

    if (thinkingEffort !== null && thinkingEffort !== undefined) {
      throw new Error(
        'Anthropic backend does not support thinkingEffort; use thinkingBudgetTokens instead',
      );
    }

    const { requestMessages, systemMessages } = this._extractSystem(messages);

    const reqParams: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: requestMessages,
    };
    if (temperature !== null && temperature !== undefined) reqParams['temperature'] = temperature;
    if (stop && stop.length > 0) reqParams['stop_sequences'] = stop;
    if (tools && tools.length > 0) {
      reqParams['tools'] = tools;
      const convertedToolChoice = this._convertToolChoice(toolChoice);
      if (convertedToolChoice !== null) reqParams['tool_choice'] = convertedToolChoice;
    }
    if (systemMessages.length > 0) {
      reqParams['system'] = [
        {
          type: 'text',
          text: systemMessages.join('\n\n'),
          cache_control: { type: 'ephemeral' },
        },
      ];
    }
    if (extraParams) {
      for (const key of ['top_p', 'top_k']) {
        if (key in extraParams) reqParams[key] = extraParams[key];
      }
    }

    const useJsonPrefill =
      ((responseFormat !== null && responseFormat !== undefined) || isJsonMode) &&
      !thinkingBudgetTokens &&
      AnthropicBackend._supportsAssistantPrefill(model);

    const msgs = reqParams['messages'] as Array<Record<string, unknown>>;

    if (useJsonPrefill && msgs.length > 0) {
      if (responseFormat && typeof responseFormat === 'function') {
        const schemaJson = this._getJsonSchema(responseFormat);
        this._appendTextToLastMessage(
          msgs,
          `\n\nRespond with valid JSON matching this schema:\n${schemaJson}`,
        );
      }
      msgs.push({ role: 'assistant', content: '{' });
    } else if (
      responseFormat !== null &&
      responseFormat !== undefined &&
      typeof responseFormat === 'function' &&
      msgs.length > 0
    ) {
      const schemaJson = this._getJsonSchema(responseFormat);
      this._appendTextToLastMessage(
        msgs,
        `\n\nRespond with valid JSON matching this schema:\n${schemaJson}`,
      );
    }
    if (thinkingBudgetTokens) {
      reqParams['thinking'] = { type: 'enabled', budget_tokens: thinkingBudgetTokens };
    }

    const stream = (this._client as Anthropic).messages.stream(
      reqParams as unknown as Parameters<Anthropic['messages']['stream']>[0],
    );

    for await (const chunk of stream) {
      if (
        chunk.type === 'content_block_delta' &&
        'delta' in chunk &&
        chunk.delta !== null &&
        typeof chunk.delta === 'object' &&
        'text' in chunk.delta
      ) {
        yield { content: String(chunk.delta.text), isDone: false };
      }
    }

    const finalMessage = await stream.finalMessage();
    const outputTokens = finalMessage.usage?.output_tokens ?? null;
    yield {
      content: '',
      isDone: true,
      finishReason: finalMessage.stop_reason ?? undefined,
      outputTokens,
    };
  }

  private _normalizeResponse(params: {
    response: Anthropic.Message;
    responseFormat: (new (...args: unknown[]) => unknown) | null;
    prefillJson: boolean;
    modelName: string;
  }): CompletionResult {
    const { response, responseFormat, prefillJson, modelName } = params;
    const textBlocks: string[] = [];
    const thinkingTextBlocks: string[] = [];
    const thinkingFullBlocks: Array<Record<string, unknown>> = [];
    const toolCalls: ToolCallResult[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textBlocks.push(block.text);
      } else if (block.type === 'thinking') {
        thinkingTextBlocks.push(block.thinking);
        thinkingFullBlocks.push({
          type: 'thinking',
          thinking: block.thinking,
          signature: block.signature,
        });
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    const usage = response.usage;
    const usageAny = usage as unknown as Record<string, unknown>;
    const cacheCreationTokens = (usageAny['cache_creation_input_tokens'] as number) ?? 0;
    const cacheReadTokens = (usageAny['cache_read_input_tokens'] as number) ?? 0;
    const uncachedTokens = usage?.input_tokens ?? 0;
    const totalInputTokens = uncachedTokens + cacheCreationTokens + cacheReadTokens;

    const textContent = textBlocks.join('\n');
    const thinkingContent = thinkingTextBlocks.length > 0 ? thinkingTextBlocks.join('\n') : null;

    let content: unknown = textContent;

    if (responseFormat !== null && typeof responseFormat === 'function') {
      const rawContent = prefillJson ? `{${textContent}` : textContent;
      try {
        const schema = this._zodSchemaFrom(responseFormat);
        if (schema) {
          content = schema.parse(JSON.parse(rawContent));
        } else {
          content = JSON.parse(rawContent);
        }
      } catch {
        try {
          content = repairResponseModelJson(
            rawContent,
            this._zodSchemaFrom(responseFormat) ?? z.unknown(),
            modelName,
          );
        } catch {
          content = rawContent;
        }
      }
    }

    return makeCompletionResult({
      content,
      inputTokens: totalInputTokens,
      outputTokens: usage?.output_tokens ?? 0,
      cacheCreationInputTokens: cacheCreationTokens,
      cacheReadInputTokens: cacheReadTokens,
      finishReason: response.stop_reason ?? 'stop',
      toolCalls,
      thinkingContent,
      thinkingBlocks: thinkingFullBlocks,
      rawResponse: response,
    });
  }

  /**
   * R2 CRITICAL: Claude 4-class models reject assistant-prefill.
   * Returns false for claude-opus-4*, claude-sonnet-4*, claude-haiku-4*.
   */
  static _supportsAssistantPrefill(model: string): boolean {
    return !(
      model.startsWith('claude-opus-4') ||
      model.startsWith('claude-sonnet-4') ||
      model.startsWith('claude-haiku-4')
    );
  }

  private _extractSystem(messages: Array<Record<string, unknown>>): {
    requestMessages: Array<Record<string, unknown>>;
    systemMessages: string[];
  } {
    const systemMessages: string[] = [];
    const requestMessages: Array<Record<string, unknown>> = [];
    for (const msg of messages) {
      if (msg['role'] === 'system' && typeof msg['content'] === 'string') {
        systemMessages.push(msg['content']);
      } else {
        requestMessages.push(structuredClone(msg));
      }
    }
    return { requestMessages, systemMessages };
  }

  private _convertToolChoice(
    toolChoice: string | Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (toolChoice === null || toolChoice === undefined) return null;
    if (typeof toolChoice === 'object') return toolChoice;
    if (toolChoice === 'auto') return { type: 'auto' };
    if (toolChoice === 'any' || toolChoice === 'required') return { type: 'any' };
    if (toolChoice === 'none') return { type: 'none' };
    return { type: 'tool', name: toolChoice };
  }

  private _appendTextToLastMessage(messages: Array<Record<string, unknown>>, suffix: string): void {
    const last = messages[messages.length - 1];
    if (!last) return;
    const content = last['content'];
    if (typeof content === 'string') {
      last['content'] = content + suffix;
    } else if (Array.isArray(content)) {
      const blocks = content as Array<Record<string, unknown>>;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block && block['type'] === 'text') {
          block['text'] = String(block['text']) + suffix;
          return;
        }
      }
      blocks.push({ type: 'text', text: suffix });
    }
  }

  private _jsonMode(extraParams: Record<string, unknown> | null | undefined): boolean {
    return Boolean(extraParams?.['json_mode']);
  }

  private _getJsonSchema(responseFormat: new (...args: unknown[]) => unknown): string {
    const schema = this._zodSchemaFrom(responseFormat);
    if (schema && 'shape' in schema) {
      return JSON.stringify((schema as z.ZodObject<z.ZodRawShape>).shape, null, 2);
    }
    return '{}';
  }

  private _zodSchemaFrom(responseFormat: new (...args: unknown[]) => unknown): z.ZodTypeAny | null {
    // If it has a static `schema` property (Zod convention), use it
    const asAny = responseFormat as unknown as Record<string, unknown>;
    if (asAny['schema'] instanceof z.ZodType) {
      return asAny['schema'] as z.ZodTypeAny;
    }
    // If it IS a ZodType constructor (e.g., z.object()), return as-is
    if (responseFormat instanceof z.ZodType) {
      return responseFormat as unknown as z.ZodTypeAny;
    }
    return null;
  }
}
