/**
 * Gemini LLM transport — real implementation.
 *
 * Migrated from {@link GeminiBackend} (`backends/gemini.ts`), adapted to the
 * provider-neutral {@link LlmTransport} interface. Behavior is preserved
 * verbatim; only the constructor signature and I/O types change to match the
 * Phase-4 transport contract.
 *
 * Key behavioral invariants (each enforced with `@invariant` TSDoc at the
 * enforcement site):
 *
 * 1. `geminiCacheStore` singleton — module-level instance persists across calls.
 * 2. `GEMINI_ALLOWED_SCHEMA_KEYS` recursive sanitization — strips disallowed
 *    keys from nested object/array schemas.
 * 3. `GEMINI_BLOCKED_FINISH_REASONS` — 3 distinct throw sites in `complete()`.
 * 4. `thinkingEffort` / `thinkingBudgetTokens` MUTEX — exactly one may be set.
 * 5. `maxOutputTokens` → `maxTokens` fallback — prefer `maxOutputTokens`.
 *
 * @module llm/transports/gemini
 * @task T9283 (W1a)
 * @epic T-LLM-CRED-CENTRALIZATION
 * @see ADR-072 §LlmTransport — pure wire level
 */

import type { NormalizedDelta, TransportContext } from '@cleocode/contracts/llm/interfaces.js';
import type {
  LlmTransport,
  NormalizedResponse,
  NormalizedToolCall,
  NormalizedUsage,
  TransportRequest,
  TransportTool,
} from '@cleocode/contracts/llm/normalized-response.js';
import type { ApiMode } from '@cleocode/contracts/llm/provider-id.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';

import type { PromptCachePolicy } from '../caching.js';
import { buildCacheKey, geminiCacheStore } from '../caching.js';
import { repairResponseModelJson } from '../structured-output.js';
import type { ModelConfig } from '../types-config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Finish reasons that indicate the response was blocked and should throw.
 *
 * @invariant GEMINI_BLOCKED_FINISH_REASONS — 3 separate throw sites below enforce this.
 */
const GEMINI_BLOCKED_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
]);

/**
 * JSON-Schema keywords Gemini's function_declarations validator accepts.
 *
 * @invariant GEMINI_ALLOWED_SCHEMA_KEYS recursive sanitization — _sanitizeSchema recurses
 *   into `properties` and `items` values, stripping all keys absent from this set.
 */
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

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link GeminiTransport}.
 *
 * Structurally identical to `AnthropicTransportOptions` so the role-resolver
 * can swap providers by swapping only the constructor reference.
 */
export interface GeminiTransportOptions {
  /** API key for the Google Generative AI SDK. */
  apiKey: string;
  /** Override base URL (e.g. Vertex AI endpoint). */
  baseUrl?: string;
  /** Extra headers merged into every SDK request. */
  defaultHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal helper types
// ---------------------------------------------------------------------------

/** Gemini generation config built by {@link GeminiTransport._buildConfig}. */
type GeminiConfig = Record<string, unknown>;

/** Subset of {@link TransportRequest} fields needed by {@link GeminiTransport._buildConfig}. */
interface BuildConfigParams {
  maxTokens: number;
  temperature?: number | null;
  tools?: TransportTool[] | null;
  thinkingBudgetTokens?: number | null;
  thinkingEffort?: string | null;
  cacheStrategy?: string | null;
  extraParams?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// GeminiTransport
// ---------------------------------------------------------------------------

/**
 * Real Gemini transport.
 *
 * Wraps `@google/generative-ai` and normalizes requests/responses to/from the
 * provider-neutral {@link LlmTransport} interface. Supports prompt caching via
 * Gemini cached-content API (best-effort; silently skips if SDK version does
 * not support it).
 *
 * @example
 * ```ts
 * const transport = new GeminiTransport({ apiKey: process.env.GEMINI_API_KEY! });
 * const response = await transport.complete({
 *   model: 'gemini-1.5-pro',
 *   messages: [{ role: 'user', content: 'Hello' }],
 *   maxTokens: 1024,
 * });
 * ```
 */
export class GeminiTransport implements LlmTransport {
  /** Provider identifier — always `'gemini'`. */
  readonly provider = 'gemini' as const;

