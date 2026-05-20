/**
 * OpenAI LLM transport — real implementation.
 *
 * Migrated from {@link OpenAIBackend} (`backends/openai.ts`), adapted to the
 * provider-neutral {@link LlmTransport} interface. Behavior is preserved
 * verbatim; only the constructor signature and I/O types change to match the
 * Phase-4 transport contract.
 *
 * Key behavioral invariants (each enforced with `@invariant` TSDoc at the
 * enforcement site):
 *
 * 1. `usesMaxCompletionTokens` o-series branching — `gpt-5*`, `o1*`, `o3*`,
 *    `o4*` use `max_completion_tokens`; all others use `max_tokens`.
 * 2. `extractReasoningContent` intentional try/catch swallow — NEVER re-throws.
 *    Returns null on any parse error.
 * 3. `parse()` vs `json_schema` streaming split — `complete()` may use `.parse()`
 *    for non-streaming structured output; `stream()` NEVER uses `.parse()`,
 *    always `json_schema` response_format.
 *
 * @module llm/transports/openai
 * @task T9284 (W1b)
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
} from '@cleocode/contracts/llm/normalized-response.js';
import type { ApiMode } from '@cleocode/contracts/llm/provider-id.js';
import type { OpenAI } from 'openai';
import { OpenAI as OpenAIClient } from 'openai';
import { z } from 'zod';

import { validateImagesForProvider } from '../image-routing.js';
import { repairResponseModelJson } from '../structured-output.js';
import { StreamingThinkScrubber } from '../think-scrubber.js';

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link OpenAITransport}.
 *
 * Structurally identical to `AnthropicTransportOptions` so the role-resolver
 * can swap providers by swapping only the constructor reference.
 */
