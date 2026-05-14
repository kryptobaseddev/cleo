/**
 * ChatCompletions transport — OpenAI-compatible workhorse for 16+ providers.
 *
 * Covers any provider that exposes an OpenAI-compatible
 * `chat.completions.create` endpoint: OpenRouter, DeepSeek, xAI/Grok, Groq,
 * Together, Fireworks, Kimi, Gemini-via-OpenAI-shim, Moonshot, and more.
 *
 * Port of Hermes `agent/transports/chat_completions.py` (~614 LOC). MVP slice:
 * - Base message + tool conversion (provider-neutral → OpenAI wire shape)
 * - Provider-quirk dispatch table (Gemini thinking config, Kimi reasoning_effort,
 *   OpenRouter Pareto router, xAI x-grok-conv-id, Moonshot JSON schema sanitizer)
 * - NormalizedResponse mapping (content, toolCalls, stopReason, usage, raw)
 *
 * Deferred from MVP (documented as TODO):
 * - ProviderProfile hook callbacks (prepareMessages, buildExtraBody,
 *   buildApiKwargsExtras) — these require a breaking contract extension.
 *   Tracked as TODO(T9272+): wire ProviderProfile hooks once contract is
 *   extended (deferred to next session).
 * - Streaming (handled at the agent loop level by the auxiliary router).
 * - Multi-turn tool replay (agent loop responsibility).
 *
 * @module llm/transports/chat-completions
 * @task T9272
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import type {
  LlmTransport,
  NormalizedResponse,
  NormalizedToolCall,
  NormalizedUsage,
  TransportRequest,
  TransportTool,
} from '@cleocode/contracts/llm/normalized-response.js';
import type { ModelTransport } from '@cleocode/contracts/operations/llm.js';
import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link ChatCompletionsTransport}.
 *
 * `baseUrl` overrides the default endpoint — required for every non-OpenAI
 * provider that routes through an OpenAI-compatible shim (e.g. OpenRouter
 * at `https://openrouter.ai/api/v1`, Groq at `https://api.groq.com/openai/v1`).
 *
 * `defaultHeaders` carries extra HTTP headers merged into every SDK request.
 * Typically used for proxy auth (`X-Title`, `HTTP-Referer` for OpenRouter)
 * or for OAuth bearer tokens on providers that use `Authorization: Bearer`.
 */
export interface ChatCompletionsTransportOptions {
  /**
   * `ModelTransport` identifier for the logical provider this instance serves.
   *
   * Returned verbatim from {@link ChatCompletionsTransport.provider} so that
   * role-resolver and factory code can route without inspecting the base URL.
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
// ChatCompletionsTransport
// ---------------------------------------------------------------------------

/**
 * Generic OpenAI-compatible transport.
 *
 * A single instance of this class can serve any provider that accepts the
 * OpenAI `chat.completions.create` wire shape. Provider-specific quirks are
 * applied inline by {@link ChatCompletionsTransport._applyProviderQuirks} via
 * a model-name pattern dispatch table, keeping the hot path minimal.
 *
 * Construction: `new ChatCompletionsTransport({ provider, apiKey, baseUrl?, defaultHeaders? })`
 *
 * @example
 * ```ts
 * // OpenRouter (16+ providers behind one base URL)
 * const transport = new ChatCompletionsTransport({
 *   provider: 'openai',
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   baseUrl: 'https://openrouter.ai/api/v1',
 *   defaultHeaders: { 'HTTP-Referer': 'https://cleocode.dev' },
 * });
 * const response = await transport.complete({
 *   model: 'openrouter/anthropic/claude-sonnet-4',
 *   messages: [{ role: 'user', content: 'Hello' }],
 *   maxTokens: 512,
 * });
 * ```
 */
export class ChatCompletionsTransport implements LlmTransport {
  /**
   * Provider identifier — mirrors the `provider` option passed at construction.
   * Matches a {@link ModelTransport} value so role-resolver can select this
   * transport at runtime.
   */
  readonly provider: ModelTransport;

