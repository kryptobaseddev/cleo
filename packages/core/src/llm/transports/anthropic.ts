/**
 * Anthropic LLM transport — full Wave 1c implementation.
 *
 * Absorbs ALL behavior from `backends/anthropic.ts`: prompt-caching breakpoints,
 * assistant-prefill guard, structured output (Zod schema injection + JSON repair),
 * extended-thinking (`thinkingBudgetTokens`), tool-choice mapping, and streaming.
 *
 * Construction: `new AnthropicTransport({ apiKey, baseUrl?, defaultHeaders? })`
 * where `defaultHeaders` carries OAuth `Authorization: Bearer …` headers when
 * the credential was resolved as `authType: 'oauth'`.
 *
 * @module llm/transports/anthropic
 * @task T9263
 * @task T9282 (W0c — stub stream() + apiMode)
 * @task T9285 (W1c — full stream() + backend behavior absorption)
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  Message,
  MessageParam,
  MessageStreamEvent,
  TextBlock,
  ThinkingBlock,
  Tool,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { NormalizedDelta, TransportContext } from '@cleocode/contracts/llm/interfaces.js';
import type {
  LlmTransport,
  NormalizedResponse,
  NormalizedToolCall,
  NormalizedUsage,
  TransportMessage,
  TransportRequest,
  TransportTool,
} from '@cleocode/contracts/llm/normalized-response.js';
import type { ApiMode } from '@cleocode/contracts/llm/provider-id.js';
import { z } from 'zod';
import { validateImagesForProvider } from '../image-routing.js';
import type { CacheControlMarker, PromptCachingStrategy } from '../prompt-caching.js';
import { injectCacheBreakpoints } from '../prompt-caching.js';
import { repairResponseModelJson } from '../structured-output.js';

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link AnthropicTransport}.
 *
 * `baseUrl` is used to route requests through proxy providers or internal
 * gateways. `defaultHeaders` carries extra HTTP headers — typically the
 * `Authorization: Bearer …` header when using OAuth credentials and the
 * `anthropic-beta` header for extended-thinking enablement.
 */
export interface AnthropicTransportOptions {
  /**
   * API key (sent as `x-api-key`).
   *
   * Use this for legacy API-key auth. For OAuth bearer auth (Claude Code
   * tokens, `kimi-code` OAuth, etc.) pass {@link authToken} instead — the
   * Anthropic SDK routes `authToken` to `Authorization: Bearer …` and skips
   * the `x-api-key` header, which is what the OAuth gateways require.
   */
  apiKey?: string;
  /**
   * OAuth bearer token (sent as `Authorization: Bearer …`).
   *
   * Mutually exclusive with {@link apiKey} at the wire level — the Anthropic
   * SDK uses `authToken` when both are set, but callers SHOULD pass only one
   * to avoid confusion.
   */
  authToken?: string;
  /** Override base URL (e.g. for proxies or on-prem deployments). */
  baseUrl?: string;
  /** Extra headers merged into every SDK request. */
  defaultHeaders?: Record<string, string>;
  /**
   * Prompt-caching injection strategy applied to every request.
   * Defaults to `'system_and_3'` to keep the same default as `AnthropicBackend`.
   */
  promptCaching?: PromptCachingStrategy;
}

// ---------------------------------------------------------------------------
// Type guards (narrows ContentBlock discriminated union)
// ---------------------------------------------------------------------------

/** Checks if a content block is a plain text block. */
function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text';
}

/** Checks if a content block is a tool-use block. */
function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

/** Checks if a content block is a thinking block. */
function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  return block.type === 'thinking';
}

// ---------------------------------------------------------------------------
// Message mapping helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain-text content from a message's `content` field.
 *
 * Handles multimodal union: when `content` is a string, returns it directly.
 * When it is a block array, concatenates text blocks and drops image blocks.
 *
 * @param content - Message content field (string or block array).
 * @returns Plain-text string for Anthropic SDK message params.
 */
function extractPlainText(content: TransportMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter(
      (block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text',
    )
    .map((block) => block.text)
    .join('');
}

/**
 * Maps a provider-neutral {@link TransportMessage} array to the Anthropic
 * `MessageParam[]` format.
 *
 * Tool-result messages (`role: 'tool'`) are mapped to `role: 'user'` with a
 * `tool_result` content block, as required by the Anthropic Messages API.
 */
function mapMessages(messages: TransportMessage[]): MessageParam[] {
  return messages.map((msg): MessageParam => {
    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.toolUseId ?? '',
            content: extractPlainText(msg.content),
          },
        ],
      };
    }
    return {
      role: msg.role,
      content: extractPlainText(msg.content),
    };
  });
}

