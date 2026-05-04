/**
 * OpenAI provider backend.
 *
 * Ported from PSYCHE src/llm/backends/openai.py (427 LOC).
 *
 * Key distinctions from classic OpenAI:
 * - o-series and gpt-5 use max_completion_tokens instead of max_tokens
 * - Structured output via parse() endpoint for BaseModel-equivalent schemas
 * - streaming doesn't support .parse(); uses json_schema response_format instead
 *
 * @task T1390 (T1386-W4)
 * @epic T1386
 */

import type { OpenAI } from 'openai';
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

/**
 * Determine if the model requires max_completion_tokens instead of max_tokens.
 * Matches: gpt-5, gpt-5.x, o1*, o3*, o4*.
 */
export function usesMaxCompletionTokens(model: string): boolean {
  const m = model.toLowerCase();
  if (m === 'gpt-5' || m.startsWith('gpt-5-') || m.startsWith('gpt-5.')) return true;
  for (const prefix of ['o1', 'o3', 'o4']) {
    if (m === prefix || m.startsWith(`${prefix}-`)) return true;
  }
  return false;
}

function extractReasoningContent(response: OpenAI.ChatCompletion): string | null {
  try {
    const message = response.choices[0]?.message;
    if (!message) return null;
    const rdAny = message as unknown as Record<string, unknown>;
    if (
      Array.isArray(rdAny['reasoning_details']) &&
      (rdAny['reasoning_details'] as unknown[]).length > 0
    ) {
      const parts: string[] = [];
      for (const detail of rdAny['reasoning_details'] as Array<Record<string, unknown>>) {
        const c = detail['content'];
        if (typeof c === 'string' && c) parts.push(c);
      }
      if (parts.length > 0) return parts.join('\n');
    }
    const rcAny = rdAny['reasoning_content'];
    if (typeof rcAny === 'string' && rcAny) return rcAny;
  } catch {
    return null;
  }
  return null;
}

function extractReasoningDetails(response: OpenAI.ChatCompletion): Array<Record<string, unknown>> {
  try {
    const message = response.choices[0]?.message;
    if (!message) return [];
    const rdAny = (message as unknown as Record<string, unknown>)['reasoning_details'];
    if (!Array.isArray(rdAny)) return [];
    const details: Array<Record<string, unknown>> = [];
    for (const detail of rdAny as unknown[]) {
      if (typeof detail === 'object' && detail !== null) {
        details.push(detail as Record<string, unknown>);
      }
    }
    return details;
  } catch {
    return [];
  }
}

function extractCacheTokens(usage: OpenAI.CompletionUsage | null): {
  cacheCreation: number;
  cacheRead: number;
} {
  if (!usage) return { cacheCreation: 0, cacheRead: 0 };
  let cacheRead = 0;
  const usageAny = usage as unknown as Record<string, unknown>;
  const promptDetails = usageAny['prompt_tokens_details'] as Record<string, unknown> | undefined;
  if (promptDetails?.['cached_tokens']) {
    cacheRead = Number(promptDetails['cached_tokens']);
  }
  if (cacheRead === 0 && usageAny['cache_read_input_tokens']) {
    cacheRead = Number(usageAny['cache_read_input_tokens']);
  } else if (cacheRead === 0 && usageAny['cached_tokens']) {
    cacheRead = Number(usageAny['cached_tokens']);
  }
  const cacheCreation = usageAny['cache_creation_input_tokens']
    ? Number(usageAny['cache_creation_input_tokens'])
    : 0;
  return { cacheCreation, cacheRead };
}

export class OpenAIBackend implements ProviderBackend {
  private readonly _client: OpenAI;

  constructor(client: OpenAI) {
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
      maxOutputTokens,
      extraParams,
    } = params;

    if (thinkingBudgetTokens !== null && thinkingBudgetTokens !== undefined) {
      throw new Error(
        'OpenAI backend does not support thinkingBudgetTokens; use thinkingEffort instead',
      );
    }