  /** Underlying OpenAI-compatible SDK client. */
  private readonly _client: OpenAI;

  /**
   * Construct a ChatCompletionsTransport.
   *
   * @param opts - Construction options including provider, API key, and
   *   optional base URL / default headers.
   */
  constructor(opts: ChatCompletionsTransportOptions) {
    this.provider = opts.provider;
    this._client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
      defaultHeaders: opts.defaultHeaders,
    });
  }

  /**
   * Execute a single completion and return a normalized response.
   *
   * Maps the provider-neutral {@link TransportRequest} to the OpenAI
   * `chat.completions.create` wire shape, applies any provider-specific
   * quirks (Gemini, Kimi, Moonshot, OpenRouter, xAI), and normalizes the
   * raw SDK response into a {@link NormalizedResponse}.
   *
   * @param request - Provider-neutral request parameters.
   * @returns Normalized response envelope.
   */
  async complete(request: TransportRequest): Promise<NormalizedResponse> {
    const messages = this._convertMessages(request);
    const tools =
      request.tools && request.tools.length > 0 ? this._convertTools(request.tools) : undefined;

    const kwargs: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 0.7,
    };
    if (tools) kwargs['tools'] = tools;

    // Apply provider-specific quirks before sending
    this._applyProviderQuirks(kwargs, request);

    const response = (await this._client.chat.completions.create(
      kwargs as unknown as Parameters<typeof this._client.chat.completions.create>[0],
      { signal: request.signal },
    )) as OpenAI.Chat.Completions.ChatCompletion;

    return this._normalize(response, request.model);
  }

  // ---------------------------------------------------------------------------
  // Message conversion
  // ---------------------------------------------------------------------------

  /**
   * Convert provider-neutral messages + optional system prompt to OpenAI
   * wire-format message array.
   *
   * When `request.system` is set it is prepended as a `{ role: 'system' }`
   * message, which is the canonical OpenAI representation understood by all
   * OpenAI-compatible providers.
   *
   * TODO(T9272+): wire ProviderProfile.prepareMessages hook once the contract
   * is extended (deferred to next session).
   *
   * @param request - Full transport request.
   * @returns Array of OpenAI-compatible message objects.
   */
  private _convertMessages(request: TransportRequest): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    if (request.system) {
      msgs.push({ role: 'system', content: request.system });
    }
    for (const m of request.messages) {
      msgs.push({ role: m.role, content: m.content });
    }
    return msgs;
  }

  // ---------------------------------------------------------------------------
  // Tool conversion
  // ---------------------------------------------------------------------------

  /**
   * Convert provider-neutral tool definitions to OpenAI function-calling wire
   * format (`{ type: "function", function: { name, description, parameters } }`).
   *
   * @param tools - Provider-neutral tool definitions.
   * @returns OpenAI-format tool objects.
   */
  private _convertTools(tools: ReadonlyArray<TransportTool>): Array<Record<string, unknown>> {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // Provider quirk dispatch
  // ---------------------------------------------------------------------------

  /**
   * Apply provider-specific request transformations in place.
   *
   * Dispatch is purely model-name based (case-insensitive substring match).
   * Each quirk is independent and idempotent — the order only matters when
   * two quirks modify the same key (currently none do).
   *
   * Supported quirks:
   * - **Gemini** (`gemini`): adds `extra_body.thinking_config` with model-
   *   aware budget selection (`'auto'` for 2.5/flash, `'high'` otherwise).
   * - **Kimi** (`kimi`): sets `reasoning_effort: 'high'` and
   *   `extra_body.thinking: { type: 'enabled' }`.
   * - **Moonshot** (`moonshot`): sanitizes tool parameter schemas by removing
   *   `$schema` and root-level `additionalProperties` which Moonshot rejects.
   * - **OpenRouter Pareto** (`openrouter/` + Sonnet/Opus/Grok/GPT-4): injects
   *   the `pareto` plugin block into `extra_body.plugins`.
   * - **xAI/Grok** (`grok`): pins a process-scoped conversation id in
   *   `extra_headers['x-grok-conv-id']` for cache-affinity.
   *
   * TODO(T9272+): wire ProviderProfile.buildExtraBody + buildApiKwargsExtras
   * hooks once the contract is extended (deferred to next session).
   *
   * @param kwargs - Mutable request kwargs dict (mutated in place).
   * @param request - Original transport request for model name + tool list.
   */
  private _applyProviderQuirks(kwargs: Record<string, unknown>, request: TransportRequest): void {
    const model = request.model.toLowerCase();

    // ── Gemini thinking config ────────────────────────────────────────────
    if (model.includes('gemini')) {
      const extraBody = (kwargs['extra_body'] as Record<string, unknown>) ?? {};
      extraBody['thinking_config'] = buildGeminiThinkingConfig(model);
      kwargs['extra_body'] = extraBody;
    }

    // ── Kimi reasoning_effort + thinking ──────────────────────────────────
    if (model.includes('kimi')) {
      kwargs['reasoning_effort'] = 'high';
      const extraBody = (kwargs['extra_body'] as Record<string, unknown>) ?? {};
      extraBody['thinking'] = { type: 'enabled' };
      kwargs['extra_body'] = extraBody;
    }

    // ── Moonshot strict JSON Schema sanitization on tools ─────────────────
    if (model.includes('moonshot') && Array.isArray(kwargs['tools'])) {
      kwargs['tools'] = (kwargs['tools'] as Array<Record<string, unknown>>).map(
        sanitizeMoonshotTool,
      );
    }

    // ── OpenRouter Pareto router (model-gated) ─────────────────────────────
    if (model.startsWith('openrouter/') && /sonnet|opus|grok|gpt-4/i.test(model)) {
      const extraBody = (kwargs['extra_body'] as Record<string, unknown>) ?? {};
      extraBody['plugins'] = [{ id: 'pareto', min_coding_score: 0.85 }];
      kwargs['extra_body'] = extraBody;
    }

    // ── xAI/Grok conversation pinning ─────────────────────────────────────
    if (model.includes('grok')) {
      const headers = (kwargs['extra_headers'] as Record<string, string>) ?? {};
      headers['x-grok-conv-id'] = getGrokConvId();
      kwargs['extra_headers'] = headers;
    }
  }

  // ---------------------------------------------------------------------------
  // Response normalization
  // ---------------------------------------------------------------------------

  /**
   * Normalize an OpenAI `ChatCompletion` response into a
   * {@link NormalizedResponse}.
   *
   * Mapping rules:
   * - `content` — first choice message text (null when only tool_calls present).
   * - `toolCalls` — mapped from `tool_calls` array (null when none).
   * - `stopReason` — `finish_reason` or `'stop'` as fallback.
   * - `usage` — `prompt_tokens` → `inputTokens`, `completion_tokens` → `outputTokens`.
   * - `cachedTokens` — populated from `usage.prompt_tokens_details.cached_tokens`
   *   when present (Anthropic-via-OpenAI-shim, some OpenRouter models).
   * - `raw` — unmodified SDK response object.
   *
   * @param response - Raw OpenAI SDK ChatCompletion.
   * @param requestedModel - Model string from the originating request.
   * @returns Normalized response envelope.
   */
  private _normalize(
    response: OpenAI.Chat.Completions.ChatCompletion,
    requestedModel: string,
  ): NormalizedResponse {
    const choice = response.choices?.[0];
    if (!choice) {
      throw new Error(
        `ChatCompletionsTransport: response has no choices (model=${requestedModel}, id=${response.id ?? 'unknown'})`,
      );
    }

    const msg = choice.message;
    const content: string | null =
      typeof msg.content === 'string' && msg.content.length > 0 ? msg.content : null;

    let toolCalls: NormalizedToolCall[] | null = null;
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      toolCalls = msg.tool_calls.map(
        (tc): NormalizedToolCall => ({
          id: tc.id ?? null,
          name: tc.type === 'function' ? tc.function.name : 'unknown',
          arguments: tc.type === 'function' ? tc.function.arguments : '',
        }),
      );
    }

    // Base usage mapping
    const usage: NormalizedUsage = {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };

    // Populate cachedTokens from prompt_tokens_details when the provider
    // surfaces it (Anthropic-via-proxy shims, some OpenRouter backends).
    const promptDetails = (response.usage as unknown as Record<string, unknown>)?.[
      'prompt_tokens_details'
    ] as Record<string, unknown> | undefined;
    const cached = promptDetails?.['cached_tokens'];
    if (typeof cached === 'number' && cached > 0) {
      usage.cachedTokens = cached;
    }

    return {
      id: response.id ?? `chat-${Date.now().toString(36)}`,
      model: response.model ?? requestedModel,
      content,
      toolCalls,
      stopReason: choice.finish_reason ?? 'stop',
      usage,
      raw: response,
    };
  }
}

