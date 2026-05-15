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
 *   buildApiKwargsExtras) — the contract is now extended in W0c. Wire-up is
 *   tracked as T-llm-p4-1d (Wave 1d — Moonshot + chat-completions quirks
 *   consolidation moves inline quirks into per-provider profile hooks).
 * - Multi-turn tool replay (agent loop responsibility).
 *
 * W0c adds stub `stream()` + `apiMode` for compile parity with the extended
 * `LlmTransport` interface. Wave 1d migration (T-llm-p4-1d) replaces the stub
 * with a real streaming implementation.
 *
 * @module llm/transports/chat-completions
 * @task T9272
 * @task T9282 (W0c — stub stream() + apiMode)
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
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
import type { ProviderProfile } from '@cleocode/contracts/llm/provider-profile.js';
import type { ModelTransport } from '@cleocode/contracts/operations/llm.js';
import OpenAI from 'openai';

import { validateImagesForProvider } from '../image-routing.js';
import { StreamingThinkScrubber } from '../think-scrubber.js';

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
 *
 * `profile` is an optional {@link ProviderProfile} whose hooks
 * (`buildExtraBody`, `buildApiKwargsExtras`) are called during request
 * preparation. When absent, the transport falls back to the legacy inline
 * model-name quirk dispatch for backward compatibility.
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
  /**
   * Optional provider profile supplying `buildExtraBody` and
   * `buildApiKwargsExtras` hooks. When present, these hooks are dispatched
   * instead of the legacy inline model-name pattern quirks.
   */
  profile?: ProviderProfile;
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

  /**
   * Wire protocol spoken by this transport — always `'chat_completions'`.
   *
   * All providers served by this transport (OpenRouter, DeepSeek, xAI, Groq,
   * Moonshot, Gemini-via-shim, etc.) use the OpenAI chat completions wire format.
   *
   * @see ADR-072 §Type lock-in
   */
  readonly apiMode: ApiMode = 'chat_completions' as const;

  /** Underlying OpenAI-compatible SDK client. */
  private readonly _client: OpenAI;

  /**
   * Optional provider profile — when present, its hooks replace the inline
   * model-name pattern quirks in `_applyProviderQuirks`.
   */
  private readonly _profile: ProviderProfile | undefined;

  /**
   * Construct a ChatCompletionsTransport.
   *
   * @param opts - Construction options including provider, API key, and
   *   optional base URL / default headers / provider profile.
   */
  constructor(opts: ChatCompletionsTransportOptions) {
    this.provider = opts.provider;
    this._profile = opts.profile;
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
   * @param _ctx - Transport context (request ID, abort signal). Currently unused;
   *   `request.signal` takes precedence for abort support.
   * @returns Normalized response envelope.
   */
  async complete(request: TransportRequest, _ctx?: TransportContext): Promise<NormalizedResponse> {
    // @invariant T9296 W4d — validate image constraints before any SDK call.
    validateImagesForProvider(request, this.provider);

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

    // @invariant moonshot-no-thinking-budget: reject thinkingBudgetTokens for
    // providers that do not support it (Moonshot does not expose this parameter).
    if (
      request.thinkingBudgetTokens !== null &&
      request.thinkingBudgetTokens !== undefined &&
      this._profile &&
      !this._profile.supportsThinkingBudget
    ) {
      throw new Error(
        `Provider '${this._profile.name}' does not support thinkingBudgetTokens; ` +
          'remove thinkingBudgetTokens from the request for this provider',
      );
    }

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
   * Multimodal content blocks (W0c — {@link TransportMessage.content} union):
   * when `content` is an array, text blocks are concatenated and image blocks
   * are dropped (this transport currently operates in `'text'`-equivalent mode).
   * Wave 1d wires `request.imageMode` and ProviderProfile hooks to control this.
   *
   * TODO(T9272+/W1d): wire ProviderProfile.prepareMessages + imageMode routing
   * once Wave 1d migration lands.
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
      msgs.push({ role: m.role, content: extractTextContent(m) });
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
   * When a {@link ProviderProfile} was supplied at construction time, its
   * `buildExtraBody` and `buildApiKwargsExtras` hooks are called and the
   * results merged into `kwargs` — this is the canonical W1d path.
   *
   * When no profile is present the legacy inline model-name pattern dispatch
   * is used as a fallback for backward compatibility with callers that have
   * not yet been migrated to supply a profile.
   *
   * Profile hook dispatch (W1d):
   * - `buildExtraBody` → merged into `kwargs.extra_body` (shallow merge).
   *   Special key `__sanitizedTools` replaces `kwargs.tools` (Moonshot
   *   schema sanitization path).
   * - `buildApiKwargsExtras` → shallow-merged into `kwargs` at top level.
   *   Nested `extra_headers` is merged (not replaced) with any existing headers.
   *
   * Legacy inline quirks (fallback):
   * - **Gemini** (`gemini`): `extra_body.thinking_config` with model-aware budget.
   * - **Kimi** (`kimi`): `reasoning_effort: 'high'` + `extra_body.thinking`.
   * - **Moonshot** (`moonshot`): shallow tool schema sanitization.
   * - **OpenRouter Pareto** (`openrouter/` + Sonnet/Opus/Grok/GPT-4): plugins.
   * - **xAI/Grok** (`grok`): `extra_headers['x-grok-conv-id']`.
   *
   * @param kwargs - Mutable request kwargs dict (mutated in place).
   * @param request - Original transport request for model name + tool list.
   */
  private _applyProviderQuirks(kwargs: Record<string, unknown>, request: TransportRequest): void {
    if (this._profile) {
      // ── Profile-hook dispatch (W1d canonical path) ───────────────────────
      const messages = request.messages as readonly TransportMessage[];
      const tools = (request.tools ?? []) as readonly TransportTool[];

      if (this._profile.buildExtraBody) {
        const extra = this._profile.buildExtraBody(request.model, messages, tools);
        if (Object.keys(extra).length > 0) {
          // __sanitizedTransportTools is a sentinel from moonshotProfile.buildExtraBody
          // carrying a sanitized TransportTool[] array. The transport applies
          // _convertTools on the sanitized array to produce OpenAI-format tools.
          if ('__sanitizedTransportTools' in extra) {
            const sanitizedTransportTools = extra['__sanitizedTransportTools'] as TransportTool[];
            kwargs['tools'] = this._convertTools(sanitizedTransportTools);
            const rest = { ...extra };
            delete rest['__sanitizedTransportTools'];
            if (Object.keys(rest).length > 0) {
              const existing = (kwargs['extra_body'] as Record<string, unknown>) ?? {};
              kwargs['extra_body'] = { ...existing, ...rest };
            }
          } else {
            const existing = (kwargs['extra_body'] as Record<string, unknown>) ?? {};
            kwargs['extra_body'] = { ...existing, ...extra };
          }
        }
      }

      if (this._profile.buildApiKwargsExtras) {
        const extras = this._profile.buildApiKwargsExtras(request.model, messages, tools);
        for (const [key, value] of Object.entries(extras)) {
          if (key === 'extra_headers' && typeof value === 'object' && value !== null) {
            // Merge extra_headers instead of replacing to preserve any headers
            // already set by defaultHeaders (e.g. for OpenRouter).
            const existing = (kwargs['extra_headers'] as Record<string, string>) ?? {};
            kwargs['extra_headers'] = { ...existing, ...(value as Record<string, string>) };
          } else {
            kwargs[key] = value;
          }
        }
      }

      return;
    }

    // ── Legacy inline quirks (fallback for callers without a profile) ─────
    const model = request.model.toLowerCase();

    // @invariant gemini-thinking-config: Gemini requires extra_body.thinking_config
    // with model-aware budget (auto for 1.x/2.x/flash, high for 3.x non-flash).
    if (model.includes('gemini')) {
      const extraBody = (kwargs['extra_body'] as Record<string, unknown>) ?? {};
      extraBody['thinking_config'] = buildGeminiThinkingConfig(model);
      kwargs['extra_body'] = extraBody;
    }

    // @invariant kimi-reasoning-effort: Kimi Code requires reasoning_effort as
    // a top-level API kwarg (not inside extra_body) for chain-of-thought reasoning.
    if (model.includes('kimi')) {
      kwargs['reasoning_effort'] = 'high';
      const extraBody = (kwargs['extra_body'] as Record<string, unknown>) ?? {};
      extraBody['thinking'] = { type: 'enabled' };
      kwargs['extra_body'] = extraBody;
    }

    // @invariant moonshot-shallow-sanitize: Moonshot rejects $schema and
    // root-level additionalProperties in tool parameters. Strip these fields
    // shallowly (NOT recursively — Gemini has its own separate deep sanitizer).
    if (model.includes('moonshot') && Array.isArray(kwargs['tools'])) {
      kwargs['tools'] = (kwargs['tools'] as Array<Record<string, unknown>>).map(
        sanitizeMoonshotTool,
      );
    }

    // @invariant openrouter-pareto-plugin: OpenRouter routes high-capability
    // models through the Pareto price-optimizer plugin with min_coding_score 0.85.
    if (model.startsWith('openrouter/') && /sonnet|opus|grok|gpt-4/i.test(model)) {
      const extraBody = (kwargs['extra_body'] as Record<string, unknown>) ?? {};
      extraBody['plugins'] = [{ id: 'pareto', min_coding_score: 0.85 }];
      kwargs['extra_body'] = extraBody;
    }

    // @invariant xai-grok-conv-id: xAI's KV-cache requires a stable
    // x-grok-conv-id header per process for cache affinity.
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

  /**
   * Stream a completion against the OpenAI-compatible chat completions endpoint.
   *
   * STUB: W1 migration will implement stream() for chat-completions.
   *
   * Wave 1d (T-llm-p4-1d) replaces this stub with a real streaming
   * implementation that wires `ProviderProfile` hooks and routes deltas
   * through {@link StreamingThinkScrubber} (T9295 W4c).
   *
   * @param _request - Ignored until Wave 1d implementation lands.
   * @param _ctx - Ignored until Wave 1d implementation lands.
   * @throws {Error} Always, until the real implementation lands in Wave 1d.
   */
  // biome-ignore lint/correctness/useYield: stub — Wave 1d replaces with real streaming impl
  async *stream(
    _request: TransportRequest,
    _ctx: TransportContext,
  ): AsyncIterable<NormalizedDelta> {
    // TODO(T9295 W4c): route deltas through new StreamingThinkScrubber() before yielding.
    void StreamingThinkScrubber;
    throw new Error('STUB: W1 migration will implement stream() for chat-completions');
  }
}

// ---------------------------------------------------------------------------
// Content extraction helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Extract plain-text content from a {@link TransportMessage}.
 *
 * When `content` is a plain string, returns it as-is. When it is a multimodal
 * block array (W0c extension), concatenates all `text` blocks and drops `image`
 * blocks. This transport currently operates in text-only mode for multimodal
 * content; Wave 1d will wire `request.imageMode` and `ProviderProfile` hooks
 * for native image support.
 *
 * @param message - The transport message to extract text from.
 * @returns Plain text string for the OpenAI wire format.
 */
function extractTextContent(message: TransportMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  // Multimodal array — concatenate text blocks, drop image blocks.
  return message.content
    .filter(
      (block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text',
    )
    .map((block) => block.text)
    .join('');
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