    const reqParams = this._buildParams({
      model,
      messages,
      maxTokens: maxOutputTokens ?? maxTokens,
      temperature,
      stop,
      tools,
      toolChoice,
      thinkingEffort,
      extraParams,
    });

    // Structured output path
    if (
      responseFormat !== null &&
      responseFormat !== undefined &&
      typeof responseFormat === 'function'
    ) {
      const zodSchema = this._zodSchemaFrom(responseFormat);
      if (zodSchema) {
        // Use json_schema response_format
        reqParams['response_format'] = {
          type: 'json_schema',
          json_schema: {
            name: (responseFormat as { name?: string }).name ?? 'response',
            schema: this._zodToJsonSchema(zodSchema),
          },
        };
        const response = (await this._client.chat.completions.create(
          reqParams as unknown as Parameters<OpenAI['chat']['completions']['create']>[0],
        )) as OpenAI.ChatCompletion;
        const rawContent = response.choices[0]?.message.content ?? '';
        let parsedContent: unknown = rawContent;
        try {
          const parsed = JSON.parse(rawContent);
          parsedContent = zodSchema.parse(parsed);
        } catch {
          try {
            parsedContent = repairResponseModelJson(rawContent, zodSchema, model);
          } catch {
            parsedContent = rawContent;
          }
        }
        return this._normalizeResponse(response, parsedContent);
      }
    }

    if (
      responseFormat !== null &&
      responseFormat !== undefined &&
      typeof responseFormat === 'object'
    ) {
      reqParams['response_format'] = responseFormat;
    }

    if (extraParams?.['json_mode']) {
      reqParams['response_format'] = { type: 'json_object' };
    }

