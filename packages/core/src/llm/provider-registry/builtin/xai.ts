/**
 * Builtin provider profile for xAI (Grok models).
 *
 * xAI exposes an OpenAI-compatible API at `https://api.x.ai/v1`. The
 * CLEO-specific quirk is the `x-grok-conv-id` header which pins a
 * process-scoped conversation id for KV-cache affinity.
 *
 * @task T9286 (W1d)
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
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
// ProviderProfile
// ---------------------------------------------------------------------------

/**
 * xAI Grok provider profile.
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
