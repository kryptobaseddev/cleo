/**
 * CodexResponsesTransport — OpenAI Responses API transport.
 *
 * Implements {@link LlmTransport} for providers that expose the OpenAI
 * Responses API (`openai.responses.create`), including:
 * - OpenAI (Codex CLI models, GPT-4.1, o-series)
 * - xAI (grok-* models via Responses-compatible endpoints)
 *
 * Key behavioral differences from ChatCompletionsTransport:
 * - Input uses the `input` array of ResponseInputItem (not `messages`).
 * - Tools use `{type: 'function', name, description, parameters}` shape.
 * - Tool results use `{type: 'function_call_output', call_id, output}` items.
 * - The system prompt goes in `instructions`, not a system message.
 * - Response text is extracted from `output_text` shortcut or by scanning
 *   `output` for `{type: 'message'}` items.
 * - Tool calls come from `output` items of `{type: 'function_call'}`.
 * - Usage is in `response.usage.input_tokens` / `output_tokens`.
 *
 * Parity gaps vs ChatCompletions are documented inline with:
 * `// PARITY GAP: <feature> not yet supported by OpenAI Responses API`
 *
 * @module llm/transports/codex-responses
 * @task T9311
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 5)
 * @see ADR-072 §LlmTransport — pure wire level
 */

import type { NormalizedDelta, TransportContext } from '@cleocode/contracts/llm/interfaces.js';
import type {
  LlmTransport,
  NormalizedResponse,
  NormalizedToolCall,
  NormalizedUsage,
  TransportImageBlock,
  TransportMessage,
  TransportRequest,
  TransportTextBlock,
  TransportTool,
} from '@cleocode/contracts/llm/normalized-response.js';
import type { ApiMode } from '@cleocode/contracts/llm/provider-id.js';
import type { ModelTransport } from '@cleocode/contracts/operations/llm.js';
import type OpenAI from 'openai';
import { OpenAI as OpenAIClient } from 'openai';

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link CodexResponsesTransport}.
 *
 * `baseUrl` overrides the default OpenAI API endpoint. Required when serving
 * xAI (use `'https://api.x.ai/v1'`) or any other Responses-compatible shim.
 *
 * `defaultHeaders` carries extra HTTP headers merged into every SDK request.
 * xAI uses `x-grok-conv-id` for KV-cache affinity.
 */
export interface CodexResponsesTransportOptions {
  /**
   * {@link ModelTransport} identifier for the logical provider this transport
   * serves. Returned verbatim from {@link CodexResponsesTransport.provider}.
   */
  provider: ModelTransport;
  /** API key or bearer token. */
  apiKey: string;
  /** Override base URL for non-OpenAI providers (no trailing slash). */
  baseUrl?: string;
  /** Extra headers merged into every SDK request. */
  defaultHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// CodexResponsesTransport
// ---------------------------------------------------------------------------

/**
 * Transport for providers that expose the OpenAI Responses API.
 *
 * Wraps `openai.responses.create()` and normalizes requests/responses to/from
 * the provider-neutral {@link LlmTransport} interface.
 *
 * Input items are built by {@link _buildInputItems}, which converts
 * {@link TransportMessage} arrays into the Responses API `input` format.
 * Multi-turn tool replay is handled by injecting `function_call_output`
 * items when a prior `assistant` turn carries tool calls.
 *
 * @example
 * ```ts
 * const transport = new CodexResponsesTransport({
 *   provider: 'openai',
 *   apiKey: process.env.OPENAI_API_KEY!,
 * });
 * const response = await transport.complete({
 *   model: 'codex-mini-latest',
 *   messages: [{ role: 'user', content: 'Write a fizzbuzz.' }],
 *   maxTokens: 1024,
 * });
 * ```
 */
export class CodexResponsesTransport implements LlmTransport {
  /**
   * Provider identifier — mirrors the `provider` option passed at construction.
   * Matches a {@link ModelTransport} value for role-resolver routing.
   */
  readonly provider: ModelTransport;

  /**
   * Wire protocol spoken by this transport — always `'codex_responses'`.
   *
   * @see ADR-072 §Type lock-in
   */
  readonly apiMode: ApiMode = 'codex_responses' as const;

