/**
 * Builtin provider profiles for xAI (Grok models).
 *
 * xAI exposes an OpenAI-compatible API at `https://api.x.ai/v1`. Two
 * profiles are registered — one per ApiMode:
 *
 * - {@link xaiProfile}: `chat_completions` — standard OpenAI-compatible path.
 *   Quirk: `x-grok-conv-id` header for KV-cache affinity.
 * - {@link xaiResponsesProfile}: `codex_responses` — xAI's Responses-compatible
 *   endpoint (grok-* models). Selected automatically when the model id starts
 *   with `grok-` and the caller requests `codex_responses` ApiMode.
 *
 * @task T9286 (W1d)
 * @task T9311 (xAI Responses profile)
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3/5)
 */

import type { ProviderProfile } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Process-scoped conversation id (module-private)
// ---------------------------------------------------------------------------

/** Lazily-initialized process-scoped Grok conversation id. */
let _grokConvId: string | null = null;

/**
 * Return (and lazily create) the process-scoped Grok conversation id.
 *
 * Pinning a stable `x-grok-conv-id` across requests in the same process
 * gives xAI's KV-cache layer a consistent cache key, reducing TTFT on
 * repeated system-prompt prefix calls within the same agent session.
 *
 * The id is intentionally not persisted — it resets each process restart so
 * stale cache entries do not accumulate across sessions.
 *
 * @returns Stable `cleo-<timestamp>-<random>` identifier for this process.
 */
export function getGrokConvId(): string {
  if (_grokConvId === null) {
    _grokConvId = `cleo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return _grokConvId;
}

// ---------------------------------------------------------------------------
// chat_completions profile
// ---------------------------------------------------------------------------

/**
 * xAI Grok provider profile — `chat_completions` ApiMode.
 *
 * Encodes the Grok conversation-id header as a `buildApiKwargsExtras` hook.
 *
 * @task T9286 (W1d)
 */
export const xaiProfile: ProviderProfile = {
  name: 'xai',
  displayName: 'xAI Grok',
  authTypes: ['api_key'],
  baseUrl: 'https://api.x.ai/v1',
  defaultModel: 'grok-3',
  aliases: ['grok', 'x-ai'],
  envVars: ['XAI_API_KEY'],

  /**
   * Inject the process-scoped Grok conversation id header.
   *
   * @invariant xai-grok-conv-id: xAI's KV-cache requires a stable
   * `x-grok-conv-id` header per process to achieve cache hits on repeated
   * system-prompt prefixes. The id is process-scoped (not persisted) to
   * prevent stale cache accumulation across sessions.
   *
   * @returns API kwargs extras with `extra_headers['x-grok-conv-id']` set.
   */
  buildApiKwargsExtras(): Readonly<Record<string, unknown>> {
    return {
      extra_headers: { 'x-grok-conv-id': getGrokConvId() },
    };
  },
};

// ---------------------------------------------------------------------------
// codex_responses profile
// ---------------------------------------------------------------------------

/**
 * xAI Grok provider profile — `codex_responses` ApiMode.
 *
 * xAI exposes Responses-compatible endpoints for grok-* models. Select this
 * profile when the caller requests `codex_responses` ApiMode or when the
 * model id starts with `grok-` and the Responses API is preferred.
 *
 * Callers should construct a {@link CodexResponsesTransport} (from
 * `packages/core/src/llm/transports/codex-responses.ts`) with this profile's
 * `baseUrl` and any `x-grok-conv-id` header from `buildApiKwargsExtras`.
 *
 * @task T9311
 */
export const xaiResponsesProfile: ProviderProfile = {
  name: 'xai',
  displayName: 'xAI Grok (Responses)',
  authTypes: ['api_key'],
  baseUrl: 'https://api.x.ai/v1',
  defaultModel: 'grok-3',
  aliases: ['grok-responses', 'x-ai-responses'],
  envVars: ['XAI_API_KEY'],

  /**
   * Inject the process-scoped Grok conversation id as a default header.
   *
   * When used with {@link CodexResponsesTransport}, this header is passed
   * through `defaultHeaders` at construction time rather than per-request
   * `extra_headers` (the Responses API does not have an `extra_headers` kwarg).
   *
   * @returns API kwargs extras with `extra_headers['x-grok-conv-id']` set.
   */
  buildApiKwargsExtras(): Readonly<Record<string, unknown>> {
    return {
      extra_headers: { 'x-grok-conv-id': getGrokConvId() },
    };
  },
};