// ---------------------------------------------------------------------------
// Provider quirk helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Build the Gemini thinking configuration object for `extra_body`.
 *
 * Budget selection:
 * - `'auto'` — Gemini 1.x and 2.x models, and any model with `flash` in the
 *   name (Flash-tier models use dynamic budget allocation).
 * - `'high'` — Gemini 3 Pro and newer high-capability variants that support
 *   explicit budget control without automatic fallback.
 *
 * Rule of thumb: models without a major-version prefix ≥ 3 default to `'auto'`
 * because the `thinking_budget` field did not exist in the 1.x/2.x SDK surface.
 *
 * @param model - Lowercase model identifier string.
 * @returns Thinking config record for `extra_body.thinking_config`.
 */
function buildGeminiThinkingConfig(model: string): Record<string, unknown> {
  // Gemini 3+ Pro models that support explicit 'high' budget
  if (/gemini-3|gemini3/.test(model) && !model.includes('flash')) {
    return { thinking_budget: 'high' };
  }
  // All other Gemini models (1.x, 2.x, flash variants) use 'auto'
  return { thinking_budget: 'auto' };
}

/**
 * Strip Moonshot-incompatible fields from a single function tool object.
 *
 * Moonshot rejects `$schema` and root-level `additionalProperties` in
 * `tool.function.parameters`. This sanitizer removes both fields without
 * touching nested schemas.
 *
 * @param tool - OpenAI-format tool object (from `_convertTools` output).
 * @returns Sanitized tool object with a clean `parameters` schema.
 */