/**
 * Maps a {@link TransportTool} array to the Anthropic `Tool[]` format.
 *
 * The Anthropic API expects tools in the `{ name, description, input_schema }`
 * shape where `input_schema` is a JSON Schema object with `type: "object"`.
 */
function mapTools(tools: TransportTool[]): Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Tool['input_schema'],
  }));
}

// ---------------------------------------------------------------------------
// Response mapping helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the joined text content from the Anthropic content block array.
 * Returns `null` when no text blocks are present (pure tool-call response).
 */
function extractTextContent(blocks: ContentBlock[]): string | null {
  const textParts = blocks.filter(isTextBlock).map((b) => b.text);
  return textParts.length > 0 ? textParts.join('') : null;
}

/**
 * Extracts the joined thinking text from the Anthropic content block array.
 * Returns `null` when no thinking blocks are present.
 */
function extractReasoning(blocks: ContentBlock[]): string | null {
  const thinkingParts = blocks.filter(isThinkingBlock).map((b) => b.thinking);
  return thinkingParts.length > 0 ? thinkingParts.join('') : null;
}

/**
 * Extracts normalized tool calls from the Anthropic content block array.
 * Returns `null` when no tool-use blocks are present.
 */
function extractToolCalls(blocks: ContentBlock[]): NormalizedToolCall[] | null {
  const toolBlocks = blocks.filter(isToolUseBlock);
  if (toolBlocks.length === 0) return null;
  return toolBlocks.map((b) => ({
    id: b.id,
    name: b.name,
    arguments: JSON.stringify(b.input),
  }));
}

/**
 * Maps the Anthropic `Usage` object to {@link NormalizedUsage}.
 *
 * `cache_read_input_tokens` is `null` when caching was not used; we map
 * `null → undefined` to keep the optional field absent in the output.
 */
function mapUsage(usage: Message['usage']): NormalizedUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedTokens: usage.cache_read_input_tokens ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Structured output helpers
// ---------------------------------------------------------------------------

/**
 * Extract a Zod schema from a class or constructor that carries a `.schema`
 * property or IS a ZodType.
 */
function zodSchemaFrom(
  responseFormat: (new (...args: unknown[]) => unknown) | null | undefined,
): z.ZodTypeAny | null {
  if (responseFormat == null) return null;
  const asAny = responseFormat as unknown as Record<string, unknown>;
  if (asAny['schema'] instanceof z.ZodType) return asAny['schema'] as z.ZodTypeAny;
  if (responseFormat instanceof z.ZodType) return responseFormat as unknown as z.ZodTypeAny;
  return null;
}

/**
 * Get a JSON schema string from a response format constructor, used to inject
 * schema context into the assistant prompt for Anthropic's non-prefill path.
 */
function getJsonSchemaString(responseFormat: new (...args: unknown[]) => unknown): string {
  const schema = zodSchemaFrom(responseFormat);
  if (schema && 'shape' in schema) {
    return JSON.stringify((schema as z.ZodObject<z.ZodRawShape>).shape, null, 2);
  }
  return '{}';
}

/**
 * Append text to the last message in a message array, used to inject schema
 * prompts before the structured output call.
 */
function appendTextToLastMessage(messages: Array<Record<string, unknown>>, suffix: string): void {
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

/**
 * Convert a tool_choice string/object to Anthropic tool_choice API format.
 */
function convertToolChoice(
  toolChoice: string | Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (toolChoice == null) return null;
  if (typeof toolChoice === 'object') return toolChoice;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'any' || toolChoice === 'required') return { type: 'any' };
  if (toolChoice === 'none') return { type: 'none' };
  return { type: 'tool', name: toolChoice };
}

// ---------------------------------------------------------------------------
// AnthropicTransport
// ---------------------------------------------------------------------------