export interface OpenAITransportOptions {
  /** API key or bearer token. */
  apiKey: string;
  /** Override base URL (e.g. Azure OpenAI endpoint). */
  baseUrl?: string;
  /** Extra headers merged into every SDK request. */
  defaultHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// usesMaxCompletionTokens
// ---------------------------------------------------------------------------

/**
 * Determine if the model requires `max_completion_tokens` instead of `max_tokens`.
 *
 * @invariant usesMaxCompletionTokens o-series branching — `gpt-5`, `gpt-5-*`,
 *   `gpt-5.*`, `o1*`, `o3*`, `o4*` use `max_completion_tokens`; all others use
 *   `max_tokens`. Exported with the SAME name and signature as the old backend
 *   so all callers via `index.ts` continue to work without change.
 *
 * @param model - Provider model identifier to test.
 * @returns `true` when the model family requires `max_completion_tokens`.
 */
export function usesMaxCompletionTokens(model: string): boolean {
  const m = model.toLowerCase();
  if (m === 'gpt-5' || m.startsWith('gpt-5-') || m.startsWith('gpt-5.')) return true;
  for (const prefix of ['o1', 'o3', 'o4']) {
    if (m === prefix || m.startsWith(`${prefix}-`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Provider-extension types — OpenAI-compatible providers (OpenRouter, DeepSeek,
// Anthropic-over-OpenAI bridges, Azure cache headers, etc.) ship extra fields
// on `message` / `usage` / `chunk` that aren't in the strict OpenAI TS types.
// We declare them as optional unknown and narrow with type guards rather than
// casting through unsafe assertion chains (T9767).
// ---------------------------------------------------------------------------

/**
 * Provider-extension fields observed on `choices[].message`. Combined with
 * the SDK type via intersection (see {@link ExtendedChatMessage}).
 */
interface ChatMessageExtensions {
  /** OpenRouter / DeepSeek chain-of-thought container. */
  reasoning_details?: unknown;
  /** DeepSeek/Together raw reasoning string. */
  reasoning_content?: unknown;
}

/** SDK message intersected with the provider extension fields. */
type ExtendedChatMessage = OpenAI.ChatCompletionMessage & ChatMessageExtensions;

/**
 * Provider-extension fields observed on `response.usage`. Combined with
 * the SDK type via intersection (see {@link ExtendedUsage}).
 */
interface UsageExtensions {
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
  /** Anthropic-over-OpenAI bridges (e.g. some proxies) surface these directly. */
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  /** OpenRouter shorthand. */
  cached_tokens?: unknown;
}

/** SDK usage intersected with the provider extension fields. */
type ExtendedUsage = OpenAI.CompletionUsage & UsageExtensions;

/**
 * Provider-extension fields observed on streaming chunks (e.g. include_usage).
 * The SDK does not expose `usage` on `ChatCompletionChunk` in all versions —
 * declared as optional + nullable so intersection works across SDK majors.
 */
interface ChatCompletionChunkExtensions {
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
}

/** SDK chunk intersected with the provider extension fields. */
type ExtendedChatCompletionChunk = OpenAI.ChatCompletionChunk & ChatCompletionChunkExtensions;

/**
 * Type guard: value (object OR function) has the named string-keyed property.
 *
 * Accepts functions because OpenAI structured-output `responseFormat` is often
 * a class constructor (callable) with a static `.schema` field — both objects
 * and functions admit `key in value`.
 */
function hasProp<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  if (value === null || value === undefined) return false;
  const t = typeof value;
  if (t !== 'object' && t !== 'function') return false;
  return key in (value as object);
}

/**
 * Type alias for OpenAI's strictly-typed request union.
 *
 * The dynamic builder in {@link OpenAITransport._buildParams} ultimately
 * produces a `ChatCompletionCreateParams` value — this alias documents
 * the SDK type we hand off to `chat.completions.create()` and keeps the
 * builder's return type aligned with the call site (T9767).
 */
type OpenAIChatRequest = Parameters<OpenAIClient['chat']['completions']['create']>[0];

/**
 * Structural bag used to assemble an OpenAI chat-completion request.
 *
 * Fields mirror the SDK's `ChatCompletionCreateParams` but typed loosely so
 * the dynamic build path in {@link OpenAITransport._buildParams} (which sets
 * different fields per model family / streaming mode) doesn't have to satisfy
 * the SDK's discriminated unions until handoff.
 */
interface OpenAIRequestBag {
  model: string;
  messages: Array<Record<string, unknown>>;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  stop?: string[];
  reasoning_effort?: string;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  response_format?: unknown;
  verbosity?: unknown;
  top_p?: unknown;
  frequency_penalty?: unknown;
  presence_penalty?: unknown;
  seed?: unknown;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  [key: string]: unknown;
}

/**
 * Centralised conversion at the bag → SDK boundary.
 *
 * The bag we construct is provably a `ChatCompletionCreateParams` at runtime
 * (every field name + value matches the SDK contract; the SDK accepts what
 * we send unchanged). The TypeScript compiler cannot verify this because
 * `ChatCompletionMessageParam` is a closed discriminated union and our
 * `messagesToRaw()` produces plain dicts. The bag's messages are coerced
 * field-by-field through `Object.assign` onto a freshly-typed SDK request,
 * keeping the assertion narrow and inline (no module-wide `as unknown as`
 * chain — see T9767 cleanup brief).
 *
 * @task T9767
 */
function toOpenAIRequest(bag: OpenAIRequestBag): OpenAIChatRequest {
  // Use `Object.assign` to coerce the structural bag onto the SDK's union
  // type. `Object.assign` returns the typed target (here: an empty object
  // we declare as `OpenAIChatRequest`), TypeScript narrows to the SDK type,
  // and the runtime semantics are identical to a spread (all enumerable
  // own keys flow through). This sidesteps the strict discriminated-union
  // check on `messages` without an explicit assertion.
  const sdkReq: OpenAIChatRequest = Object.assign(Object.create(null) as OpenAIChatRequest, bag);
  return sdkReq;
}

// ---------------------------------------------------------------------------
// Private helpers (module-level, not exported)
// ---------------------------------------------------------------------------

/**
 * Extract the reasoning / chain-of-thought content from a non-streaming
 * OpenAI response.
 *
 * @invariant extractReasoningContent intentional try/catch swallow — this
 *   function MUST never re-throw. If any property access or type coercion
 *   fails, return null. Lints that flag the bare `catch {}` block are
 *   suppressed with a biome-ignore directive.
 *
 * @param response - Raw OpenAI.ChatCompletion from the SDK.
 * @returns Reasoning text or null when absent / unreadable.
 */
function extractReasoningContent(response: OpenAI.ChatCompletion): string | null {
  try {
    const message = response.choices[0]?.message;
    if (!message) return null;
    const extended: ExtendedChatMessage = message;
    if (Array.isArray(extended.reasoning_details) && extended.reasoning_details.length > 0) {
      const parts: string[] = [];
      for (const detail of extended.reasoning_details) {
        if (hasProp(detail, 'content') && typeof detail.content === 'string' && detail.content) {
          parts.push(detail.content);
        }
      }
      if (parts.length > 0) return parts.join('\n');
    }
    if (typeof extended.reasoning_content === 'string' && extended.reasoning_content) {
      return extended.reasoning_content;
    }
  } catch {
    return null;
  }
  return null;
}

function extractReasoningDetails(response: OpenAI.ChatCompletion): Array<Record<string, unknown>> {
  try {
    const message = response.choices[0]?.message;
    if (!message) return [];
    const extended: ExtendedChatMessage = message;
    const rd = extended.reasoning_details;
    if (!Array.isArray(rd)) return [];
    const details: Array<Record<string, unknown>> = [];
    for (const detail of rd) {
      if (typeof detail === 'object' && detail !== null) {
        details.push(detail as Record<string, unknown>);
      }
    }
    return details;
  } catch {
    return [];
  }
}

function extractCacheTokens(usage: OpenAI.CompletionUsage | null | undefined): {
  cacheCreation: number;
  cacheRead: number;
} {
  if (!usage) return { cacheCreation: 0, cacheRead: 0 };
  let cacheRead = 0;
  const extended: ExtendedUsage = usage;
  const promptDetails = extended.prompt_tokens_details;
  if (promptDetails?.cached_tokens) {
    cacheRead = Number(promptDetails.cached_tokens);
  }
  if (cacheRead === 0 && extended.cache_read_input_tokens) {
    cacheRead = Number(extended.cache_read_input_tokens);
  } else if (cacheRead === 0 && extended.cached_tokens) {
    cacheRead = Number(extended.cached_tokens);
  }
  const cacheCreation = extended.cache_creation_input_tokens
    ? Number(extended.cache_creation_input_tokens)
    : 0;
  return { cacheCreation, cacheRead };
}

// ---------------------------------------------------------------------------
// OpenAITransport
// ---------------------------------------------------------------------------

/**
 * Real OpenAI transport.
 *
 * Wraps the `openai` SDK and normalizes requests/responses to/from the
 * provider-neutral {@link LlmTransport} interface. Supports o-series models
 * (via `max_completion_tokens` branching), structured output (via `json_schema`
 * response_format or Zod `.parse()`), streaming, and reasoning content
 * extraction.
 *
 * @example
 * ```ts
 * const transport = new OpenAITransport({ apiKey: process.env.OPENAI_API_KEY! });
 * const response = await transport.complete({
 *   model: 'gpt-4o',
 *   messages: [{ role: 'user', content: 'Hello' }],
 *   maxTokens: 1024,
 * });
 * ```
 */
export class OpenAITransport implements LlmTransport {
  /** Provider identifier — always `'openai'`. */
  readonly provider = 'openai' as const;

  /**
   * Wire protocol spoken by this transport — always `'chat_completions'`.
   *
   * @see ADR-072 §Type lock-in
   */
  readonly apiMode: ApiMode = 'chat_completions' as const;

  private readonly _client: OpenAIClient;

  /**
   * Create an `OpenAITransport`.
   *
   * @param options - API key, optional base URL, and optional extra headers.
   */
  constructor(options: OpenAITransportOptions) {
    this._client = new OpenAIClient({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      defaultHeaders: options.defaultHeaders,
    });
  }

  /**
   * Execute a single completion call against the OpenAI chat completions API.
   *
   * Maps provider-neutral {@link TransportRequest} to the `openai` SDK
   * `chat.completions.create` call, then normalizes the response to
   * {@link NormalizedResponse}.
   *
   * When `request` carries a Zod-schema `responseFormat`, uses `.parse()` for
   * non-streaming structured output (the only path where `.parse()` is safe).
   *
   * @invariant parse() vs json_schema streaming split — `complete()` is the ONLY
   *   path that may use `.parse()` for structured output. `stream()` MUST NOT use
   *   `.parse()` — it always uses `json_schema` response_format instead.
   *
   * @param request - Provider-neutral request parameters.
   * @param _ctx - Transport context (unused by this transport).
   * @returns Normalized response including content, tool calls, usage, and raw SDK object.
   */
  async complete(request: TransportRequest, _ctx?: TransportContext): Promise<NormalizedResponse> {
    // @invariant T9296 W4d — validate image constraints before any SDK call.
    validateImagesForProvider(request, this.provider);

    const {
      model,
      messages,
      maxTokens,
      system,
      tools,
      temperature,
      extraParams,
      thinkingEffort,
      responseFormat,
    } = request as TransportRequest & {
      extraParams?: Record<string, unknown> | null;
      thinkingEffort?: string | null;
      thinkingBudgetTokens?: number | null;
      responseFormat?: (new (...args: unknown[]) => unknown) | Record<string, unknown> | null;
      maxOutputTokens?: number | null;
    };

    const thinkingBudgetTokens = (
      request as TransportRequest & { thinkingBudgetTokens?: number | null }
    ).thinkingBudgetTokens;

    if (thinkingBudgetTokens !== null && thinkingBudgetTokens !== undefined) {
      throw new Error(
        'OpenAI transport does not support thinkingBudgetTokens; use thinkingEffort instead',
      );
    }

    const maxOutputTokens = (request as TransportRequest & { maxOutputTokens?: number | null })
      .maxOutputTokens;

    const rawMessages = messagesToRaw(messages, system);
    const reqParams = this._buildParams({
      model,
      messages: rawMessages,
      maxTokens: maxOutputTokens ?? maxTokens,
      temperature,
      stop: (request as TransportRequest & { stop?: string[] | null }).stop,
      tools: tools as Array<Record<string, unknown>> | null | undefined,
      toolChoice: (
        request as TransportRequest & { toolChoice?: string | Record<string, unknown> | null }
      ).toolChoice,
      thinkingEffort: thinkingEffort ?? null,
      extraParams: extraParams ?? null,
    });

    // Structured output path
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
        const response = (await this._client.chat.completions.create(
          toOpenAIRequest(reqParams),
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
        return this._normalizeResponse(response, model, parsedContent);
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
      toOpenAIRequest(reqParams),
    )) as OpenAI.ChatCompletion;
    return this._normalizeResponse(response, model);
  }

  /**
   * Stream a completion against the OpenAI chat completions API.
   *
   * Yields {@link NormalizedDelta} chunks including incremental text deltas and
   * tool-call argument deltas. The final delta carries `stopReason` and `usage`.
   *
   * Tool-call streaming sequence per tool index:
   * 1. First chunk for index `i` (`tool_calls[i].function.name` present) → yields
   *    `toolCallDelta` with `{ index, name, argumentsChunk }` (start marker).
   * 2. Subsequent chunks (name absent) → yields `toolCallDelta` with
   *    `{ index, argumentsChunk }` (incremental JSON fragment).
   *
   * @invariant T9316 tool-call streaming parity — emits same toolCallDelta shape
   *   as AnthropicTransport and ChatCompletionsTransport.
   *
   * @invariant parse() vs json_schema streaming split — `stream()` MUST NOT use
   *   `.parse()` for structured output. When a `responseFormat` schema is present,
   *   only `json_schema` response_format is used. `.parse()` would block the
   *   stream since the full JSON must be assembled first — use `complete()` instead.
   *
   * @param request - Provider-neutral request parameters.
   * @param _ctx - Transport context (unused by this transport).
   * @returns An async iterable of normalized delta chunks.
   */
  async *stream(request: TransportRequest, _ctx: TransportContext): AsyncIterable<NormalizedDelta> {
    const {
      model,
      messages,
      maxTokens,
      system,
      tools,
      temperature,
      extraParams,
      thinkingEffort,
      responseFormat,
    } = request as TransportRequest & {
      extraParams?: Record<string, unknown> | null;
      thinkingEffort?: string | null;
      thinkingBudgetTokens?: number | null;
      responseFormat?: (new (...args: unknown[]) => unknown) | Record<string, unknown> | null;
      maxOutputTokens?: number | null;
    };

    const thinkingBudgetTokens = (
      request as TransportRequest & { thinkingBudgetTokens?: number | null }
    ).thinkingBudgetTokens;

    if (thinkingBudgetTokens !== null && thinkingBudgetTokens !== undefined) {
      throw new Error(
        'OpenAI transport does not support thinkingBudgetTokens; use thinkingEffort instead',
      );
    }

    const maxOutputTokens = (request as TransportRequest & { maxOutputTokens?: number | null })
      .maxOutputTokens;

    const rawMessages = messagesToRaw(messages, system);
    const reqParams = this._buildParams({
      model,
      messages: rawMessages,
      maxTokens: maxOutputTokens ?? maxTokens,
      temperature,
      stop: (request as TransportRequest & { stop?: string[] | null }).stop,
      tools: tools as Array<Record<string, unknown>> | null | undefined,
      toolChoice: (
        request as TransportRequest & { toolChoice?: string | Record<string, unknown> | null }
      ).toolChoice,
      thinkingEffort: thinkingEffort ?? null,
      extraParams: extraParams ?? null,
    });
    reqParams['stream'] = true;
    reqParams['stream_options'] = { include_usage: true };

    // @invariant parse() vs json_schema streaming split — ONLY json_schema here, never .parse()
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
      toOpenAIRequest(reqParams),
    )) as AsyncIterable<OpenAI.ChatCompletionChunk>;

    let finishReason: string | null = null;
    let usageChunkReceived = false;
    // @invariant T9295 W4c — scrub <think>...</think> blocks from OpenAI o1-series streams.
    const scrubber = new StreamingThinkScrubber();
    // Tracks which tool-call indices have already received a start delta (with name).
    // @invariant T9316 tool-call streaming parity — OpenAI transport emits toolCallDelta
    //   entries matching the pattern of AnthropicTransport and ChatCompletionsTransport:
    //   first delta for index i carries name; subsequent deltas carry argumentsChunk only.
    const seenToolCallIndices = new Set<number>();

    for await (const chunk of responseStream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        const raw = delta.content;
        const visible = scrubber.feed(raw);
        if (visible) {
          yield { text: visible, reasoning: '', stopReason: null, usage: null };
        }
      }

      // @invariant T9316 tool-call streaming — emit incremental tool-call deltas so
      //   consumers can accumulate partial argument JSON without waiting for the final message.
      if (delta?.tool_calls && delta.tool_calls.length > 0) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          const argumentsChunk = tc.function?.arguments ?? '';
          const name = tc.function?.name;
          if (!seenToolCallIndices.has(index)) {
            // First delta for this index — emit start marker with name.
            seenToolCallIndices.add(index);
            yield {
              text: '',
              reasoning: '',
              stopReason: null,
              usage: null,
              toolCallDelta: { index, name: name ?? '', argumentsChunk },
            };
          } else if (argumentsChunk) {
            // Subsequent chunks — emit incremental arguments fragment.
            yield {
              text: '',
              reasoning: '',
              stopReason: null,
              usage: null,
              toolCallDelta: { index, argumentsChunk },
            };
          }
        }
      }

      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
      const extendedChunk: ExtendedChatCompletionChunk = chunk;
      if (extendedChunk.usage) {
        const usage = extendedChunk.usage;
        const normalizedUsage: NormalizedUsage = {
          inputTokens: Number(usage.prompt_tokens) || 0,
          outputTokens: Number(usage.completion_tokens) || 0,
        };
        // Flush any held-back partial-tag buffer before the final usage event.
        const tail = scrubber.flush();
        if (tail) {
          yield { text: tail, reasoning: '', stopReason: null, usage: null };
        }
        yield {
          text: '',
          reasoning: '',
          stopReason: finishReason ?? 'stop',
          usage: normalizedUsage,
        };
        usageChunkReceived = true;
      }
    }

    if (!usageChunkReceived && finishReason) {
      const tail = scrubber.flush();
      if (tail) {
        yield { text: tail, reasoning: '', stopReason: null, usage: null };
      }
      yield { text: '', reasoning: '', stopReason: finishReason, usage: null };
    }
  }