function sanitizeMoonshotTool(tool: Record<string, unknown>): Record<string, unknown> {
  if (typeof tool['function'] !== 'object' || tool['function'] === null) {
    return tool;
  }
  const fn = tool['function'] as Record<string, unknown>;
  if (typeof fn['parameters'] !== 'object' || fn['parameters'] === null) {
    return tool;
  }
  const params = { ...(fn['parameters'] as Record<string, unknown>) };
  delete params['$schema'];
  delete params['additionalProperties'];
  return { ...tool, function: { ...fn, parameters: params } };
}

/**
 * Process-scoped xAI/Grok conversation id.
 *
 * Pinning a stable `x-grok-conv-id` across requests in the same process
 * gives xAI's KV-cache layer a consistent cache key, reducing TTFT on
 * repeated system-prompt prefix calls within the same agent session.
 *
 * The id is intentionally not persisted — it resets each process restart so
 * stale cache entries do not accumulate across sessions.
 */
let _grokConvId: string | null = null;

/**
 * Return (and lazily create) the process-scoped Grok conversation id.
 *
 * @returns Stable `cleo-<timestamp>-<random>` identifier for this process.
 */
function getGrokConvId(): string {
  if (_grokConvId === null) {
    _grokConvId = `cleo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return _grokConvId;
}
