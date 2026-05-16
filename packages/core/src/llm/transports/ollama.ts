/**
 * Ollama LLM transport — native /api/chat NDJSON-streaming protocol.
 *
 * Ollama exposes a chat endpoint at `POST /api/chat` that is *mostly*
 * OpenAI-compatible but with notable quirks:
 *
 * - **NDJSON streaming**: each newline-delimited JSON object carries a `message`
 *   delta. There is no `stream_options: {include_usage: true}` equivalent —
 *   usage is included in the final chunk whose `done` field is `true`.
 * - **Single tool format**: Ollama uses `{ type: "function", function: {...} }`
 *   in the request (same as OpenAI) but the response tool-call shape has
 *   `tool_calls[i].function.name` + `.arguments` (as object, NOT a JSON string).
 * - **No system-prompt caching**: Ollama has no built-in prompt-caching API;
 *   `cachedTokens` is always 0 and `cache_control` blocks are ignored.
 * - **No authorization header required**: local deployments use no auth key.
 *   Remote deployments may send an `Authorization: Bearer <token>` header.
 * - **5xx retry**: the transport retries 503/429/500/502 responses up to
 *   {@link MAX_RETRIES} times with exponential backoff.
 *
 * Reference: https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion
 *
 * Pattern: mirrors `chat-completions.ts` — a thin native-fetch wrapper with the
 * same constructor signature and the `LlmTransport` interface contract.
 *
 * @module llm/transports/ollama
 * @task T9355 (Task A — Ollama transport, D-ph4-05 closure)
 * @epic T9354
 */

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default Ollama API base URL — the well-known local endpoint.
 *
 * Override at construction time via `OllamaTransportOptions.baseUrl`.
 */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

/** Maximum number of retry attempts for transient server errors (5xx / 429). */
const MAX_RETRIES = 3;

/** Initial backoff delay in milliseconds; doubles on each subsequent retry. */
const INITIAL_BACKOFF_MS = 500;

/** HTTP status codes that trigger a retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link OllamaTransport}.
 *
 * `baseUrl` overrides the default Ollama endpoint — useful when Ollama is
 * running on a non-standard port or on a remote host. Must NOT have a trailing
 * slash. Defaults to {@link OLLAMA_DEFAULT_BASE_URL}.
 *
 * `apiKey` is optional. Local Ollama deployments require no authentication.
 * Remote or proxied deployments may require an `Authorization: Bearer <token>`
 * header — supply the token via `apiKey` and the transport will inject the
 * header automatically.
 *
 * `defaultHeaders` are merged into every request. Useful for injecting custom
 * auth or proxy headers.
 */
export interface OllamaTransportOptions {
  /** Override base URL (default: `http://localhost:11434`). No trailing slash. */
  baseUrl?: string;
  /**
   * Optional API key / bearer token.
   *
   * When set, the transport injects `Authorization: Bearer <apiKey>` into
   * every request. Local Ollama deployments do not require this.
   */
  apiKey?: string;
  /** Extra headers merged into every request. */
  defaultHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Wire types (Ollama-specific, module-private)
// ---------------------------------------------------------------------------

/**
 * A single Ollama tool-call as it appears in the *response* JSON.
 *
 * Unlike the OpenAI wire format where `arguments` is a JSON string, Ollama
 * returns `arguments` as a native JSON object.
 */
interface OllamaResponseToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * A single NDJSON chunk emitted by Ollama during streaming.
 *
 * The `done: false` chunks carry incremental `message.content` deltas.
 * The final chunk has `done: true` and populates `eval_count` (output tokens)
 * and `prompt_eval_count` (input tokens).
 */
interface OllamaStreamChunk {
  model: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaResponseToolCall[];
  };
  done: boolean;
  /** Output token count — only present on the final chunk (`done: true`). */
  eval_count?: number;
  /** Input token count — only present on the final chunk (`done: true`). */
  prompt_eval_count?: number;
  done_reason?: string;
}

/**
 * Complete (non-streaming) Ollama response body shape.
 */
interface OllamaCompleteResponse {
  model: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaResponseToolCall[];
  };
  done?: boolean;
  done_reason?: string;
  eval_count?: number;
  prompt_eval_count?: number;
}

// ---------------------------------------------------------------------------
// OllamaTransport
// ---------------------------------------------------------------------------

/**
 * Native Ollama transport.
 *
 * Uses the global `fetch` API to send requests to Ollama's `/api/chat`
 * endpoint. No Ollama SDK is required — the protocol is simple enough that
 * direct HTTP is cleaner and avoids any dependency on third-party packages.
 *
 * Tool calls are normalized from Ollama's object-argument format to the
 * canonical JSON-string format expected by {@link NormalizedToolCall}.
 *
 * @example
 * ```ts
 * const transport = new OllamaTransport(); // defaults to localhost:11434
 * const response = await transport.complete({
 *   model: 'llama3',
 *   messages: [{ role: 'user', content: 'Hello' }],
 *   maxTokens: 512,
 * });
 * console.log(response.content); // "Hello! How can I help you?"
 * ```
 */