  /** Underlying OpenAI SDK client. */
  private readonly _client: OpenAIClient;

  /**
   * Construct a CodexResponsesTransport.
   *
   * @param opts - Construction options including provider, API key, and
   *   optional base URL / default headers.
   */
  constructor(opts: CodexResponsesTransportOptions) {
    this.provider = opts.provider;
    this._client = new OpenAIClient({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
      defaultHeaders: opts.defaultHeaders,
    });
  }

  /**
   * Execute a single completion using the OpenAI Responses API.
   *
   * Maps the provider-neutral {@link TransportRequest} to
   * `openai.responses.create()` and normalizes the {@link Response} into a
   * {@link NormalizedResponse}.
   *
   * @param request - Provider-neutral request parameters.
   * @param _ctx - Transport context (unused; `request.signal` handles abort).
   * @returns Normalized response envelope.
   */
  async complete(request: TransportRequest, _ctx?: TransportContext): Promise<NormalizedResponse> {
    const input = this._buildInputItems(request);
    const tools = this._buildTools(request.tools);

    const params: Record<string, unknown> = {
      model: request.model,
      input,
      max_output_tokens: request.maxTokens,
      temperature: request.temperature ?? 0.7,
    };
    if (request.system) params['instructions'] = request.system;
    if (tools.length > 0) params['tools'] = tools;

    // PARITY GAP: cacheStrategy (system_and_3 / prefix_and_2) not yet supported
    // by OpenAI Responses API — it has its own `prompt_cache_retention` parameter
    // but no equivalent to Anthropic's cache-breakpoint injection.

    const response = (await this._client.responses.create(
      params as unknown as Parameters<typeof this._client.responses.create>[0],
      { signal: request.signal },
    )) as OpenAI.Responses.Response;

    return this._normalize(response, request.model);
  }

  /**
   * Stream a completion using the OpenAI Responses API SSE stream.
   *
   * Yields {@link NormalizedDelta} chunks from `response.output_text.delta`
   * events. The final delta is emitted when `response.completed` fires and
   * carries `stopReason` and `usage`.
   *
   * @param request - Provider-neutral request parameters.
   * @param _ctx - Transport context (unused; `request.signal` handles abort).
   * @returns Async iterable of normalized delta chunks.
   */
  async *stream(request: TransportRequest, _ctx: TransportContext): AsyncIterable<NormalizedDelta> {
    const input = this._buildInputItems(request);
    const tools = this._buildTools(request.tools);

    const params: Record<string, unknown> = {
      model: request.model,
      input,
      max_output_tokens: request.maxTokens,
      temperature: request.temperature ?? 0.7,
      stream: true,
    };
    if (request.system) params['instructions'] = request.system;
    if (tools.length > 0) params['tools'] = tools;

    // PARITY GAP: stream_options.include_usage not available in Responses API stream
    // — usage arrives in the response.completed event, not a dedicated usage chunk.

    const responseStream = (await this._client.responses.create(
      params as unknown as Parameters<typeof this._client.responses.create>[0],
      { signal: request.signal },
    )) as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;

    let finishReason: string | null = null;
    let finalUsage: NormalizedUsage | null = null;

    for await (const event of responseStream) {
      const ev = event as unknown as Record<string, unknown>;
      const evType = ev['type'] as string | undefined;

      if (evType === 'response.output_text.delta') {
        const delta = ev['delta'] as string | undefined;
        if (delta) {
          yield { text: delta, reasoning: '', stopReason: null, usage: null };
        }
        continue;
      }

      // PARITY GAP: reasoning_summary_text.delta not mapped to delta.reasoning
      // because the Responses API streams reasoning summary separately.
      // Once the API stabilizes reasoning streaming, wire this through.

      if (evType === 'response.completed') {
        const completedResponse = (ev['response'] as OpenAI.Responses.Response) ?? null;
        if (completedResponse) {
          finishReason = completedResponse.status ?? 'completed';
          const usage = completedResponse.usage;
          if (usage) {
            finalUsage = this._normalizeUsage(usage);
          }
        }
        break;
      }

      if (evType === 'response.failed' || evType === 'response.incomplete') {
        const failedResponse = (ev['response'] as OpenAI.Responses.Response) ?? null;
        if (failedResponse) {
          finishReason = failedResponse.status ?? evType;
          const usage = failedResponse.usage;
          if (usage) {
            finalUsage = this._normalizeUsage(usage);
          }
        }
        break;
      }
    }

    yield {
      text: '',
      reasoning: '',
      stopReason: finishReason ?? 'stop',
      usage: finalUsage,
    };
  }