/**
 * Real Anthropic transport — full Wave 1c implementation.
 *
 * Wraps `@anthropic-ai/sdk` and normalizes requests/responses to/from the
 * provider-neutral {@link LlmTransport} interface. Supports both API-key and
 * OAuth credentials via `defaultHeaders`.
 *
 * Absorbs all behavior from `AnthropicBackend`:
 * - Prompt-caching breakpoints (`injectCacheBreakpoints`)
 * - Assistant-prefill guard (claude-4-class models reject prefill)
 * - Structured output via Zod schema injection + JSON repair
 * - Extended-thinking via `thinkingBudgetTokens`
 * - Tool-choice mapping to Anthropic API format
 * - Full streaming with reasoning/thinking block routing
 *
 * @example
 * ```ts
 * const transport = new AnthropicTransport({ apiKey: process.env.ANTHROPIC_API_KEY! });
 * const response = await transport.complete({
 *   model: 'claude-sonnet-4-6',
 *   messages: [{ role: 'user', content: 'Hello' }],
 *   maxTokens: 1024,
 * });
 * ```
 */
export class AnthropicTransport implements LlmTransport {
  /** Provider identifier — always `'anthropic'`. */
  readonly provider = 'anthropic' as const;

  /**
   * Wire protocol spoken by this transport — always `'anthropic_messages'`.
   *
   * @see ADR-072 §Type lock-in
   */
  readonly apiMode: ApiMode = 'anthropic_messages' as const;

  private readonly _client: Anthropic;
  private readonly _defaultPromptCaching: PromptCachingStrategy;

  /**
   * Create an `AnthropicTransport`.
   *
   * @param options - API key, optional base URL, optional extra headers, and
   *   optional default prompt-caching strategy (defaults to `'system_and_3'`).
   */
  constructor(options: AnthropicTransportOptions) {
    this._client = new Anthropic({
      apiKey: options.apiKey,
      authToken: options.authToken,
      baseURL: options.baseUrl,
      defaultHeaders: options.defaultHeaders,
    });
    this._defaultPromptCaching = options.promptCaching ?? 'system_and_3';
  }

  /**
   * R2 CRITICAL: Claude 4-class models reject assistant-prefill.
   *
   * @invariant _supportsAssistantPrefill guard — returns false for
   *   `claude-opus-4*`, `claude-sonnet-4*`, `claude-haiku-4*`. CLEO's
   *   primary model `claude-sonnet-4-6` MUST use the non-prefill JSON schema
   *   injection path. Correctness bug if this guard is omitted or bypassed.
   *
   * @param model - Model identifier to test.
   * @returns `false` when the model is a Claude 4-class model that rejects prefill.
   */
  static _supportsAssistantPrefill(model: string): boolean {
    return !(
      model.startsWith('claude-opus-4') ||
      model.startsWith('claude-sonnet-4') ||
      model.startsWith('claude-haiku-4')
    );
  }

  /**
   * Execute a single completion call against the Anthropic Messages API.
   *
   * Supports: prompt caching, extended thinking, structured output (Zod),
   * assistant prefill, tool-choice mapping, stop sequences.
   *
   * @param request - Provider-neutral request parameters. Extended fields
   *   (`thinkingBudgetTokens`, `responseFormat`, `stop`, `toolChoice`,
   *   `extraParams`, `promptCaching`) are read via intersection cast so the
   *   LlmTransport interface remains stable.
   * @param _ctx - Transport context (unused by this transport currently).
   * @returns Normalized response including content, tool calls, usage, and raw SDK object.
   */
  async complete(request: TransportRequest, _ctx?: TransportContext): Promise<NormalizedResponse> {
    // @invariant T9296 W4d — validate image constraints before any SDK call.
    validateImagesForProvider(request, this.provider);

    const ext = request as TransportRequest & {
      thinkingBudgetTokens?: number | null;
      thinkingEffort?: string | null;
      responseFormat?: (new (...args: unknown[]) => unknown) | null;
      stop?: string[] | null;
      toolChoice?: string | Record<string, unknown> | null;
      extraParams?: Record<string, unknown> | null;
      promptCaching?: PromptCachingStrategy;
    };

    const { model, messages, maxTokens, system, tools, temperature, signal } = request;

    const thinkingBudgetTokens = ext.thinkingBudgetTokens;
    const thinkingEffort = ext.thinkingEffort;
    const responseFormat = ext.responseFormat ?? null;
    const stop = ext.stop;
    const toolChoice = ext.toolChoice;
    const extraParams = ext.extraParams;
    const promptCaching = ext.promptCaching ?? this._defaultPromptCaching;

    if (thinkingEffort != null) {
      throw new Error(
        'Anthropic transport does not support thinkingEffort; use thinkingBudgetTokens instead',
      );
    }

    // structuredClone() protection happens inside _extractSystem.
    const { requestMessages, systemMessages } = this._extractSystem(messages);

    // Merge top-level system field with system messages extracted from message array.
    if (system != null) systemMessages.unshift(system);

    const reqParams: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: requestMessages,
    };