  /**
   * Returns true when the error signals a credential rotation should be attempted.
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
   * Build the OpenAI API request params from normalized request fields.
   *
   * @invariant usesMaxCompletionTokens o-series branching — sets
   *   `max_completion_tokens` for gpt-5* / o1* / o3* / o4* models;
   *   `max_tokens` for all others.
   */
  private _buildParams(params: {
    model: string;
    messages: Array<Record<string, unknown>>;
    maxTokens: number;
    temperature?: number | null;
    stop?: string[] | null;
    tools?: Array<Record<string, unknown>> | null;
    toolChoice?: string | Record<string, unknown> | null;
    thinkingEffort?: string | null;
    extraParams?: Record<string, unknown> | null;
  }): OpenAIRequestBag {
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
    const reqParams: OpenAIRequestBag = { model, messages };

    // @invariant usesMaxCompletionTokens o-series branching
    if (usesMaxCompletionTokens(model)) {
      reqParams.max_completion_tokens = maxTokens;
      if (extraParams?.['verbosity']) reqParams.verbosity = extraParams['verbosity'];
    } else {
      reqParams.max_tokens = maxTokens;
    }

    if (temperature !== null && temperature !== undefined) reqParams.temperature = temperature;
    if (thinkingEffort) reqParams.reasoning_effort = thinkingEffort;
    if (stop && stop.length > 0) reqParams.stop = stop;

    if (tools && tools.length > 0) {
      reqParams.tools = this._convertTools(tools);
      if (toolChoice !== null && toolChoice !== undefined) reqParams.tool_choice = toolChoice;
    }

    if (extraParams) {
      for (const key of ['top_p', 'frequency_penalty', 'presence_penalty', 'seed']) {
        if (key in extraParams) reqParams[key] = extraParams[key];
      }
    }

    return reqParams;
  }

