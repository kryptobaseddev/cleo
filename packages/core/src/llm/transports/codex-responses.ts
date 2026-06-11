/**
 * CodexResponsesTransport — OpenAI Responses API transport (raw-fetch variant).
 *
 * Implements {@link LlmTransport} for the ChatGPT Codex backend
 * (`https://chatgpt.com/backend-api/codex/responses`) and any provider that
 * speaks a compatible Responses-API SSE protocol (xAI grok-via-responses).
 *
 * ## Wire shape (mirrored from @earendil-works/pi-ai 0.78.x — imports banned)
 *
 * Unlike the previous OpenAI-SDK-based implementation, this transport uses
 * **raw `fetch`** to control every request header.  The Codex backend rejects
 * requests that carry the SDK's default `Accept: application/json` header or
 * that omit `store: false` in the body.
 *
 * Mandatory request headers:
 * - `Authorization: Bearer <token>`
 * - `chatgpt-account-id: <jwt claim>`
 * - `originator: codex_cli_rs` (set by buildCodexOAuthHeaders)
 * - `OpenAI-Beta: responses=experimental`
 * - `accept: text/event-stream`  (for streaming; `application/json` for complete)
 * - `content-type: application/json`
 *
 * Mandatory body fields:
 * - `model`, `input`, `instructions`
 * - `store: false`                 (codex backend rejects store:true or absent)
 * - `stream: true/false`
 *
 * @module llm/transports/codex-responses
 * @task T11985
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

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link CodexResponsesTransport}.
 *
 * `baseUrl` overrides the default endpoint. Required when serving xAI (use
 * `'https://api.x.ai/v1'`) or any other Responses-compatible shim.
 *
 * `defaultHeaders` carries extra HTTP headers merged into every request.
 * For Codex OAuth callers this should include at minimum
 * `Authorization`, `chatgpt-account-id`, and `originator` (built by
 * {@link buildCodexOAuthHeaders}).
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
  /** Extra headers merged into every request. */
  defaultHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal request-body shape
// ---------------------------------------------------------------------------

interface CodexRequestBody {
  model: string;
  input: Array<Record<string, unknown>>;
  instructions: string;
  store: false;
  stream: boolean;
  // NOTE: max_output_tokens is NOT supported by the Codex ChatGPT backend
  // (returns 400 "Unsupported parameter"). Omitted per pi-ai 0.78.x reference.
  temperature?: number;
  tools?: Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// CodexResponsesTransport
// ---------------------------------------------------------------------------

/**
 * Transport for providers that expose the OpenAI Responses API via raw fetch.
 *
 * Uses native `fetch` (not the OpenAI SDK) so that the `Accept` header,
 * `store: false` body field, and `OpenAI-Beta` header can all be set
 * explicitly — the OpenAI SDK hardcodes `Accept: application/json` and omits
 * `store`, both of which cause the Codex ChatGPT backend to return a 400.
 *
 * SSE stream parsing mirrors the pi-ai 0.78.x reference implementation
 * (`@earendil-works/pi-ai/dist/providers/openai-codex-responses.js`) —
 * imports from that package are banned; the wire shape is transcribed here.
 *
 * @example
 * ```ts
 * const transport = new CodexResponsesTransport({
 *   provider: 'openai',
 *   apiKey: process.env.CODEX_OAUTH_TOKEN!,
 *   defaultHeaders: buildCodexOAuthHeaders(process.env.CODEX_OAUTH_TOKEN!),
 * });
 * for await (const delta of transport.stream({
 *   model: 'gpt-5.5',
 *   messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
 *   maxTokens: 64,
 * }, {})) {
 *   process.stdout.write(delta.text);
 * }
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

  /** API key / OAuth bearer token. */
  private readonly _apiKey: string;

  /**
   * Resolved endpoint URL (the full `/codex/responses` path).
   * Derived once at construction so the URL normalisation runs once.
   */
  private readonly _endpointUrl: string;

  /** Extra headers merged into every request (auth, originator, etc.). */
  private readonly _defaultHeaders: Record<string, string>;

  /**
   * Construct a CodexResponsesTransport.
   *
   * @param opts - Construction options: provider, API key, optional base URL
   *   and default headers (auth + Cloudflare-bypass headers for OAuth callers).
   */
  constructor(opts: CodexResponsesTransportOptions) {
    this.provider = opts.provider;
    this._apiKey = opts.apiKey;
    this._endpointUrl = resolveCodexUrl(opts.baseUrl);
    this._defaultHeaders = opts.defaultHeaders ?? {};
  }

