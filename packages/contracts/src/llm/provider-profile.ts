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
   * @example 'claude-haiku-4-5-20251001'
   */
  defaultModel: string;

  /**
   * Alternate names that resolve to this profile. Resolution is
   * case-insensitive. Alias conflicts with another profile's primary name
   * cause a `TypeError` at registration time.
   */
  aliases?: ReadonlyArray<string>;

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
