/**
 * Builtin provider profile for Kimi Code (kimi.com/code).
 *
 * Kimi Code is Moonshot AI's coding-focused offering accessible via two key
 * shapes that share a single chat endpoint:
 *
 * - **`sk-kimi-*` API keys** issued through https://kimi.com/code — sent as
 *   `Authorization: Bearer <key>` against https://api.kimi.com/coding. The
 *   endpoint speaks the Anthropic Messages protocol (so the Anthropic SDK
 *   works out of the box once the base URL is overridden).
 * - **OAuth device-code** flow against https://auth.kimi.com using public
 *   client `17e5f671-d194-4dfb-9706-5516cb48c098`. Yields an access token
 *   (~15 min lifetime) + refresh token (~30 day lifetime). The access token
 *   targets the same chat endpoint with the same protocol.
 *
 * The provider also requires six mandatory `X-Msh-*` headers on every
 * request — without them the backend rejects with 401. The `X-Msh-Device-Id`
 * must be a stable UUID persisted to disk (see {@link getStableDeviceId}).
 *
 * Note: the "legacy" Moonshot OpenAI-compat endpoint at api.moonshot.ai/v1
 * is served by the separate `moonshot` provider profile — Kimi Code is a
 * distinct provider with a different protocol and authentication path.
 *
 * @task T9321
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see packages/core/src/llm/oauth/device-code.ts — Kimi device-code preset
 * @see packages/core/src/llm/stable-device-id.ts — persisted device UUID
 */

import type { ProviderProfile } from '@cleocode/contracts';

import { getStableDeviceId } from '../../stable-device-id.js';

/** Coding endpoint base URL — Anthropic Messages protocol. */
const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding';

/** Default model — Moonshot's coding-tier Kimi K2. */
const DEFAULT_MODEL = 'kimi-k2-coding';

/**
 * Build the six mandatory `X-Msh-*` headers required by the Kimi Code
 * backend. Missing any header triggers 401 errors regardless of credential.
 *
 * `X-Msh-Device-Id` is sourced from {@link getStableDeviceId} which persists
 * a UUIDv4 once at `${CLEO_HOME}/device-id` and reuses it forever — the
 * backend tracks devices and would force re-registration on drift.
 *
 * @returns Header object suitable for spreading into request headers.
 *
 * @task T9321
 */
export function getKimiCodeMshHeaders(): Record<string, string> {
  return {
    'X-Msh-Platform': 'cleo',
    'X-Msh-Version': '1',
    'X-Msh-Device-Name': 'cleo-cli',
    'X-Msh-Device-Model': 'cleo',
    // Track the Node runtime — useful to upstream for compatibility breaks.
    'X-Msh-Os-Version': process.version,
    // Stable per CLEO installation. The backend treats device-id changes as
    // a new device — keep this constant across process restarts.
    'X-Msh-Device-Id': getStableDeviceId(),
  };
}

/**
 * Detect whether an API key is a Kimi Code coding-plan key.
 *
 * Kimi Code issues keys with the `sk-kimi-` prefix. Other keys (e.g. legacy
 * `mk-` Moonshot platform keys) MUST go through the `moonshot` provider,
 * not `kimi-code`.
 *
 * @param apiKey - The credential's API-key string.
 * @returns `true` when the key targets the Kimi Code coding endpoint.
 *
 * @task T9321
 */
export function isKimiCodeApiKey(apiKey: string): boolean {
  return apiKey.startsWith('sk-kimi-');
}

/**
 * Kimi Code provider profile.
 *
 * Speaks the Anthropic Messages protocol against api.kimi.com/coding. The
 * mandatory `X-Msh-*` headers are merged into every request via
 * {@link defaultHeaders}. OAuth bearer tokens issued by the device-code flow
 * are accepted alongside `sk-kimi-` API keys.
 *
 * @task T9321
 * @task T9286 (W1d — added reasoning_effort hook)
 */
export const kimiCodeProfile: ProviderProfile = {
  name: 'kimi-code',
  displayName: 'Kimi Code (Moonshot)',
  authTypes: ['api_key', 'oauth'],
  baseUrl: KIMI_CODE_BASE_URL,
  defaultModel: DEFAULT_MODEL,
  aliases: ['kimi', 'moonshot-coding', 'kimi-coding'],
  // Note: `getKimiCodeMshHeaders()` is invoked once at module load when the
  // profile object is constructed. The device-id is lazy — first call
  // creates the file, subsequent calls reuse the cache. If the profile is
  // ever re-evaluated at runtime the device-id remains stable.
  defaultHeaders: getKimiCodeMshHeaders(),
  envVars: ['KIMI_CODE_API_KEY', 'KIMI_API_KEY'],

  /**
   * Inject `reasoning_effort` for Kimi Code's top-level reasoning control.
   *
   * @invariant kimi-reasoning-effort: Kimi Code requires `reasoning_effort`
   * as a TOP-LEVEL API kwarg (not inside `extra_body`) to enable extended
   * chain-of-thought reasoning. This is distinct from Gemini's thinking_config
   * (which lives inside extra_body) and Moonshot's thinkingBudgetTokens rejection.
   *
   * @returns API kwargs extras with `reasoning_effort: 'high'` set.
   */
  buildApiKwargsExtras(): Readonly<Record<string, unknown>> {
    return { reasoning_effort: 'high' };
  },
};