    if (temperature != null) reqParams['temperature'] = temperature;
    if (stop && stop.length > 0) reqParams['stop_sequences'] = stop;
    if (systemMessages.length > 0) {
      reqParams['system'] = [{ type: 'text', text: systemMessages.join('\n\n') }];
    }
    if (tools && tools.length > 0) {
      reqParams['tools'] = mapTools(tools);
      const tc = convertToolChoice(toolChoice);
      if (tc !== null) reqParams['tool_choice'] = tc;
    }
    if (thinkingBudgetTokens) {
      reqParams['thinking'] = { type: 'enabled', budget_tokens: thinkingBudgetTokens };
    }
    if (extraParams) {
      for (const key of ['top_p', 'top_k']) {
        if (key in extraParams) reqParams[key] = extraParams[key];
      }
    }

    // @invariant injectCacheBreakpoints called POST-translation inside SDK params
    // (not on the TransportRequest). Injection operates on the reqParams object
    // which already holds Anthropic-translated message shapes.
    injectCacheBreakpoints(
      reqParams as {
        system?: Array<{ type: string; text?: string; cache_control?: CacheControlMarker }>;
        messages: Array<{
          role: 'user' | 'assistant';
          content: string | Array<Record<string, unknown>>;
        }>;
      },
      promptCaching,
    );

    // @invariant thinkingBudgetTokens vs useJsonPrefill MUTEX — when thinking is
    // enabled, prefill is suppressed because the Anthropic API rejects assistant-turn
    // prefill when `thinking` is active. Additionally, Claude 4-class models reject
    // prefill entirely (see _supportsAssistantPrefill). The mutex is enforced here.
    const useJsonPrefill =
      responseFormat != null &&
      !thinkingBudgetTokens &&
      AnthropicTransport._supportsAssistantPrefill(model);

    const msgs = reqParams['messages'] as Array<Record<string, unknown>>;

    if (useJsonPrefill && msgs.length > 0) {
      if (typeof responseFormat === 'function') {
        const schemaJson = getJsonSchemaString(responseFormat);
        appendTextToLastMessage(
          msgs,
          `\n\nRespond with valid JSON matching this schema:\n${schemaJson}`,
        );
      }
      msgs.push({ role: 'assistant', content: '{' });
    } else if (responseFormat != null && typeof responseFormat === 'function' && msgs.length > 0) {
      const schemaJson = getJsonSchemaString(responseFormat);
      appendTextToLastMessage(
        msgs,
        `\n\nRespond with valid JSON matching this schema:\n${schemaJson}`,
      );
    }

    const response = await this._client.messages.create(
      reqParams as unknown as Parameters<Anthropic['messages']['create']>[0],
      signal != null ? { signal } : undefined,
    );