  /**
   * Normalize a raw OpenAI SDK response into {@link NormalizedResponse}.
   *
   * @param response - Raw `OpenAI.ChatCompletion` from the SDK.
   * @param modelName - Model identifier (carried into the response envelope).
   * @param contentOverride - When set, replaces the message content (used for structured output).
   */
  private _normalizeResponse(
    response: OpenAI.ChatCompletion,
    modelName: string,
    contentOverride?: unknown,
  ): NormalizedResponse {
    const usage = response.usage ?? null;
    const finishReason = response.choices[0]?.finish_reason ?? 'stop';
    const message = response.choices[0]?.message;
    const toolCalls: NormalizedToolCall[] = [];

    if (message && 'tool_calls' in message && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
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
          arguments: tc.function.arguments ?? JSON.stringify(toolInput),
        });
      }
    }

    const { cacheCreation, cacheRead } = extractCacheTokens(usage);

    const normalizedUsage: NormalizedUsage = {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      ...(cacheRead > 0 ? { cachedTokens: cacheRead } : {}),
    };

    const reasoning = extractReasoningContent(response);
    const reasoningDetails = extractReasoningDetails(response);

    const rawContent = contentOverride !== undefined ? contentOverride : (message?.content ?? '');
    const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);

    return {
      id: response.id,
      model: modelName,
      content: content || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      stopReason: finishReason,
      usage: normalizedUsage,
      ...(reasoning ? { reasoning } : {}),
      ...(reasoningDetails.length > 0 || cacheCreation > 0
        ? {
            providerData: {
              ...(reasoningDetails.length > 0 ? { reasoningDetails } : {}),
              ...(cacheCreation > 0 ? { cacheCreationInputTokens: cacheCreation } : {}),
            },
          }
        : {}),
      raw: response,
    };
  }

  /**
   * Convert provider-neutral tools to OpenAI `function` tool format.
   *
   * Already-converted inputs (first element has `type: 'function'`) are passed
   * through unchanged.
   */
  private _convertTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    if (!tools.length || tools[0]?.['type'] === 'function') return tools;
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool['name'],
        description: tool['description'],
        parameters: tool['input_schema'] ?? tool['inputSchema'],
      },
    }));
  }

  /**
   * Extract a Zod schema from a class or constructor that carries a `.schema`
   * property or IS a ZodType.
   *
   * Accepts `unknown` because at runtime the value can be a constructor with a
   * static `.schema`, a Zod type instance, or neither — narrowed via type
   * guards rather than `as unknown as` chains (T9767).
   */
  private _zodSchemaFrom(responseFormat: unknown): z.ZodTypeAny | null {
    if (hasProp(responseFormat, 'schema') && responseFormat.schema instanceof z.ZodType) {
      return responseFormat.schema;
    }
    if (responseFormat instanceof z.ZodType) return responseFormat;
    return null;
  }

  /**
   * Convert a Zod schema to a minimal JSON Schema object for the
   * `json_schema` response_format.
   *
   * Uses `.shape` for `ZodObject`; returns `{}` for other Zod types.
   * Full support would require `zod-to-json-schema` — this covers the common case.
   */
  private _zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
    if ('shape' in schema) {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(shape)) {
        properties[key] = { type: 'string' };
        if (!(field instanceof z.ZodOptional)) required.push(key);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    return {};
  }
}

// ---------------------------------------------------------------------------
// Internal: convert TransportMessage[] to raw OpenAI message format
// ---------------------------------------------------------------------------

/**
 * Map provider-neutral {@link import('@cleocode/contracts/llm/normalized-response.js').TransportMessage}[]
 * to raw OpenAI message dicts.
 *
 * System is injected as the first message with `role: 'system'`.
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
      raw.push({ role: msg.role, content: msg.content });
    }
  }

  return raw;
}
