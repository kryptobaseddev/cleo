/**
 * Gemini provider backend.
 *
 * Ported from Honcho src/llm/backends/gemini.py (577 LOC).
 *
 * Uses @google/generative-ai SDK. Key differences from OpenAI/Anthropic:
 * - Messages converted from OpenAI/Anthropic format to Gemini "parts" format
 * - JSON-Schema keywords filtered to Gemini-accepted subset via _sanitizeSchema
 * - Prompt caching via cached_content API (GeminiBackend._attachCachedContent)
 *
 * @task T1391 (T1386-W5)
 * @epic T1386
 */

import type { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';

import type {
  BackendCallParams,
  CompletionResult,
  ProviderBackend,
  StreamChunk,
  ToolCallResult,
} from '../backend.js';
import { makeCompletionResult } from '../backend.js';
import type { PromptCachePolicy } from '../caching.js';
import { buildCacheKey, geminiCacheStore } from '../caching.js';
import { repairResponseModelJson } from '../structured-output.js';
import type { ModelConfig } from '../types-config.js';

const GEMINI_BLOCKED_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
]);

/** JSON-Schema keywords Gemini's function_declarations validator accepts. */
const GEMINI_ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'properties',
  'required',
  'items',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'title',
]);

export class GeminiBackend implements ProviderBackend {
  private readonly _client: GoogleGenerativeAI;
  private readonly _modelConfig?: ModelConfig;

