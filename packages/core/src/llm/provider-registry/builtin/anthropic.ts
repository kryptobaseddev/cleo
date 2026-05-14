/**
 * Builtin provider profile for Anthropic Claude.
 *
 * This is the canonical registry entry for the `anthropic` transport.
 * It is registered automatically at boot by the provider registry and can
 * be overridden by a user plugin at `${CLEO_HOME}/plugins/model-providers/`.
 *
 * @task T9262
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import type { ProviderProfile } from '@cleocode/contracts';

/**
 * Anthropic Claude provider profile.
 *
 * - `authTypes` includes both `api_key` (long-lived `sk-ant-*` keys) and
 *   `oauth` (short-lived `sk-ant-oat-*` bearer tokens from Claude Code).
 * - `defaultHeaders` pins the stable `anthropic-version: 2023-06-01` API
 *   version header required by all Anthropic Messages API requests.
 * - `fetchModels` is omitted — the Anthropic API does not expose a public
 *   `/models` endpoint for arbitrary callers. Callers fall back to the
 *   static model list maintained in `@cleocode/core/llm`.
 */
export const anthropicProfile: ProviderProfile = {
  name: 'anthropic',
  displayName: 'Anthropic Claude',
  authTypes: ['api_key', 'oauth'],
  baseUrl: 'https://api.anthropic.com',
  defaultModel: 'claude-haiku-4-5-20251001',
  aliases: ['claude', 'anthropic-api'],
  defaultHeaders: { 'anthropic-version': '2023-06-01' },
};
