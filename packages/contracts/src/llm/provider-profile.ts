/**
 * ProviderProfile interface and plugin contracts for the CLEO provider registry.
 *
 * Ported idiomatically from the Hermes provider registry (Python dataclass +
 * importlib pattern → TypeScript interface + dynamic ESM import). This is the
 * canonical type lock for Phase 3 of T-LLM-CRED-CENTRALIZATION — all
 * subsequent Phase 3 tasks depend on this interface shape.
 *
 * @task T9262
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import type { ModelTransport, StoredAuthTypeWire } from '../operations/llm.js';
import type { TransportMessage, TransportTool } from './normalized-response.js';
import type { ProviderOAuthConfig } from './oauth.js';

/**
 * Coarse provider capability tier used by the system-of-use router (E9).
 *
 * Ordered most→least capable: `frontier` (flagship reasoning), `standard`
 * (general-purpose), `fast` (cheap/low-latency aux), `local` (on-device, e.g.
 * Ollama). Sourced from the models.dev catalog (E8) when generated.
 *
 * @task T11756
 */
export type ProviderTier = 'frontier' | 'standard' | 'fast' | 'local';

/**
 * Describes a single LLM provider — its auth capabilities, base URL,
 * default model, and optional live model-discovery hook.
 *
 * Builtin providers (anthropic, openai, gemini, moonshot) ship with the
 * registry. User plugins under `${CLEO_HOME}/plugins/model-providers/` may
 * register additional profiles or override builtins (last-writer-wins).
 */
export interface ProviderProfile {
  /**
   * Canonical provider name. For builtin providers this MUST match a
   * {@link ModelTransport} so the credential resolver can wire the two
   * systems together. User plugins may use any unique string.
   */
  name: ModelTransport | string;

  /** Human-readable display name shown in pickers and diagnostic output. */
  displayName: string;

  /** Authentication schemes this provider supports. */
  authTypes: ReadonlyArray<StoredAuthTypeWire>;

  /**
   * Base URL for the provider's API — no trailing slash.
   *
   * @example 'https://api.anthropic.com'
   */
  baseUrl: string;

  /**
   * Recommended default model identifier for this provider.
   *
   * @example 'claude-haiku-X-Y' (use the latest haiku from @cleocode/core/llm)
   */
  defaultModel: string;

  /**
   * Alternate names that resolve to this profile. Resolution is
   * case-insensitive. Alias conflicts with another profile's primary name
   * cause a `TypeError` at registration time.
   *
   * The canonical alias map (`codex`→`openai`, `google`→`gemini`, …) is declared
   * here as DATA so the resolver never branches on provider name in code
   * (T11756 AC2 · hermes `ProviderProfile.aliases` parity).
   */
  aliases?: ReadonlyArray<string>;

  /**
   * Coarse capability tier for system-of-use routing (E9). Sourced from the
   * models.dev catalog capabilities when generated (E8 join), hand-set for
   * builtins. Absent = unknown (the router treats it as `standard`).
   *
   * Hermes derives this from `model_metadata`; CLEO carries it as profile DATA
   * so `resolveLLMForSystem` can pick the right tier without a code branch.
   *
   * @task T11756
   */
  readonly tier?: ProviderTier;

  /**
   * Cheap/fast auxiliary model for low-stakes calls (title generation, summaries,
   * the warm/aux tier). Hermes `ProviderProfile.default_aux_model` parity. Absent
   * (or empty) → fall back to {@link defaultModel}.
   *
   * @task T11756
   */
  readonly defaultAuxModel?: string;

  /**
   * Default `maxTokens` for this provider when the caller omits it. Hermes
   * `ProviderProfile.default_max_tokens` parity. Absent → the transport's own
   * default applies.
   *
   * @task T11756
   */
  readonly defaultMaxTokens?: number;

  /**
   * Temperature handling this provider REQUIRES. Hermes
   * `ProviderProfile.fixed_temperature` parity:
   *  - a `number` — the provider only accepts this exact temperature (e.g. the
   *    OpenAI o-series require `1`); the transport MUST send it and ignore the
   *    caller's override.
   *  - `'omit'` — the provider rejects a `temperature` field entirely; the
   *    transport MUST NOT send one.
   *  - absent — the caller's temperature (or the transport default) applies.
   *
   * @task T11756
   */
  readonly fixedTemperature?: number | 'omit';

  /**
   * HTTP headers sent with every request to this provider.
   * Merged into the SDK client's `defaultHeaders`.
   *
   * @example { 'anthropic-version': '2023-06-01' }
   */
  defaultHeaders?: Readonly<Record<string, string>>;

  /**
   * Environment variable names that supply credentials for this provider.
   * Sourced from the `env` field in the models.dev catalog when generated,
   * or declared by hand-written builtins and plugins. Resolver chains may
   * check these env vars for an API key before falling back to the
   * credentials store.
   *
   * @example ['ANTHROPIC_API_KEY']
   */
  envVars?: ReadonlyArray<string>;