export class OllamaTransport implements LlmTransport {
  /**
   * Provider identifier — always `'ollama'`.
   *
   * Matches the canonical name in the builtin provider profile and the
   * `BuiltinProviderId` union in `@cleocode/contracts`.
   */
  readonly provider = 'ollama' as const;

  /**
   * Wire protocol — always `'ollama_native'`.
   *
   * Identifies the NDJSON streaming `/api/chat` protocol so that factory code
   * can select this transport without inspecting the base URL.
   *
   * @see ApiMode in `@cleocode/contracts/llm/provider-id`
   */
  readonly apiMode: ApiMode = 'ollama_native' as const;

  /** Resolved base URL (no trailing slash). */
  private readonly _baseUrl: string;

  /** Extra HTTP headers added to every request. */
  private readonly _headers: Record<string, string>;

  /**
   * Construct an OllamaTransport.
   *
   * @param opts - Optional configuration: base URL, API key, extra headers.
   */
  constructor(opts: OllamaTransportOptions = {}) {
    this._baseUrl = (opts.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/$/, '');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...opts.defaultHeaders,
    };
    if (opts.apiKey) {
      headers['Authorization'] = `Bearer ${opts.apiKey}`;
    }
    this._headers = headers;
  }

  // ---------------------------------------------------------------------------
  // Public API — LlmTransport implementation
  // ---------------------------------------------------------------------------

  /**
   * Execute a single (non-streaming) chat completion against Ollama.
   *
   * Sends `POST /api/chat` with `stream: false` and returns a
   * {@link NormalizedResponse}. Retries transient 5xx / 429 errors up to
   * {@link MAX_RETRIES} times with exponential backoff.
   *
   * @param request - Provider-neutral request parameters.
   * @param _ctx - Transport context (abort signal in `request.signal`).
   * @returns Normalized response envelope.
   * @throws {Error} After all retry attempts are exhausted or on non-retryable errors.
   */
  async complete(request: TransportRequest, _ctx?: TransportContext): Promise<NormalizedResponse> {
    const body = this._buildRequestBody(request, false);
    const raw = await this._fetchWithRetry(`${this._baseUrl}/api/chat`, body, request.signal);
    const json = (await raw.json()) as OllamaCompleteResponse;
    return this._normalizeComplete(json, request.model);
  }

  /**
   * Stream a chat completion from Ollama, yielding incremental deltas.
   *
   * Sends `POST /api/chat` with `stream: true`. Each NDJSON line from the
   * response body is parsed and emitted as a {@link NormalizedDelta}. The final
   * chunk (`done: true`) carries `stopReason` and `usage`.
   *
   * Tool-call deltas: when the final chunk carries `message.tool_calls`, the
   * transport emits one `toolCallDelta` entry per tool call after the done event.
   * This differs from OpenAI streaming (which interleaves argument chunks) because
   * Ollama delivers complete tool calls only on the terminal chunk.
   *
   * @param request - Provider-neutral request parameters.
   * @param _ctx - Transport context (abort signal in `request.signal`).
   * @returns Async iterable of normalized delta chunks.
   */
  async *stream(request: TransportRequest, _ctx: TransportContext): AsyncIterable<NormalizedDelta> {
    const body = this._buildRequestBody(request, true);
    const response = await this._fetchWithRetry(`${this._baseUrl}/api/chat`, body, request.signal);

    if (!response.body) {
      throw new Error('OllamaTransport.stream: response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalToolCalls: OllamaResponseToolCall[] | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let chunk: OllamaStreamChunk;
          try {
            chunk = JSON.parse(trimmed) as OllamaStreamChunk;
          } catch {
            // Skip malformed lines
            continue;
          }

          if (!chunk.done) {
            // Incremental content delta
            const text = chunk.message?.content ?? '';
            if (text) {
              yield { text, reasoning: '', stopReason: null, usage: null };
            }
          } else {
            // Final chunk — usage + stop reason
            const usage: NormalizedUsage = {
              inputTokens: chunk.prompt_eval_count ?? 0,
              outputTokens: chunk.eval_count ?? 0,
            };

            // Collect tool calls from the final chunk (if any)
            if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
              finalToolCalls = chunk.message.tool_calls;
            }

            yield {
              text: '',
              reasoning: '',
              stopReason: chunk.done_reason ?? 'stop',
              usage,
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Emit tool-call deltas after the done event (Ollama delivers them atomically)
    if (finalToolCalls) {
      for (let i = 0; i < finalToolCalls.length; i++) {
        const tc = finalToolCalls[i];
        if (!tc) continue;
        const args = JSON.stringify(tc.function.arguments ?? {});
        yield {
          text: '',
          reasoning: '',
          stopReason: null,
          usage: null,
          toolCallDelta: { index: i, name: tc.function.name, argumentsChunk: args },
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the Ollama `/api/chat` request body from a normalized request.
   *
   * Message conversion:
   * - `request.system` is prepended as `{ role: 'system', content: '...' }`.
   * - Multimodal content arrays are collapsed to text-only (images not yet
   *   supported by this transport — Ollama has separate image fields).
   *
   * Tool conversion:
   * - Provider-neutral `TransportTool` → Ollama `{ type: "function", function: {...} }`.
   *
   * @param request - Provider-neutral request.
   * @param stream - Whether to request NDJSON streaming.
   * @returns JSON-serializable request body object.
   */
  private _buildRequestBody(request: TransportRequest, stream: boolean): Record<string, unknown> {
    const messages: Array<{ role: string; content: string }> = [];

    if (request.system) {
      messages.push({ role: 'system', content: request.system });
    }

    for (const msg of request.messages) {
      messages.push({ role: msg.role, content: extractTextContent(msg) });
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream,
      options: {
        num_predict: request.maxTokens,
        temperature: request.temperature ?? 0.7,
      },
    };

    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((t) => convertTool(t));
    }

    return body;
  }

  /**
   * Perform a fetch with exponential-backoff retry for transient server errors.
   *
   * Retries on {@link RETRYABLE_STATUS_CODES} (429, 500, 502, 503, 504) up to
   * {@link MAX_RETRIES} times. The initial delay is {@link INITIAL_BACKOFF_MS}
   * and doubles on each attempt. Non-retryable status codes throw immediately.
   *
   * @param url - Full request URL.
   * @param body - JSON-serializable request body.
   * @param signal - Optional AbortSignal for cancellation.
   * @returns A successful `Response` object.
   * @throws {Error} On non-retryable HTTP errors or after all retries exhausted.
   */
  private async _fetchWithRetry(
    url: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
        await sleep(delay);
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: this._headers,
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        // Network-level error (e.g. ECONNREFUSED) — treat as transient
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }

      if (response.ok) {
        return response;
      }

      if (RETRYABLE_STATUS_CODES.has(response.status)) {
        lastError = new Error(
          `OllamaTransport: HTTP ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        continue;
      }

      // Non-retryable error — throw immediately
      const errText = await response.text().catch(() => '');
      throw new Error(`OllamaTransport: HTTP ${response.status} — ${errText.slice(0, 200)}`);
    }

    throw lastError ?? new Error(`OllamaTransport: all ${MAX_RETRIES} retry attempts failed`);
  }

  /**
   * Normalize a complete (non-streaming) Ollama response into a
   * {@link NormalizedResponse}.
   *
   * @param json - Parsed Ollama JSON response.
   * @param requestedModel - Model string from the originating request.
   * @returns Normalized response envelope.
   */
  private _normalizeComplete(
    json: OllamaCompleteResponse,
    requestedModel: string,
  ): NormalizedResponse {
    const msg = json.message;
    const content: string | null =
      typeof msg?.content === 'string' && msg.content.length > 0 ? msg.content : null;

    let toolCalls: NormalizedToolCall[] | null = null;
    if (msg?.tool_calls && msg.tool_calls.length > 0) {
      toolCalls = msg.tool_calls.map((tc) => normalizeOllamaToolCall(tc));
    }

    const usage: NormalizedUsage = {
      inputTokens: json.prompt_eval_count ?? 0,
      outputTokens: json.eval_count ?? 0,
    };

    return {
      id: `ollama-${Date.now().toString(36)}`,
      model: json.model ?? requestedModel,
      content,
      toolCalls,
      stopReason: json.done_reason ?? 'stop',
      usage,
      raw: json,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain-text content from a {@link TransportMessage}.
 *
 * Multimodal block arrays are collapsed by concatenating all `text` blocks.
 * Image blocks are silently dropped — Ollama image support requires a separate
 * `images` field in the request body, not yet implemented.
 *
 * @param message - The transport message.
 * @returns Plain text string.
 */
function extractTextContent(message: TransportMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content
    .filter(
      (block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text',
    )
    .map((block) => block.text)
    .join('');
}

/**
 * Convert a provider-neutral {@link TransportTool} to the Ollama wire format.
 *
 * Ollama uses the same `{ type: "function", function: {...} }` shape as OpenAI,
 * so the conversion is a straightforward field rename.
 *
 * @param tool - Provider-neutral tool definition.
 * @returns Ollama-format tool object.
 */
function convertTool(tool: TransportTool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

/**
 * Normalize an Ollama tool-call response to the canonical {@link NormalizedToolCall}.
 *
 * Ollama returns `arguments` as a native JSON object (not a string), so this
 * function serializes it to a JSON string to match the normalized contract.
 *
 * @param tc - Raw Ollama tool-call object from the response.
 * @returns Normalized tool call.
 */
function normalizeOllamaToolCall(tc: OllamaResponseToolCall): NormalizedToolCall {
  return {
    id: null, // Ollama does not assign tool-call IDs
    name: tc.function.name,
    arguments: JSON.stringify(tc.function.arguments ?? {}),
  };
}

/**
 * Promise-based sleep for exponential-backoff retry.
 *
 * @param ms - Milliseconds to wait.
 * @returns Promise that resolves after `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