  // ---------------------------------------------------------------------------
  // Input items construction
  // ---------------------------------------------------------------------------

  /**
   * Convert provider-neutral messages to the Responses API `input` array.
   *
   * Mapping rules:
   * - `user` / `assistant` string messages → `EasyInputMessage` with `type:'message'`.
   * - `user` / `assistant` multimodal blocks → content list with `input_text` /
   *   `input_image` items.
   * - `tool` messages (role=`'tool'`) → `function_call_output` items using
   *   `toolUseId` as `call_id`.
   *
   * Multi-turn tool replay: when an assistant message's raw content is a
   * `function_call` JSON envelope (injected by the agent loop after a tool
   * call round-trip), the item is converted to a `function_call` input item
   * so the Responses API can continue the conversation.
   *
   * @param request - Full transport request.
   * @returns Responses API input items array.
   */
  private _buildInputItems(request: TransportRequest): Array<Record<string, unknown>> {
    const items: Array<Record<string, unknown>> = [];

    for (const msg of request.messages) {
      if (msg.role === 'tool') {
        // Tool result: convert to function_call_output
        items.push({
          type: 'function_call_output',
          call_id: msg.toolUseId ?? `call_${Date.now().toString(36)}`,
          output: typeof msg.content === 'string' ? msg.content : extractTextContent(msg),
        });
        continue;
      }

      // user or assistant messages
      const contentItems = buildContentList(msg);
      if (contentItems.length === 1 && contentItems[0]?.['type'] === 'input_text') {
        // Simple text — use the EasyInputMessage shorthand
        items.push({
          type: 'message',
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: (contentItems[0] as Record<string, unknown>)['text'] as string,
        });
      } else {
        items.push({
          type: 'message',
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: contentItems,
        });
      }
    }

    return items;
  }

  // ---------------------------------------------------------------------------
  // Tool conversion
  // ---------------------------------------------------------------------------

  /**
   * Convert provider-neutral tool definitions to the Responses API
   * `{type: 'function', name, description, parameters, strict}` shape.
   *
   * @param tools - Provider-neutral tool definitions (may be undefined).
   * @returns Responses API tool objects, or empty array.
   */
  private _buildTools(
    tools: ReadonlyArray<TransportTool> | undefined,
  ): Array<Record<string, unknown>> {
    if (!tools || tools.length === 0) return [];
    return tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: false,
    }));
  }

  // ---------------------------------------------------------------------------
  // Response normalization
  // ---------------------------------------------------------------------------

  /**
   * Normalize an OpenAI Responses API {@link Response} into a
   * {@link NormalizedResponse}.
   *
   * Mapping rules:
   * - `content` — from `response.output_text` shortcut (SDK convenience
   *   property that aggregates all output_text parts).
   * - `toolCalls` — from `output` items of `type: 'function_call'`.
   * - `stopReason` — from `response.status` (completed / failed / incomplete).
   * - `usage` — `input_tokens` → `inputTokens`, `output_tokens` → `outputTokens`.
   * - `cachedTokens` — from `usage.input_tokens_details.cached_tokens`.
   * - `raw` — unmodified SDK response.
   *
   * @param response - Raw Responses API response object.
   * @param requestedModel - Model string from the originating request.
   * @returns Normalized response envelope.
   */
  private _normalize(
    response: OpenAI.Responses.Response,
    requestedModel: string,
  ): NormalizedResponse {
    const content =
      response.output_text && response.output_text.length > 0
        ? response.output_text
        : extractTextFromOutput(response.output);

    const toolCalls = extractToolCallsFromOutput(response.output);

    const usage = this._normalizeUsage(response.usage ?? null);

    return {
      id: response.id ?? `resp-${Date.now().toString(36)}`,
      model: String(response.model ?? requestedModel),
      content: content || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      stopReason: response.status ?? 'completed',
      usage,
      providerData: {
        codex_response_id: response.id,
      },
      raw: response,
    };
  }

  /**
   * Normalize OpenAI Responses API usage into {@link NormalizedUsage}.
   *
   * @param usage - Raw usage object (may be null when the API omits it).
   * @returns Normalized usage with optional `cachedTokens`.
   */
  private _normalizeUsage(usage: OpenAI.Responses.ResponseUsage | null): NormalizedUsage {
    if (!usage) return { inputTokens: 0, outputTokens: 0 };

    const normalized: NormalizedUsage = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    };

    const cached = usage.input_tokens_details?.cached_tokens;
    if (typeof cached === 'number' && cached > 0) {
      normalized.cachedTokens = cached;
    }

    return normalized;
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text content from a {@link TransportMessage}.
 *
 * When `content` is a plain string, returns it as-is. When it is a multimodal
 * block array, concatenates all `text` blocks and drops `image` blocks.
 *
 * @param message - Transport message to extract text from.
 * @returns Plain text string.
 */