    return this._normalizeResponse({
      response: response as Message,
      responseFormat,
      prefillJson: useJsonPrefill,
      modelName: model,
    });
  }

  /**
   * Stream a completion against the Anthropic Messages API.
   *
   * Yields text deltas as they arrive. Thinking/reasoning blocks are routed to
   * `delta.reasoning`; visible text goes to `delta.text`. Tool-use content
   * blocks are dropped from streaming output (the full tool call is only
   * available from the final message, which callers should fetch via
   * `complete()` for tool-call scenarios).
   *
   * @invariant stream tool-call yield contract — text-only deltas are yielded
   *   from streaming output; `tool_use` content blocks are DROPPED during
   *   streaming. Callers that need tool call arguments MUST use `complete()`
   *   instead of `stream()`, or accumulate deltas and parse the final message.
   *
   * @invariant thinkingBudgetTokens vs useJsonPrefill MUTEX in stream() — same
   *   mutex as complete(): when `thinkingBudgetTokens` is set, `useJsonPrefill`
   *   is forced false regardless of `responseFormat`.
   *
   * @param request - Provider-neutral request parameters.
   * @param _ctx - Transport context (unused by this transport currently).
   * @returns An async iterable of normalized delta chunks.
   */
  async *stream(request: TransportRequest, _ctx: TransportContext): AsyncIterable<NormalizedDelta> {
    const ext = request as TransportRequest & {
      thinkingBudgetTokens?: number | null;
      thinkingEffort?: string | null;
      responseFormat?: (new (...args: unknown[]) => unknown) | null;
      stop?: string[] | null;
      toolChoice?: string | Record<string, unknown> | null;
      extraParams?: Record<string, unknown> | null;
      promptCaching?: PromptCachingStrategy;
    };

    const { model, messages, maxTokens, system, tools, temperature } = request;

    const thinkingBudgetTokens = ext.thinkingBudgetTokens;
    const thinkingEffort = ext.thinkingEffort;
    const responseFormat = ext.responseFormat ?? null;
    const stop = ext.stop;
    const toolChoice = ext.toolChoice;
    const extraParams = ext.extraParams;
    const promptCaching = ext.promptCaching ?? this._defaultPromptCaching;

    if (thinkingEffort != null) {
      throw new Error(
        'Anthropic transport does not support thinkingEffort; use thinkingBudgetTokens instead',
      );
    }

    // structuredClone() protection happens inside _extractSystem.
    const { requestMessages, systemMessages } = this._extractSystem(messages);

    // Merge top-level system field with system messages extracted from message array.
    if (system != null) systemMessages.unshift(system);

    const reqParams: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: requestMessages,
    };

    if (temperature != null) reqParams['temperature'] = temperature;
    if (stop && stop.length > 0) reqParams['stop_sequences'] = stop;
    if (systemMessages.length > 0) {
      reqParams['system'] = [{ type: 'text', text: systemMessages.join('\n\n') }];
    }
    if (tools && tools.length > 0) {
      reqParams['tools'] = mapTools(tools);
      const tc = convertToolChoice(toolChoice);
      if (tc !== null) reqParams['tool_choice'] = tc;
    }
    if (thinkingBudgetTokens) {
      reqParams['thinking'] = { type: 'enabled', budget_tokens: thinkingBudgetTokens };
    }
    if (extraParams) {
      for (const key of ['top_p', 'top_k']) {
        if (key in extraParams) reqParams[key] = extraParams[key];
      }
    }

    // @invariant injectCacheBreakpoints called POST-translation inside SDK params
    // (not on the TransportRequest). Same guarantee as in complete().
    injectCacheBreakpoints(
      reqParams as {
        system?: Array<{ type: string; text?: string; cache_control?: CacheControlMarker }>;
        messages: Array<{
          role: 'user' | 'assistant';
          content: string | Array<Record<string, unknown>>;
        }>;
      },
      promptCaching,
    );

    // @invariant thinkingBudgetTokens vs useJsonPrefill MUTEX in stream() —
    // when thinking is enabled, prefill is suppressed. Claude 4-class models
    // also reject prefill. Both conditions are checked identically to complete().
    const useJsonPrefill =
      responseFormat != null &&
      !thinkingBudgetTokens &&
      AnthropicTransport._supportsAssistantPrefill(model);

    const msgs = reqParams['messages'] as Array<Record<string, unknown>>;

    if (useJsonPrefill && msgs.length > 0) {
      if (typeof responseFormat === 'function') {
        const schemaJson = getJsonSchemaString(responseFormat);
        appendTextToLastMessage(
          msgs,
          `\n\nRespond with valid JSON matching this schema:\n${schemaJson}`,
        );
      }
      msgs.push({ role: 'assistant', content: '{' });
    } else if (responseFormat != null && typeof responseFormat === 'function' && msgs.length > 0) {
      const schemaJson = getJsonSchemaString(responseFormat);
      appendTextToLastMessage(
        msgs,
        `\n\nRespond with valid JSON matching this schema:\n${schemaJson}`,
      );
    }

    // @invariant bare error pass-through — SDK errors propagate untouched.
    // Do NOT wrap them in a new Error so callers can route them through
    // classifyError() based on the original SDK error type and status code.
    const stream = this._client.messages.stream(
      reqParams as unknown as Parameters<Anthropic['messages']['stream']>[0],
    );

    let inThinkingBlock = false;

    for await (const chunk of stream as AsyncIterable<MessageStreamEvent>) {
      const chunkAny = chunk as unknown as Record<string, unknown>;
      const chunkType = chunkAny['type'];

      if (chunkType === 'content_block_start') {
        const blockStart = chunkAny['content_block'] as Record<string, unknown> | undefined;
        if (blockStart?.['type'] === 'thinking') {
          inThinkingBlock = true;
        } else {
          inThinkingBlock = false;
        }
        continue;
      }

      if (chunkType === 'content_block_stop') {
        inThinkingBlock = false;
        continue;
      }

      // @invariant stream tool-call yield contract — tool_use blocks are DROPPED.
      // Only text deltas (and thinking deltas routed to delta.reasoning) are yielded.
      if (chunkType === 'content_block_delta') {
        const delta = chunkAny['delta'] as Record<string, unknown> | undefined;
        if (!delta) continue;

        const deltaType = delta['type'];

        if (deltaType === 'thinking_delta') {
          const thinkingText = String(delta['thinking'] ?? '');
          if (thinkingText) {
            yield { text: '', reasoning: thinkingText, stopReason: null, usage: null };
          }
          continue;
        }

        if (deltaType === 'text_delta' && !inThinkingBlock) {
          const text = String(delta['text'] ?? '');
          if (text) {
            yield { text, reasoning: '', stopReason: null, usage: null };
          }
        }

        // input_json_delta (tool_use streaming) — dropped per @invariant
      }
    }

    const finalMessage = await stream.finalMessage();
    const stopReason = finalMessage.stop_reason ?? 'end_turn';
    const normalizedUsage: NormalizedUsage = {
      inputTokens: finalMessage.usage.input_tokens,
      outputTokens: finalMessage.usage.output_tokens,
      cachedTokens: finalMessage.usage.cache_read_input_tokens ?? undefined,
    };

    yield { text: '', reasoning: '', stopReason, usage: normalizedUsage };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract system-role messages and structuredClone the remaining messages.
   *
   * @invariant structuredClone() protection — caller arrays are cloned BEFORE
   *   `injectCacheBreakpoints` mutates message content. This prevents callers
   *   from observing `cache_control` markers injected into their own message
   *   objects across multiple calls.
   *
   * @param messages - Provider-neutral message array.
   * @returns Split `{ requestMessages, systemMessages }`.
   */
  private _extractSystem(messages: TransportMessage[]): {
    requestMessages: Array<Record<string, unknown>>;
    systemMessages: string[];
  } {
    const systemMessages: string[] = [];
    // Filter out system-role messages (not part of Anthropic's messages array).
    const nonSystemMessages = messages.filter((msg) => {
      if ((msg as { role: string }).role === 'system') {
        systemMessages.push(extractPlainText(msg.content));
        return false;
      }
      return true;
    });
    // mapMessages handles tool_result conversion; structuredClone prevents
    // injectCacheBreakpoints mutations from bleeding back into the caller's array.
    const requestMessages = structuredClone(
      mapMessages(nonSystemMessages) as unknown as Array<Record<string, unknown>>,
    );
    return { requestMessages, systemMessages };
  }

  /**
   * Normalize a raw Anthropic SDK `Message` into a {@link NormalizedResponse}.
   *
   * When `responseFormat` is provided, attempts JSON parse + Zod validation,
   * then falls back to `repairResponseModelJson` on parse failures.
   */
  private _normalizeResponse(params: {
    response: Message;
    responseFormat: (new (...args: unknown[]) => unknown) | null;
    prefillJson: boolean;
    modelName: string;
  }): NormalizedResponse {
    const { response, responseFormat, prefillJson, modelName } = params;

    const textContent = extractTextContent(response.content);
    const reasoning = extractReasoning(response.content);
    const toolCalls = extractToolCalls(response.content);
    const usage = mapUsage(response.usage);

    let content: string | null = textContent;

    if (responseFormat != null && typeof responseFormat === 'function') {
      const rawContent = prefillJson ? `{${textContent ?? ''}` : (textContent ?? '');
      const zodSchema = zodSchemaFrom(responseFormat);
      try {
        const parsed = JSON.parse(rawContent) as unknown;
        const validated = zodSchema ? zodSchema.parse(parsed) : parsed;
        content = typeof validated === 'string' ? validated : JSON.stringify(validated);
      } catch {
        try {
          const repaired = repairResponseModelJson(rawContent, zodSchema ?? z.unknown(), modelName);
          content = typeof repaired === 'string' ? repaired : JSON.stringify(repaired);
        } catch {
          content = rawContent || null;
        }
      }
    }

    // Build providerData for cache creation tokens (not in NormalizedUsage)
    const usageAny = response.usage as unknown as Record<string, unknown>;
    const cacheCreationTokens = (usageAny['cache_creation_input_tokens'] as number | null) ?? 0;

    return {
      id: response.id,
      model: response.model,
      content,
      toolCalls,
      stopReason: response.stop_reason ?? 'end_turn',
      usage,
      ...(reasoning != null ? { reasoning } : {}),
      ...(cacheCreationTokens > 0
        ? { providerData: { cacheCreationInputTokens: cacheCreationTokens } }
        : {}),
      raw: response,
    };
  }
}
