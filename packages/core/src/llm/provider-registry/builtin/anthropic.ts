/**
 * Builtin provider profile for Anthropic Claude.
 *
 * This is the canonical registry entry for the `anthropic` transport.
 * It is registered automatically at boot by the provider registry and can
 * be overridden by a user plugin at `${CLEO_HOME}/plugins/model-providers/`.
 *
 * @task T9262
 * @task T9302
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import type { ProviderProfile } from '@cleocode/contracts';
import type { ProviderOAuthConfig } from '@cleocode/contracts/llm/oauth.js';

/**
 * Placeholder Anthropic OAuth client ID sourced from the Hermes reference
 * implementation (`hermes_cli/auth_commands.py`).
 *
 * This is NOT an officially published Anthropic client ID. CLEO must register
 * its own OAuth application before end-to-end PKCE login can work against real
 * Anthropic OAuth endpoints. See T9341 for the owner-action registration step.
 *
 * Override at runtime via `CLEO_ANTHROPIC_OAUTH_CLIENT_ID` env var once a real
 * client ID is obtained — no code change required.
 *
 * @see T9341 — owner-action: register CLEO as an Anthropic OAuth application
 */
export const ANTHROPIC_OAUTH_CLIENT_ID_PLACEHOLDER = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/**
 * Resolve the Anthropic OAuth client ID.
 *
 * Prefers `CLEO_ANTHROPIC_OAUTH_CLIENT_ID` env var; falls back to the
 * placeholder and emits a one-time stderr warning so operators know the
 * placeholder is in use.
 */
function resolveAnthropicClientId(): string {
  const envId = process.env['CLEO_ANTHROPIC_OAUTH_CLIENT_ID'];
  if (envId) return envId;
  process.stderr.write(
    '[anthropic-oauth] Using placeholder client_id; set CLEO_ANTHROPIC_OAUTH_CLIENT_ID to your registered ID. See T9341.\n',
  );
  return ANTHROPIC_OAUTH_CLIENT_ID_PLACEHOLDER;
}

/**
 * Anthropic OAuth PKCE configuration.
 *
 * Anthropic uses RFC 7636 PKCE (not device-code). The client ID is resolved
 * from `CLEO_ANTHROPIC_OAUTH_CLIENT_ID` env var at runtime, falling back to
 * the Hermes-sourced placeholder when the env var is absent.
 *
 * Endpoints sourced from the Hermes `anthropic_adapter.py` PKCE flow:
 *   - authorizationEndpoint: https://claude.ai/oauth/authorize
 *   - tokenEndpoint:         https://console.anthropic.com/v1/oauth/token
 *
 * @task T9302
 * @see T9341 — register CLEO as an Anthropic OAuth application (owner action)
 */
const ANTHROPIC_OAUTH: ProviderOAuthConfig = {
  mode: 'pkce',
  clientId: resolveAnthropicClientId(),
  authorizationEndpoint: 'https://claude.ai/oauth/authorize',
  tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
  scope: 'org:create_api_key user:profile user:inference',
  // CLI callback: local HTTP server on random port catches the redirect.
  // Headless mode: print URL; user pastes the full redirect URL back.
  redirectUri: 'http://localhost',
};

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
 * - `oauth` configures the RFC 7636 PKCE flow used by `cleo llm login anthropic`.
 */
export const anthropicProfile: ProviderProfile = {
  name: 'anthropic',
  displayName: 'Anthropic Claude',
  authTypes: ['api_key', 'oauth'],
  baseUrl: 'https://api.anthropic.com',
  defaultModel: 'claude-haiku-4-5-20251001',
  aliases: ['claude', 'anthropic-api'],
  defaultHeaders: { 'anthropic-version': '2023-06-01' },
  oauth: ANTHROPIC_OAUTH,
};