  /**
   * Optional live model-discovery hook. When present, the registry may
   * call this to enumerate available model identifiers. Returns `null`
   * when the provider does not support live model listing or when the
   * fetch fails — callers MUST fall back to static model lists in that
   * case.
   *
   * @param apiKey - The resolved API key (or OAuth bearer token).
   * @param signal - Optional abort signal for request cancellation.
   */
  fetchModels?: (apiKey: string, signal?: AbortSignal) => Promise<ReadonlyArray<string> | null>;

  /**
   * Hook: transform messages before they are passed to the SDK.
   *
   * Default behavior (when `undefined`): identity — messages are forwarded
   * unchanged. Providers use this hook for shape conversions such as:
   * - Gemini: hoisting the system message to `systemInstruction`.
   * - Anthropic: injecting an assistant-prefill block for structured output.
   * - OpenAI o-series: merging consecutive same-role messages.
   *
   * Port of Hermes `ProviderProfile.prepare_messages` (Hermes §3.1).
   *
   * @param messages - The transport-level messages prior to provider conversion.
   * @param model - The resolved model identifier.
   * @returns Possibly-modified messages array. Implementations MUST NOT mutate
   *          the input array; return a new array if changes are needed.
   */
  readonly prepareMessages?: (
    messages: readonly TransportMessage[],
    model: string,
  ) => readonly TransportMessage[];

  /**
   * Hook: contribute provider-specific extra body fields.
   *
   * The returned object is merged into the SDK request's `extra_body`
   * (OpenAI-style) or equivalent provider field. Providers use this for:
   * - Gemini: `thinkingConfig` for extended reasoning budget.
   * - OpenRouter: Pareto router plugin parameters.
   * - Anthropic-via-OpenRouter: fine-grained tool streaming control.
   *
   * Port of Hermes `ProviderProfile.build_extra_body`.
   *
   * @param model - The resolved model identifier.
   * @param messages - The transport-level messages at call time.
   * @param tools - The tool definitions at call time.
   * @returns Object merged into the provider request's `extra_body` field.
   */
  readonly buildExtraBody?: (
    model: string,
    messages: readonly TransportMessage[],
    tools: readonly TransportTool[],
  ) => Readonly<Record<string, unknown>>;

  /**
   * Hook: contribute provider-specific top-level API kwargs.
   *
   * The returned object is shallow-merged into the SDK call kwargs. Providers
   * use this for top-level fields that do not fit into `extra_body`:
   * - xAI Grok: `x-grok-conv-id` conversation pinning header.
   * - Kimi: `reasoning_effort` top-level reasoning control.
   * - Moonshot: JSON-schema sanitization applied at the request level.
   *
   * Port of Hermes `ProviderProfile.build_api_kwargs_extras`.
   *
   * @param model - The resolved model identifier.
   * @param messages - The transport-level messages at call time.
   * @param tools - The tool definitions at call time.
   * @returns Object shallow-merged into the SDK call kwargs.
   */
  readonly buildApiKwargsExtras?: (
    model: string,
    messages: readonly TransportMessage[],
    tools: readonly TransportTool[],
  ) => Readonly<Record<string, unknown>>;

  /**
   * Whether this provider supports Anthropic-style extended thinking budget
   * tokens (`thinkingBudgetTokens` on the transport request).
   *
   * When `false` (or absent), the transport MUST throw if a caller sets
   * `thinkingBudgetTokens` on the request — the provider's API will reject it.
   *
   * @default false
   */
  readonly supportsThinkingBudget?: boolean;

  /**
   * OAuth configuration for this provider.
   *
   * When present, `cleo llm login <provider>` dispatches to the specified
   * OAuth flow rather than requiring a manual API key. The `mode` field
   * selects the grant type:
   * - `pkce` — RFC 7636 Authorization Code + PKCE (browser or headless).
   * - `device-code` — RFC 8628 Device Authorization Grant (polling).
   *
   * @task T9302
   */
  readonly oauth?: ProviderOAuthConfig;
}

/**
 * Shape that user plugin modules MUST satisfy.
 *
 * A plugin file is any `*.{ts,mjs,js,cjs}` under
 * `${CLEO_HOME}/plugins/model-providers/`. The registry imports it
 * dynamically and calls either its default export or named `register`
 * export with a {@link ProviderPluginApi} instance.
 *
 * @example
 * ```ts
 * // my-plugin.mjs
 * export function register(api) {
 *   api.registerProvider({
 *     name: 'my-provider',
 *     displayName: 'My Provider',
 *     authTypes: ['api_key'],
 *     baseUrl: 'https://api.myprovider.com',
 *     defaultModel: 'my-model-v1',
 *   });
 * }
 * ```
 */
export interface ProviderPlugin {
  /** Called by the registry with access to {@link ProviderPluginApi}. */
  register: (api: ProviderPluginApi) => void;
}

/**
 * Minimal surface exposed to plugin modules at load time.
 * Intentionally narrow — plugins should only register providers,
 * not reach into registry internals.
 */
export interface ProviderPluginApi {
  /** Register a provider profile. Last-writer-wins on name collision. */
  registerProvider: (profile: ProviderProfile) => void;
}