  constructor(client: GoogleGenerativeAI, modelConfig?: ModelConfig) {
    this._client = client;
    this._modelConfig = modelConfig;
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

    const { contents, systemInstruction } = GeminiBackend._convertMessages(messages);
    const config = this._buildConfig({
      maxTokens: maxOutputTokens ?? maxTokens,
      temperature,
      stop,
      tools,
      toolChoice,
      responseFormat,
      thinkingBudgetTokens,
      thinkingEffort,
      extraParams,
    });

    if (systemInstruction) config['system_instruction'] = systemInstruction;

    const cachePolicy = extraParams?.['cache_policy'] as PromptCachePolicy | undefined;
    let effectiveContents = contents;

    if (cachePolicy && Array.isArray(contents)) {
      const cacheable = contents.slice(0, -1);
      await this._attachCachedContent({
        model,
        config,
        cachePolicy,
        contents: cacheable,
        tools,
      });
      if ('cached_content' in config && contents.length > 0) {
        effectiveContents = [contents[contents.length - 1]!];
      }
    }

    if (Array.isArray(effectiveContents) && effectiveContents.length === 0) {
      throw new Error(`No non-system messages to send to Gemini (model=${model})`);
    }

    const genModel = this._client.getGenerativeModel({ model });
    const genRequest = {
      contents: effectiveContents,
      generationConfig: config,
    } as unknown as Parameters<typeof genModel.generateContent>[0];
    const response = await genModel.generateContent(genRequest);

    return this._normalizeResponse({
      response: response.response as unknown as Record<string, unknown>,
      responseFormat: typeof responseFormat === 'function' ? responseFormat : null,
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
      maxOutputTokens,
      extraParams,
    } = params;

    const { contents, systemInstruction } = GeminiBackend._convertMessages(messages);
    const config = this._buildConfig({
      maxTokens: maxOutputTokens ?? maxTokens,
      temperature,
      stop,
      tools,
      toolChoice,
      responseFormat,
      thinkingBudgetTokens,
      thinkingEffort,
      extraParams,
    });
    if (systemInstruction) config['system_instruction'] = systemInstruction;

    const cachePolicy = extraParams?.['cache_policy'] as PromptCachePolicy | undefined;
    let effectiveContents = contents;

    if (cachePolicy && Array.isArray(contents)) {
      const cacheable = contents.slice(0, -1);
      await this._attachCachedContent({
        model,
        config,
        cachePolicy,
        contents: cacheable,
        tools,
      });
      if ('cached_content' in config && contents.length > 0) {
        effectiveContents = [contents[contents.length - 1]!];
      }
    }

    if (Array.isArray(effectiveContents) && effectiveContents.length === 0) {
      throw new Error(`No non-system messages to send to Gemini (model=${model})`);
    }

    const genModel = this._client.getGenerativeModel({ model });
    const streamRequest = {
      contents: effectiveContents,
      generationConfig: config,
    } as unknown as Parameters<typeof genModel.generateContentStream>[0];
    const streamResult = await genModel.generateContentStream(streamRequest);

    let finalChunk: Record<string, unknown> | null = null;
    let anyText = false;

    for await (const chunk of streamResult.stream) {
      const chunkAny = chunk as unknown as Record<string, unknown>;
      const text = chunkAny['text'];
      if (typeof text === 'function') {
        const textResult = (chunkAny['text'] as () => string)();
        if (textResult) {
          anyText = true;
          yield { content: textResult, isDone: false };
        }
      } else if (typeof text === 'string' && text) {
        anyText = true;
        yield { content: text, isDone: false };
      }
      finalChunk = chunkAny;
    }

    let finishReason = 'stop';
    let outputTokens: number | null = null;

    if (finalChunk) {
      const candidates = finalChunk['candidates'] as Array<Record<string, unknown>> | undefined;
      if (candidates?.[0]) {
        const fr = candidates[0]['finish_reason'] as Record<string, unknown> | string | undefined;
        if (fr) {
          finishReason = typeof fr === 'object' ? String(fr['name'] ?? 'stop') : String(fr);
        }
      }
      const usageMeta = finalChunk['usageMetadata'] as Record<string, unknown> | undefined;
      if (usageMeta?.['candidatesTokenCount']) {
        outputTokens = Number(usageMeta['candidatesTokenCount']) || null;
      }
    }

    if (!anyText && GEMINI_BLOCKED_FINISH_REASONS.has(finishReason)) {
      throw new Error(`Gemini response blocked (finish_reason=${finishReason}, model=${model})`);
    }

    yield { content: '', isDone: true, finishReason, outputTokens };
  }

  private _buildConfig(params: {
    maxTokens: number;
    temperature: number | null | undefined;
    stop: string[] | null | undefined;
    tools: Array<Record<string, unknown>> | null | undefined;
    toolChoice: string | Record<string, unknown> | null | undefined;
    responseFormat:
      | (new (
          ...args: unknown[]
        ) => unknown)
      | Record<string, unknown>
      | null
      | undefined;
    thinkingBudgetTokens: number | null | undefined;
    thinkingEffort: string | null | undefined;
    extraParams: Record<string, unknown> | null | undefined;
  }): Record<string, unknown> {
    const {
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

    const config: Record<string, unknown> = { maxOutputTokens: maxTokens };
    if (temperature !== null && temperature !== undefined) config['temperature'] = temperature;
    if (stop && stop.length > 0) config['stopSequences'] = stop;
    if (tools && tools.length > 0) config['tools'] = GeminiBackend._convertTools(tools);
    if (toolChoice) config['toolConfig'] = GeminiBackend._convertToolChoice(toolChoice);

    if (responseFormat !== null && responseFormat !== undefined) {
      config['responseMimeType'] = 'application/json';
      if (typeof responseFormat === 'function') {
        config['responseSchema'] = responseFormat;
      }
    } else if (extraParams?.['json_mode'] && !(tools && tools.length > 0)) {
      config['responseMimeType'] = 'application/json';
    }

    const thinkingConfig: Record<string, unknown> = {};
    if (thinkingBudgetTokens !== null && thinkingBudgetTokens !== undefined) {
      thinkingConfig['thinkingBudget'] = thinkingBudgetTokens;
    }
    if (thinkingEffort !== null && thinkingEffort !== undefined) {
      thinkingConfig['thinkingLevel'] = thinkingEffort;
    }
    if (Object.keys(thinkingConfig).length > 1) {
      throw new Error(
        'Gemini backend does not support both thinkingBudgetTokens and thinkingEffort in the same request',
      );
    }
    if (Object.keys(thinkingConfig).length > 0) config['thinkingConfig'] = thinkingConfig;

    for (const key of ['top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'seed']) {
      if (extraParams?.[key] !== undefined) config[key] = extraParams[key];
    }

    return config;
  }

  private _normalizeResponse(params: {
    response: Record<string, unknown>;
    responseFormat: (new (...args: unknown[]) => unknown) | null;
    modelName: string;
  }): CompletionResult {
    const { response, responseFormat, modelName } = params;
    const candidates = response['candidates'] as Array<Record<string, unknown>> | undefined;
    const candidate = candidates?.[0];

    const finishReasonRaw = candidate?.['finishReason'];
    const finishReason =
      finishReasonRaw !== null && finishReasonRaw !== undefined
        ? String((finishReasonRaw as Record<string, unknown>)['name'] ?? finishReasonRaw)
        : 'stop';

    const textParts: string[] = [];
    const toolCalls: ToolCallResult[] = [];

    const candidateContent = candidate?.['content'] as Record<string, unknown> | undefined;
    const parts = candidateContent?.['parts'] as Array<Record<string, unknown>> | undefined;

    if (Array.isArray(parts)) {
      for (const part of parts) {
        const partText = part['text'];
        if (typeof partText === 'string' && partText) textParts.push(partText);
        const funcCall = part['functionCall'] as Record<string, unknown> | undefined;
        if (funcCall) {
          const fname = String(funcCall['name'] ?? '');
          const fargs = funcCall['args'] as Record<string, unknown> | undefined;
          toolCalls.push({
            id: `call_${fname}_${toolCalls.length}`,
            name: fname,
            input: fargs ?? {},
            thoughtSignature: part['thoughtSignature'] as string | null | undefined,
          });
        }
      }
    }

    // Fallback: use response.text() if available
    if (textParts.length === 0) {
      const textFn = response['text'];
      if (typeof textFn === 'function') {
        const t = (textFn as () => string)();
        if (t) textParts.push(t);
      } else if (typeof textFn === 'string' && textFn) {
        textParts.push(textFn);
      }
    }

    const usageMeta = response['usageMetadata'] as Record<string, unknown> | undefined;
    const cacheReadInputTokens = usageMeta ? Number(usageMeta['cachedContentTokenCount'] ?? 0) : 0;

    let content: unknown = textParts.join('\n');

    if (responseFormat !== null) {
      const zodSchema = this._zodSchemaFrom(responseFormat!);
      if (zodSchema) {
        const parsed = response['parsed'];
        if (parsed !== null && parsed !== undefined) {
          const r = zodSchema.safeParse(parsed);
          if (r.success) {
            content = r.data;
          } else {
            const rawText = textParts.join('');
            try {
              content = repairResponseModelJson(rawText, zodSchema, modelName);
            } catch {
              content = rawText;
            }
          }
        } else {
          if (GEMINI_BLOCKED_FINISH_REASONS.has(finishReason)) {
            throw new Error(
              `Gemini response blocked (finish_reason=${finishReason}, model=${modelName})`,
            );
          }
          const rawText = textParts.join('');
          try {
            content = repairResponseModelJson(rawText, zodSchema, modelName);
          } catch {
            content = rawText;
          }
        }
      }
    } else if (!content && !toolCalls.length && GEMINI_BLOCKED_FINISH_REASONS.has(finishReason)) {
      throw new Error(
        `Gemini response blocked (finish_reason=${finishReason}, model=${modelName})`,
      );
    }

    return makeCompletionResult({
      content,
      inputTokens: usageMeta ? Number(usageMeta['promptTokenCount'] ?? 0) : 0,
      outputTokens: usageMeta ? Number(usageMeta['candidatesTokenCount'] ?? 0) : 0,
      cacheReadInputTokens,
      finishReason,
      toolCalls,
      rawResponse: response,
    });
  }

  private async _attachCachedContent(params: {
    model: string;
    config: Record<string, unknown>;
    cachePolicy: PromptCachePolicy;
    contents: Array<Record<string, unknown>>;
    tools: Array<Record<string, unknown>> | null | undefined;
  }): Promise<void> {
    const { model, config, cachePolicy, contents, tools } = params;
    if (cachePolicy.mode !== 'gemini_cached_content') return;

    const hasCacheable = Boolean(
      contents.length || config['system_instruction'] || config['tools'],
    );
    if (!hasCacheable) return;

    const modelConfig: ModelConfig = this._modelConfig ?? {
      transport: 'gemini',
      model,
    };

    const cacheKey = buildCacheKey({
      config: modelConfig,
      cachePolicy,
      cacheableMessages: contents,
      tools: tools ?? null,
      systemInstruction: config['system_instruction'] as string | null | undefined,
      toolConfig: config['tool_config'] as Record<string, unknown> | null | undefined,
    });

    let cachedHandle = geminiCacheStore.get(cacheKey);

    if (cachedHandle === null) {
      const ttlSeconds = cachePolicy.ttlSeconds ?? 300;
      // Use the raw client's cache API
      const clientAny = this._client as unknown as Record<string, unknown>;
      const cacheApi = clientAny['caches'] as Record<string, unknown> | undefined;
      if (!cacheApi) return; // SDK version doesn't support caching

      const cacheConfig: Record<string, unknown> = {
        system_instruction: config['system_instruction'],
        tools: config['tools'],
        tool_config: config['tool_config'],
        ttl: `${ttlSeconds}s`,
      };
      if (contents.length > 0) cacheConfig['contents'] = contents;

      try {
        const cachedContent = await (
          cacheApi['create'] as (params: {
            model: string;
            config: Record<string, unknown>;
          }) => Promise<Record<string, unknown>>
        )({
          model,
          config: cacheConfig,
        });
        const expiresAt =
          (cachedContent['expire_time'] as Date | undefined) ??
          new Date(Date.now() + ttlSeconds * 1000);
        cachedHandle = geminiCacheStore.set({
          key: cacheKey,
          cachedContentName: String(cachedContent['name'] ?? ''),
          expiresAt,
        });
      } catch {
        return; // Best-effort; if caching fails, proceed without it
      }
    }

    if (cachedHandle !== null) {
      config['cached_content'] = cachedHandle.cachedContentName;
      delete config['system_instruction'];
      delete config['tools'];
      delete config['tool_config'];
    }
  }

  private _zodSchemaFrom(responseFormat: new (...args: unknown[]) => unknown): z.ZodTypeAny | null {
    const asAny = responseFormat as unknown as Record<string, unknown>;
    if (asAny['schema'] instanceof z.ZodType) return asAny['schema'] as z.ZodTypeAny;
    if (responseFormat instanceof z.ZodType) return responseFormat as unknown as z.ZodTypeAny;
    return null;
  }

  static _convertMessages(messages: Array<Record<string, unknown>>): {
    contents: Array<Record<string, unknown>>;
    systemInstruction: string | null;
  } {
    const systemMessages: string[] = [];
    const contents: Array<Record<string, unknown>> = [];

    for (const message of messages) {
      let role = String(message['role'] ?? 'user');
      if (role === 'system') {
        if (typeof message['content'] === 'string') {
          systemMessages.push(message['content']);
        }
        continue;
      }
      if (role === 'assistant') role = 'model';

      if (Array.isArray(message['parts'])) {
        const msgCopy = { ...message, role };
        contents.push(msgCopy);
        continue;
      }

      if (typeof message['content'] === 'string') {
        contents.push({ role, parts: [{ text: message['content'] }] });
        continue;
      }

      if (Array.isArray(message['content'])) {
        const parts: Array<Record<string, unknown>> = [];
        for (const block of message['content'] as Array<Record<string, unknown>>) {
          const blockType = block['type'];
          if (blockType === 'text') {
            parts.push({ text: block['text'] });
          } else {
            throw new Error(
              `Gemini backend cannot translate content block of type ${String(blockType)}; ` +
                'translate to Gemini-native parts via the history adapter before passing to the backend',
            );
          }
        }
        if (parts.length > 0) contents.push({ role, parts });
      }
    }

    return {
      contents,
      systemInstruction: systemMessages.length > 0 ? systemMessages.join('\n\n') : null,
    };
  }

  static _convertTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    if (tools.length > 0 && 'function_declarations' in tools[0]!) return tools;
    return [
      {
        function_declarations: tools.map((tool) => ({
          name: tool['name'],
          description: tool['description'],
          parameters: GeminiBackend._sanitizeSchema(tool['input_schema']),
        })),
      },
    ];
  }

  static _sanitizeSchema(schema: unknown): unknown {
    if (typeof schema !== 'object' || schema === null) return schema;
    const schemaDic = schema as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(schemaDic)) {
      if (!GEMINI_ALLOWED_SCHEMA_KEYS.has(key)) continue;
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        cleaned['properties'] = Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [
            k,
            GeminiBackend._sanitizeSchema(v),
          ]),
        );
      } else if (key === 'items') {
        cleaned['items'] = GeminiBackend._sanitizeSchema(value);
      } else if ((key === 'required' || key === 'enum') && Array.isArray(value)) {
        cleaned[key] = [...(value as unknown[])];
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  static _convertToolChoice(toolChoice: string | Record<string, unknown>): Record<string, unknown> {
    if (typeof toolChoice === 'object' && 'name' in toolChoice) {
      return {
        function_calling_config: {
          mode: 'ANY',
          allowed_function_names: [toolChoice['name']],
        },
      };
    }
    if (toolChoice === 'auto') return { function_calling_config: { mode: 'AUTO' } };
    if (toolChoice === 'any' || toolChoice === 'required')
      return { function_calling_config: { mode: 'ANY' } };
    if (toolChoice === 'none') return { function_calling_config: { mode: 'NONE' } };
    return {
      function_calling_config: { mode: 'ANY', allowed_function_names: [toolChoice] },
    };
  }
}