  // ---------------------------------------------------------------------------
  // LlmTransport — complete()
  // ---------------------------------------------------------------------------

  /**
   * Execute a single (non-streaming) completion using the Responses API.
   *
   * Makes a raw `fetch` POST to the codex endpoint with `store:false` and
   * `stream:false`, then normalises the JSON response into a
   * {@link NormalizedResponse}.
   *
   * @param request - Provider-neutral request parameters.
   * @param _ctx - Transport context (unused; `request.signal` handles abort).
   * @returns Normalized response envelope.
   */
  async complete(request: TransportRequest, _ctx?: TransportContext): Promise<NormalizedResponse> {
    const body = this._buildBody(request, false);
    const headers = this._buildHeaders(false);

    const res = await fetch(this._endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      throw new Error(await buildHttpError(res));
    }

    const json = (await res.json()) as Record<string, unknown>;
    return this._normalize(json, request.model);
  }

  // ---------------------------------------------------------------------------
  // LlmTransport — stream()
  // ---------------------------------------------------------------------------

  /**
   * Stream a completion using the Responses API SSE stream.
   *
   * Yields {@link NormalizedDelta} chunks from `response.output_text.delta`
   * events parsed from the raw SSE stream.  The final delta carries
   * `stopReason` and `usage` from `response.completed`.
   *
   * Wire shape:
   * - `store: false` (required — codex backend rejects absent or true)
   * - `stream: true`
   * - `Accept: text/event-stream`
   * - `OpenAI-Beta: responses=experimental`
   *
   * @param request - Provider-neutral request parameters.
   * @param _ctx - Transport context (unused; `request.signal` handles abort).
   * @returns Async iterable of normalized delta chunks.
   */
  async *stream(request: TransportRequest, _ctx: TransportContext): AsyncIterable<NormalizedDelta> {
    const body = this._buildBody(request, true);
    const headers = this._buildHeaders(true);

    const res = await fetch(this._endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      throw new Error(await buildHttpError(res));
    }

    if (!res.body) {
      throw new Error('codex_responses: response body is null (no SSE stream)');
    }

    let finishReason: string | null = null;
    let finalUsage: NormalizedUsage | null = null;

    for await (const event of parseSSE(res.body, request.signal)) {
      const evType = event['type'] as string | undefined;

      if (evType === 'response.output_text.delta') {
        const delta = event['delta'] as string | undefined;
        if (delta) {
          yield { text: delta, reasoning: '', stopReason: null, usage: null };
        }
        continue;
      }

      if (evType === 'response.completed') {
        const completedResponse = event['response'] as Record<string, unknown> | null;
        if (completedResponse) {
          finishReason = (completedResponse['status'] as string | undefined) ?? 'completed';
          const usage = completedResponse['usage'] as Record<string, unknown> | undefined;
          if (usage) {
            finalUsage = normalizeUsage(usage);
          }
        }
        break;
      }

      if (evType === 'response.failed' || evType === 'response.incomplete') {
        const failedResponse = event['response'] as Record<string, unknown> | null;
        if (failedResponse) {
          finishReason = (failedResponse['status'] as string | undefined) ?? evType;
          const usage = failedResponse['usage'] as Record<string, unknown> | undefined;
          if (usage) {
            finalUsage = normalizeUsage(usage);
          }
        }
        break;
      }

      if (evType === 'error') {
        const code = event['code'] as string | undefined;
        const message = event['message'] as string | undefined;
        throw new Error(`Codex error: ${message ?? code ?? JSON.stringify(event)}`);
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
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the HTTP headers for a Codex request.
   *
   * Merges the auth/cloudflare headers from `_defaultHeaders` with the
   * mandatory Codex-specific headers:
   * - `OpenAI-Beta: responses=experimental`
   * - `content-type: application/json`
   * - `accept: text/event-stream` (streaming) or `application/json` (complete)
   *
   * The Authorization header is injected only if not already present in
   * `_defaultHeaders` (OAuth callers pre-set it via buildCodexOAuthHeaders).
   *
   * @param streaming - Whether this is a streaming (SSE) or completion call.
   * @returns Plain string record of all request headers.
   */
  private _buildHeaders(streaming: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      ...this._defaultHeaders,
      'OpenAI-Beta': 'responses=experimental',
      'content-type': 'application/json',
      accept: streaming ? 'text/event-stream' : 'application/json',
    };
    // Inject Authorization only when callers haven't pre-set it.
    const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
    if (!hasAuth) {
      headers['Authorization'] = `Bearer ${this._apiKey}`;
    }
    return headers;
  }

  /**
   * Build the JSON request body for a Codex Responses API call.
   *
   * Mandatory fields per the Codex backend:
   * - `store: false`   — backend rejects absent or `true`.
   * - `instructions`   — system prompt (defaulting to empty string when absent).
   * - `input`          — array of Responses API input items.
   *
   * @param request - Provider-neutral request.
   * @param streaming - Whether to enable SSE streaming.
   * @returns Serialisable request body.
   */
  private _buildBody(request: TransportRequest, streaming: boolean): CodexRequestBody {
    const body: CodexRequestBody = {
      model: request.model,
      input: buildInputItems(request),
      instructions: request.system ?? '',
      store: false,
      stream: streaming,
    };
    // NOTE: the Codex ChatGPT backend rejects `max_output_tokens` with a 400
    // ("Unsupported parameter: max_output_tokens"). pi-ai 0.78.x omits it too.
    // Only set temperature when explicitly provided by the caller.
    if (request.temperature != null) body.temperature = request.temperature;
    const tools = buildTools(request.tools);
    if (tools.length > 0) body.tools = tools;
    return body;
  }

  /**
   * Normalize a raw Responses API JSON response into a {@link NormalizedResponse}.
   *
   * @param response - Raw parsed JSON from the Responses API.
   * @param requestedModel - Model string from the originating request.
   * @returns Normalized response envelope.
   */
  private _normalize(
    response: Record<string, unknown>,
    requestedModel: string,
  ): NormalizedResponse {
    const outputText = response['output_text'] as string | undefined;
    const output = (response['output'] as Array<unknown> | undefined) ?? [];
    const content =
      outputText && outputText.length > 0
        ? outputText
        : extractTextFromOutput(output as Array<Record<string, unknown>>);
    const toolCalls = extractToolCallsFromOutput(output as Array<Record<string, unknown>>);
    const usageRaw = response['usage'] as Record<string, unknown> | undefined;
    const usage = normalizeUsage(usageRaw ?? {});

    return {
      id: (response['id'] as string | undefined) ?? `resp-${Date.now().toString(36)}`,
      model: String((response['model'] as string | undefined) ?? requestedModel),
      content: content || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      stopReason: (response['status'] as string | undefined) ?? 'completed',
      usage,
      providerData: {
        codex_response_id: response['id'],
      },
      raw: response,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the full Responses API endpoint URL from an optional base URL.
 *
 * Mirrors the `resolveCodexUrl` logic from pi-ai 0.78.x so the same base URL
 * variants work:
 * - `https://chatgpt.com/backend-api`           → `.../codex/responses`
 * - `https://chatgpt.com/backend-api/codex`     → `.../codex/responses`
 * - `https://chatgpt.com/backend-api/codex/responses` → unchanged
 * - `undefined` (no override)                   → ChatGPT Codex default
 *
 * For non-ChatGPT providers (xAI, custom shims) the raw baseUrl is
 * appended with `/responses` when it doesn't already end with `/responses`.
 *
 * @param baseUrl - Optional override base URL (no trailing slash).
 * @returns The fully resolved endpoint URL.
 */
export function resolveCodexUrl(baseUrl: string | undefined): string {
  const DEFAULT_BASE = 'https://chatgpt.com/backend-api';
  const raw = baseUrl?.trim() ? baseUrl.trim() : DEFAULT_BASE;
  const normalized = raw.replace(/\/+$/, '');
  if (normalized.endsWith('/codex/responses')) return normalized;
  if (normalized.endsWith('/codex')) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

/**
 * Consume an HTTP error response and build a descriptive error message.
 *
 * Reads the response body (if present) and attempts to extract a
 * `{error.message}` payload from JSON.  Falls back to the raw body text when
 * JSON parsing fails, or to the HTTP status text when the body is empty.
 *
 * This replaces the previous "(no body)" message that appeared whenever the
 * Codex backend returned a structured error (e.g. `{"error":{"message":"…"}}`).
 *
 * @param res - The failed fetch Response.
 * @returns A descriptive error string including status code and body detail.
 */
async function buildHttpError(res: Response): Promise<string> {
  let bodyDetail = '';
  try {
    const text = await res.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const err = parsed['error'] as Record<string, unknown> | undefined;
        bodyDetail = (err?.['message'] as string | undefined) ?? text;
      } catch {
        bodyDetail = text;
      }
    }
  } catch {
    // Body read failed — fall through to status-only message.
  }
  return bodyDetail ? `${res.status} ${bodyDetail}` : `${res.status} status code (no body)`;
}

/**
 * Convert provider-neutral messages to the Responses API `input` array.
 *
 * Mapping rules:
 * - `user` / `assistant` string messages → `{type:'message', role, content}`.
 * - `user` / `assistant` multimodal blocks → content list with `input_text` /
 *   `input_image` items.
 * - `tool` messages (role=`'tool'`) → `function_call_output` items.
 *
 * @param request - Full transport request.
 * @returns Responses API input items array.
 */
function buildInputItems(request: TransportRequest): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

  for (const msg of request.messages) {
    if (msg.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: msg.toolUseId ?? `call_${Date.now().toString(36)}`,
        output: extractTextContent(msg),
      });
      continue;
    }

    const contentItems = buildContentList(msg);
    if (contentItems.length === 1 && contentItems[0]?.['type'] === 'input_text') {
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

/**
 * Convert provider-neutral tool definitions to the Responses API
 * `{type: 'function', name, description, parameters, strict}` shape.
 *
 * @param tools - Provider-neutral tool definitions (may be undefined).
 * @returns Responses API tool objects, or empty array.
 */
function buildTools(
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

/**
 * Extract plain text content from a {@link TransportMessage}.
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
    const source = block.source;
    const imageUrl =
      source.type === 'base64' ? `data:${source.mediaType};base64,${source.data}` : source.data;
    return { type: 'input_image', image_url: imageUrl, detail: 'auto' };
  });
}

/**
 * Extract plain text from a Responses API `output` item array.
 *
 * @param output - Array of ResponseOutputItem objects.
 * @returns Concatenated text content, or empty string.
 */
function extractTextFromOutput(output: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const item of output) {
    if (item['type'] !== 'message') continue;
    const content = item['content'];
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
 * @param output - Array of ResponseOutputItem objects.
 * @returns Array of normalized tool calls.
 */
function extractToolCallsFromOutput(output: Array<Record<string, unknown>>): NormalizedToolCall[] {
  const calls: NormalizedToolCall[] = [];
  for (const item of output) {
    if (item['type'] !== 'function_call') continue;
    calls.push({
      id: typeof item['call_id'] === 'string' ? item['call_id'] : null,
      name: typeof item['name'] === 'string' ? item['name'] : 'unknown',
      arguments: typeof item['arguments'] === 'string' ? item['arguments'] : '{}',
      providerData: {
        call_id: item['call_id'],
        response_item_id: item['id'],
      },
    });
  }
  return calls;
}

/**
 * Normalize raw Responses API usage into {@link NormalizedUsage}.
 *
 * @param usage - Raw usage object (may be empty or undefined fields).
 * @returns Normalized usage with optional `cachedTokens`.
 */
function normalizeUsage(usage: Record<string, unknown>): NormalizedUsage {
  const inputTokens = (usage['input_tokens'] as number | undefined) ?? 0;
  const outputTokens = (usage['output_tokens'] as number | undefined) ?? 0;
  const normalized: NormalizedUsage = { inputTokens, outputTokens };

  const details = usage['input_tokens_details'] as Record<string, unknown> | undefined;
  const cached = details?.['cached_tokens'] as number | undefined;
  if (typeof cached === 'number' && cached > 0) {
    normalized.cachedTokens = cached;
  }

  return normalized;
}

/**
 * Parse a raw SSE (Server-Sent Events) stream and yield JSON event objects.
 *
 * Reads chunks from a ReadableStream, splits on `\n\n` event boundaries,
 * and parses each `data:` line as JSON.  `[DONE]` terminates the loop.
 *
 * Mirrors the `parseSSE` function from pi-ai 0.78.x
 * (`@earendil-works/pi-ai/dist/providers/openai-codex-responses.js`).
 *
 * @param body - The ReadableStream from the fetch response.
 * @param signal - Optional AbortSignal for early termination.
 * @returns Async iterable of parsed JSON event objects.
 */
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) throw new Error('Request was aborted');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Error('Request was aborted');
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = chunk
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (dataLines.length > 0) {
          const data = dataLines.join('\n').trim();
          if (data && data !== '[DONE]') {
            try {
              yield JSON.parse(data) as Record<string, unknown>;
            } catch {
              // Malformed SSE JSON — skip event; don't crash the stream.
            }
          }
        }
        idx = buffer.indexOf('\n\n');
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