function extractTextContent(message: TransportMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter(
      (block: TransportTextBlock | TransportImageBlock): block is TransportTextBlock =>
        block.type === 'text',
    )
    .map((block: TransportTextBlock) => block.text)
    .join('');
}

/**
 * Build a Responses API content list from a {@link TransportMessage}.
 *
 * Each text block becomes `{type: 'input_text', text}`.
 * Each image block becomes `{type: 'input_image', image_url, detail: 'auto'}`.
 *
 * @param message - Transport message to convert.
 * @returns Array of Responses API content items.
 */
function buildContentList(message: TransportMessage): Array<Record<string, unknown>> {
  if (typeof message.content === 'string') {
    return [{ type: 'input_text', text: message.content }];
  }

  return message.content.map((block: TransportTextBlock | TransportImageBlock) => {
    if (block.type === 'text') {
      return { type: 'input_text', text: block.text };
    }
    // image block
    const source = block.source;
    const imageUrl =
      source.type === 'base64' ? `data:${source.mediaType};base64,${source.data}` : source.data;
    return { type: 'input_image', image_url: imageUrl, detail: 'auto' };
  });
}

/**
 * Extract plain text from a Responses API `output` item array.
 *
 * Scans for `{type: 'message'}` output items and concatenates all
 * `{type: 'output_text'}` content parts.
 *
 * @param output - Array of ResponseOutputItem objects (typed as unknown[]).
 * @returns Concatenated text content, or empty string.
 */
function extractTextFromOutput(output: ReadonlyArray<unknown>): string {
  const parts: string[] = [];
  for (const item of output) {
    const it = item as Record<string, unknown>;
    if (it['type'] !== 'message') continue;
    const content = it['content'];
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<Record<string, unknown>>) {
      if (part['type'] === 'output_text' && typeof part['text'] === 'string') {
        parts.push(part['text']);
      }
    }
  }
  return parts.join('');
}

/**
 * Extract tool calls from a Responses API `output` item array.
 *
 * Scans for `{type: 'function_call'}` items and maps them to
 * {@link NormalizedToolCall}.
 *
 * The Responses API uses `call_id` as the stable tool-call identifier (not `id`).
 * Both are stored: `NormalizedToolCall.id` is set to `call_id` (the replay key),
 * and `providerData.response_item_id` carries the item's `id` field for tracing.
 *
 * @param output - Array of ResponseOutputItem objects (typed as unknown[]).
 * @returns Array of normalized tool calls.
 */
function extractToolCallsFromOutput(output: ReadonlyArray<unknown>): NormalizedToolCall[] {
  const calls: NormalizedToolCall[] = [];
  for (const item of output) {
    const it = item as Record<string, unknown>;
    if (it['type'] !== 'function_call') continue;

    calls.push({
      id: typeof it['call_id'] === 'string' ? it['call_id'] : null,
      name: typeof it['name'] === 'string' ? it['name'] : 'unknown',
      arguments: typeof it['arguments'] === 'string' ? it['arguments'] : '{}',
      providerData: {
        call_id: it['call_id'],
        response_item_id: it['id'],
      },
    });
  }
  return calls;
}