    const response = (await this._client.chat.completions.create(
      reqParams as unknown as Parameters<OpenAI['chat']['completions']['create']>[0],
    )) as OpenAI.ChatCompletion;
    return this._normalizeResponse(response);
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
      maxOutputTokens,
      extraParams,
    } = params;

    if (thinkingBudgetTokens !== null && thinkingBudgetTokens !== undefined) {
      throw new Error(
        'OpenAI backend does not support thinkingBudgetTokens; use thinkingEffort instead',
      );
    }

    const reqParams = this._buildParams({
      model,
      messages,
      maxTokens: maxOutputTokens ?? maxTokens,
      temperature,
      stop,
      tools,
      toolChoice,
      thinkingEffort,
      extraParams,
    });
    reqParams['stream'] = true;
    reqParams['stream_options'] = { include_usage: true };

    if (
      responseFormat !== null &&
      responseFormat !== undefined &&
      typeof responseFormat === 'function'
    ) {
      const zodSchema = this._zodSchemaFrom(responseFormat);
      if (zodSchema) {
        reqParams['response_format'] = {
          type: 'json_schema',
          json_schema: {
            name: (responseFormat as { name?: string }).name ?? 'response',
            schema: this._zodToJsonSchema(zodSchema),
          },
        };
      }
    } else if (
      responseFormat !== null &&
      responseFormat !== undefined &&
      typeof responseFormat === 'object'
    ) {
      reqParams['response_format'] = responseFormat;
    } else if (extraParams?.['json_mode']) {
      reqParams['response_format'] = { type: 'json_object' };
    }

    const responseStream = (await this._client.chat.completions.create(
      reqParams as unknown as Parameters<OpenAI['chat']['completions']['create']>[0],
    )) as AsyncIterable<OpenAI.ChatCompletionChunk>;

    let finishReason: string | null = null;
    let usageChunkReceived = false;

    for await (const chunk of responseStream) {
      if (chunk.choices[0]?.delta?.content) {
        yield { content: chunk.choices[0].delta.content, isDone: false };
      }
      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
      const chunkAny = chunk as unknown as Record<string, unknown>;
      if (chunkAny['usage']) {
        const usage = chunkAny['usage'] as Record<string, unknown>;
        yield {
          content: '',
          isDone: true,
          finishReason: finishReason ?? undefined,
          outputTokens: Number(usage['completion_tokens']) || null,
        };
        usageChunkReceived = true;
      }
    }

    if (!usageChunkReceived && finishReason) {
      yield { content: '', isDone: true, finishReason };
    }
  }

  private _buildParams(params: {
    model: string;
    messages: Array<Record<string, unknown>>;
    maxTokens: number;
    temperature: number | null | undefined;
    stop: string[] | null | undefined;
    tools: Array<Record<string, unknown>> | null | undefined;
    toolChoice: string | Record<string, unknown> | null | undefined;
    thinkingEffort: string | null | undefined;
    extraParams: Record<string, unknown> | null | undefined;
  }): Record<string, unknown> {
    const {
      model,
      messages,
      maxTokens,
      temperature,
      stop,
      tools,
      toolChoice,
      thinkingEffort,
      extraParams,
    } = params;

    const reqParams: Record<string, unknown> = { model, messages };

    if (usesMaxCompletionTokens(model)) {
      reqParams['max_completion_tokens'] = maxTokens;
      if (extraParams?.['verbosity']) reqParams['verbosity'] = extraParams['verbosity'];
    } else {
      reqParams['max_tokens'] = maxTokens;
    }

    if (temperature !== null && temperature !== undefined) reqParams['temperature'] = temperature;
    if (thinkingEffort) reqParams['reasoning_effort'] = thinkingEffort;
    if (stop && stop.length > 0) reqParams['stop'] = stop;

    if (tools && tools.length > 0) {
      reqParams['tools'] = this._convertTools(tools);
      if (toolChoice !== null && toolChoice !== undefined) reqParams['tool_choice'] = toolChoice;
    }

    if (extraParams) {
      for (const key of ['top_p', 'frequency_penalty', 'presence_penalty', 'seed']) {
        if (key in extraParams) reqParams[key] = extraParams[key];
      }
    }

    return reqParams;
  }

  private _normalizeResponse(
    response: OpenAI.ChatCompletion,
    contentOverride?: unknown,
  ): CompletionResult {
    const usage = response.usage ?? null;
    const finishReason = response.choices[0]?.finish_reason ?? 'stop';
    const message = response.choices[0]?.message;
    const toolCalls: ToolCallResult[] = [];

    if (message && 'tool_calls' in message && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        // openai v6: ChatCompletionMessageToolCall is a discriminated union
        // (ChatCompletionMessageFunctionToolCall | ChatCompletionMessageCustomToolCall).
        // We only handle function tool calls — custom tools are not used by CLEO.
        if (tc.type !== 'function') continue;
        let toolInput: Record<string, unknown> = {};
        if (tc.function.arguments) {
          try {
            toolInput = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            // Malformed tool arguments — use empty object
          }
        }
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          input: toolInput,
        });
      }
    }

    const { cacheCreation, cacheRead } = extractCacheTokens(usage);

    return makeCompletionResult({
      content: contentOverride !== undefined ? contentOverride : (message?.content ?? ''),
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      cacheCreationInputTokens: cacheCreation,
      cacheReadInputTokens: cacheRead,
      finishReason: finishReason,
      toolCalls,
      thinkingContent: extractReasoningContent(response),
      reasoningDetails: extractReasoningDetails(response),
      rawResponse: response,
    });
  }

  private _convertTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    if (!tools.length || tools[0]?.['type'] === 'function') return tools;
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool['name'],
        description: tool['description'],
        parameters: tool['input_schema'],
      },
    }));
  }

  private _zodSchemaFrom(responseFormat: new (...args: unknown[]) => unknown): z.ZodTypeAny | null {
    const asAny = responseFormat as unknown as Record<string, unknown>;
    if (asAny['schema'] instanceof z.ZodType) return asAny['schema'] as z.ZodTypeAny;
    if (responseFormat instanceof z.ZodType) return responseFormat as unknown as z.ZodTypeAny;
    return null;
  }

  private _zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
    // Simple introspection for Zod v4 — use .shape for ZodObject, else {}
    if ('shape' in schema) {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(shape)) {
        properties[key] = { type: 'string' }; // simplified; for full support use zod-to-json-schema
        if (!(field instanceof z.ZodOptional)) required.push(key);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    return {};
  }
}