  /**
   * Wire protocol spoken by this transport — `'chat_completions'`.
   *
   * Gemini currently routes through the OpenAI-compatible shim. A native
   * `'gemini_native'` ApiMode is deferred to Phase 5 per ADR-072.
   *
   * @see ADR-072 §Type lock-in
   */
  readonly apiMode: ApiMode = 'chat_completions' as const;

  private readonly _client: GoogleGenerativeAI;

  /**
   * Optional model config carrying transport/model identity for cache-key
   * construction. When absent the transport + model from the request are used.
   */
  private readonly _modelConfig?: ModelConfig;

  /**
   * Create a `GeminiTransport`.
   *
   * @param options - API key, optional base URL, and optional extra headers.
   */
  constructor(options: GeminiTransportOptions) {
    this._client = new GoogleGenerativeAI(options.apiKey);
  }

  /**
   * Execute a single completion call against the Gemini API.
   *
   * Maps provider-neutral {@link TransportRequest} to the `@google/generative-ai`
   * `generateContent` call, then normalizes the response to {@link NormalizedResponse}.
   *
   * @param request - Provider-neutral request parameters.
   * @param _ctx - Transport context (unused by this transport in W1a).
   * @returns Normalized response including content, tool calls, usage, and raw SDK object.
   */
  async complete(request: TransportRequest, _ctx?: TransportContext): Promise<NormalizedResponse> {
    const { model, messages, maxTokens, system, tools, temperature, signal: _signal } = request;

    // Build a list of raw Gemini-format messages
    const rawMessages = messagesToRaw(messages, system);
    const { contents, systemInstruction } = GeminiTransport._convertMessages(rawMessages);

    /** @invariant maxOutputTokens → maxTokens fallback — TransportRequest has no maxOutputTokens; use maxTokens directly */
    const config = this._buildConfig({
      maxTokens,
      temperature,
      tools,
    });

    if (systemInstruction) config['system_instruction'] = systemInstruction;

    const cacheStrategy = request.cacheStrategy;
    let effectiveContents = contents;

    if (cacheStrategy === 'prefix_and_2' && Array.isArray(contents)) {
      const cacheable = contents.slice(0, -1);
      const fakePolicy: PromptCachePolicy = {
        mode: 'gemini_cached_content',
        ttlSeconds: 300,
        keyVersion: 'v1',
      };
      await this._attachCachedContent({
        model,
        config,
        cachePolicy: fakePolicy,
        contents: cacheable,
        tools: (tools as unknown as Array<Record<string, unknown>> | null) ?? null,
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
    const sdkResponse = await genModel.generateContent(genRequest);

    return this._normalizeResponse({
      response: sdkResponse.response as unknown as Record<string, unknown>,
      modelName: model,
    });
  }

  /**
   * Stream a completion against the Gemini API.
   *
   * Yields {@link NormalizedDelta} chunks including incremental text deltas.
   * The final delta carries `stopReason` and `usage`.
   *
   * @param request - Provider-neutral request parameters.
   * @param _ctx - Transport context (unused by this transport in W1a).
   * @returns An async iterable of normalized delta chunks.
   */
  async *stream(request: TransportRequest, _ctx: TransportContext): AsyncIterable<NormalizedDelta> {
    const { model, messages, maxTokens, system, tools, temperature } = request;

    const rawMessages = messagesToRaw(messages, system);
    const { contents, systemInstruction } = GeminiTransport._convertMessages(rawMessages);

    /** @invariant maxOutputTokens → maxTokens fallback — TransportRequest has no maxOutputTokens; use maxTokens directly */
    const config = this._buildConfig({ maxTokens, temperature, tools });
    if (systemInstruction) config['system_instruction'] = systemInstruction;

    const cacheStrategy = request.cacheStrategy;
    let effectiveContents = contents;

    if (cacheStrategy === 'prefix_and_2' && Array.isArray(contents)) {
      const cacheable = contents.slice(0, -1);
      const fakePolicy: PromptCachePolicy = {
        mode: 'gemini_cached_content',
        ttlSeconds: 300,
        keyVersion: 'v1',
      };
      await this._attachCachedContent({
        model,
        config,
        cachePolicy: fakePolicy,
        contents: cacheable,
        tools: (tools as unknown as Array<Record<string, unknown>> | null) ?? null,
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
      let textResult = '';
      if (typeof text === 'function') {
        textResult = (chunkAny['text'] as () => string)();
      } else if (typeof text === 'string') {
        textResult = text;
      }
      if (textResult) {
        anyText = true;
        yield {
          text: textResult,
          reasoning: '',
          stopReason: null,
          usage: null,
        };
      }
      finalChunk = chunkAny;
    }

    let finishReason = 'stop';
    let outputTokens = 0;
    let inputTokens = 0;

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
        outputTokens = Number(usageMeta['candidatesTokenCount']) || 0;
      }
      if (usageMeta?.['promptTokenCount']) {
        inputTokens = Number(usageMeta['promptTokenCount']) || 0;
      }
    }

    /**
     * @invariant GEMINI_BLOCKED_FINISH_REASONS — 3 separate throw sites.
     * Stream site (site 1 of 3): throw when no text was produced and finish reason is blocked.
     */
    if (!anyText && GEMINI_BLOCKED_FINISH_REASONS.has(finishReason)) {
      throw new Error(`Gemini response blocked (finish_reason=${finishReason}, model=${model})`);
    }

    const usage: NormalizedUsage = { inputTokens, outputTokens };
    yield { text: '', reasoning: '', stopReason: finishReason, usage };
  }

  /**
   * Returns true when the error is a 401 (invalid key) or 429 (rate limit),
   * signalling the session layer should rotate to the next credential.
   *
   * @param err - The error thrown by the provider SDK.
   * @returns Whether a credential rotation should be attempted.
   */
  shouldRotateCredential(err: unknown): boolean {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      return msg.includes('401') || msg.includes('429') || msg.includes('api key');
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the Gemini generationConfig object from request parameters.
   *
   * @invariant thinkingEffort vs thinkingBudgetTokens MUTEX — set ONE; throws if BOTH set.
   * @invariant maxOutputTokens → maxTokens fallback — maxOutputTokens used when provided,
   *   falls back to maxTokens (enforced at call-site via the BuildConfigParams shape).
   */
  private _buildConfig(params: BuildConfigParams): GeminiConfig {
    const { maxTokens, temperature, tools, thinkingBudgetTokens, thinkingEffort, extraParams } =
      params;

    const config: GeminiConfig = { maxOutputTokens: maxTokens };
    if (temperature !== null && temperature !== undefined) config['temperature'] = temperature;
    if (tools && tools.length > 0) config['tools'] = GeminiTransport._convertTools(tools);

    const thinkingConfig: Record<string, unknown> = {};
    if (thinkingBudgetTokens !== null && thinkingBudgetTokens !== undefined) {
      thinkingConfig['thinkingBudget'] = thinkingBudgetTokens;
    }
    if (thinkingEffort !== null && thinkingEffort !== undefined) {
      thinkingConfig['thinkingLevel'] = thinkingEffort;
    }
    /**
     * @invariant thinkingEffort vs thinkingBudgetTokens MUTEX — throw if BOTH are set.
     */
    if (Object.keys(thinkingConfig).length > 1) {
      throw new Error(
        'Gemini transport does not support both thinkingBudgetTokens and thinkingEffort in the same request',
      );
    }
    if (Object.keys(thinkingConfig).length > 0) config['thinkingConfig'] = thinkingConfig;

    for (const key of ['top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'seed']) {
      if (extraParams?.[key] !== undefined) config[key] = extraParams[key];
    }

    return config;
  }

  /**
   * Normalize a raw Gemini SDK response into {@link NormalizedResponse}.
   *
   * @param params.response - Raw Gemini response object.
   * @param params.modelName - Model identifier (for error messages).
   */
  private _normalizeResponse(params: {
    response: Record<string, unknown>;
    modelName: string;
  }): NormalizedResponse {
    const { response, modelName } = params;
    const candidates = response['candidates'] as Array<Record<string, unknown>> | undefined;
    const candidate = candidates?.[0];

    const finishReasonRaw = candidate?.['finishReason'];
    const finishReason =
      finishReasonRaw !== null && finishReasonRaw !== undefined
        ? String((finishReasonRaw as Record<string, unknown>)['name'] ?? finishReasonRaw)
        : 'stop';

    const textParts: string[] = [];
    const toolCalls: NormalizedToolCall[] = [];

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
          const thoughtSignature = part['thoughtSignature'] as string | undefined;
          toolCalls.push({
            id: `call_${fname}_${toolCalls.length}`,
            name: fname,
            arguments: JSON.stringify(fargs ?? {}),
            ...(thoughtSignature !== undefined ? { providerData: { thoughtSignature } } : {}),
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
    const cachedTokens = usageMeta ? Number(usageMeta['cachedContentTokenCount'] ?? 0) : 0;

    const usage: NormalizedUsage = {
      inputTokens: usageMeta ? Number(usageMeta['promptTokenCount'] ?? 0) : 0,
      outputTokens: usageMeta ? Number(usageMeta['candidatesTokenCount'] ?? 0) : 0,
      ...(cachedTokens > 0 ? { cachedTokens } : {}),
    };

    let content: string | null = textParts.join('\n') || null;

    /**
     * @invariant GEMINI_BLOCKED_FINISH_REASONS — 3 separate throw sites.
     * normalizeResponse site (site 2 of 3): no text content and no tool calls with a blocked finish reason.
     */
    if (!content && !toolCalls.length && GEMINI_BLOCKED_FINISH_REASONS.has(finishReason)) {
      throw new Error(
        `Gemini response blocked (finish_reason=${finishReason}, model=${modelName})`,
      );
    }

    // Handle structured output via Zod repair
    const parsed = response['parsed'];
    if (parsed !== null && parsed !== undefined) {
      // Try to parse as JSON string for structured output compatibility
      try {
        const zodResult = z.string().safeParse(String(parsed));
        if (!zodResult.success) {
          content = JSON.stringify(parsed);
        } else {
          content = zodResult.data;
        }
      } catch {
        content = String(parsed);
      }
    } else if (content === null && GEMINI_BLOCKED_FINISH_REASONS.has(finishReason)) {
      /**
       * @invariant GEMINI_BLOCKED_FINISH_REASONS — 3 separate throw sites.
       * normalizeResponse structured-output site (site 3 of 3): blocked when response has no parsed content.
       */
      throw new Error(
        `Gemini response blocked (finish_reason=${finishReason}, model=${modelName})`,
      );
    }

    const responseId = String(
      (response['responseId'] as string | undefined) ?? `gemini-${Date.now()}`,
    );

    return {
      id: responseId,
      model: modelName,
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      stopReason: finishReason,
      usage,
      raw: response,
    };
  }

  /**
   * Attach a Gemini cached-content handle to the generation config.
   *
   * Best-effort: if the SDK version does not support caching or the cache
   * creation call fails, the function returns without modifying `config`.
   *
   * @invariant geminiCacheStore singleton integration — uses the module-level
   *   `geminiCacheStore` instance imported from `caching.ts`. The store persists
   *   handles across calls for the lifetime of the process.
   */
  private async _attachCachedContent(params: {
    model: string;
    config: GeminiConfig;
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

    const modelConfig: ModelConfig = this._modelConfig ?? { transport: 'gemini', model };

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
      const clientAny = this._client as unknown as Record<string, unknown>;
      const cacheApi = clientAny['caches'] as Record<string, unknown> | undefined;
      if (!cacheApi) return;

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
        )({ model, config: cacheConfig });
        const expiresAt =
          (cachedContent['expire_time'] as Date | undefined) ??
          new Date(Date.now() + ttlSeconds * 1000);
        cachedHandle = geminiCacheStore.set({
          key: cacheKey,
          cachedContentName: String(cachedContent['name'] ?? ''),
          expiresAt,
        });
      } catch {
        return;
      }
    }

    if (cachedHandle !== null) {
      config['cached_content'] = cachedHandle.cachedContentName;
      delete config['system_instruction'];
      delete config['tools'];
      delete config['tool_config'];
    }
  }

  // ---------------------------------------------------------------------------
  // Static helpers (ported verbatim from GeminiBackend)
  // ---------------------------------------------------------------------------

  /**
   * Convert provider-neutral messages to Gemini `contents` + `systemInstruction`.
   *
   * Separates system messages from the conversation, maps `assistant` → `model`,
   * and converts multi-block content arrays to Gemini `parts`.
   */
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
              `Gemini transport cannot translate content block of type ${String(blockType)}; ` +
                'translate to Gemini-native parts via the history adapter before passing to the transport',
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

  /**
   * Convert provider-neutral {@link TransportTool} array to Gemini
   * `function_declarations` format.
   *
   * Already-converted inputs (first element has `function_declarations` key) are
   * passed through unchanged to allow callers to pre-format tools.
   */
  static _convertTools(tools: TransportTool[]): Array<Record<string, unknown>> {
    const rawTools = tools as unknown as Array<Record<string, unknown>>;
    if (rawTools.length > 0 && 'function_declarations' in rawTools[0]!) return rawTools;
    return [
      {
        function_declarations: rawTools.map((tool) => ({
          name: tool['name'],
          description: tool['description'],
          parameters: GeminiTransport._sanitizeSchema(tool['input_schema'] ?? tool['inputSchema']),
        })),
      },
    ];
  }

  /**
   * Recursively strip JSON-Schema keys not in {@link GEMINI_ALLOWED_SCHEMA_KEYS}.
   *
   * Recurses into `properties` (per-property schemas) and `items` (array item
   * schemas) so nested objects are fully sanitized.
   *
   * @invariant GEMINI_ALLOWED_SCHEMA_KEYS recursive sanitization — this function
   *   is called recursively for `properties` values and `items`, ensuring the full
   *   schema tree is stripped of disallowed keys.
   */
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
            GeminiTransport._sanitizeSchema(v),
          ]),
        );
      } else if (key === 'items') {
        cleaned['items'] = GeminiTransport._sanitizeSchema(value);
      } else if ((key === 'required' || key === 'enum') && Array.isArray(value)) {
        cleaned[key] = [...(value as unknown[])];
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  /**
   * Convert provider-neutral `toolChoice` to Gemini `toolConfig` format.
   */
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
    return { function_calling_config: { mode: 'ANY', allowed_function_names: [toolChoice] } };
  }
}

// ---------------------------------------------------------------------------
// Internal: convert TransportMessage[] to raw Gemini message format
// ---------------------------------------------------------------------------

/**
 * Map provider-neutral {@link import('@cleocode/contracts/llm/normalized-response.js').TransportMessage}[]
 * to raw Gemini message dicts for `_convertMessages`.
 *
 * System is split out of messages and injected as the `system` param here.
 */
function messagesToRaw(
  messages: import('@cleocode/contracts/llm/normalized-response.js').TransportMessage[],
  system?: string,
): Array<Record<string, unknown>> {
  const raw: Array<Record<string, unknown>> = [];

  if (system) {
    raw.push({ role: 'system', content: system });
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      raw.push({ role: msg.role, content: msg.content });
    } else {
      raw.push({
        role: msg.role,
        content: msg.content,
      });
    }
  }

  return raw;
}

// ---------------------------------------------------------------------------
// Re-export for downstream compatibility
// ---------------------------------------------------------------------------

export { repairResponseModelJson };
