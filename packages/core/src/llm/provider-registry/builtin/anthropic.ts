/**
 * Builtin provider profile for Anthropic Claude.
 *
 * This is the canonical registry entry for the `anthropic` transport.
 * It is registered automatically at boot by the provider registry and can
 * be overridden by a user plugin at `${CLEO_HOME}/plugins/model-providers/`.
 *
 * @task T9262
 * @task T9302
 * @task T9344
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import type { ProviderProfile } from '@cleocode/contracts';
import type { ProviderOAuthConfig } from '@cleocode/contracts/llm/oauth.js';

/**
 * Canonical public Anthropic OAuth PKCE client ID.
 *
 * This is the same client_id used by Claude Code, Claude Desktop, pi-ai,
 * OpenCode, and Hermes Agent. Anthropic publishes it for first-party CLI
 * OAuth flows — no per-application registration is required.
 *
 * Source: `/mnt/projects/hermes-agent/agent/anthropic_adapter.py:1041`
 * (constant `_OAUTH_CLIENT_ID`).
 *
 * Override at runtime via `CLEO_ANTHROPIC_OAUTH_CLIENT_ID` env var if you
 * need to test with your own registered OAuth application.
 */
export const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/**
 * Resolve the Anthropic OAuth client ID.
 *
 * Prefers `CLEO_ANTHROPIC_OAUTH_CLIENT_ID` env var; falls back to the
 * canonical public client_id. No warning is emitted in the fallback path —
 * the public client_id is the production-correct default.
 */
function resolveAnthropicClientId(): string {
  return process.env['CLEO_ANTHROPIC_OAUTH_CLIENT_ID'] ?? ANTHROPIC_OAUTH_CLIENT_ID;
}

/**
 * Anthropic OAuth PKCE configuration.
 *
 * Anthropic uses RFC 7636 PKCE (not device-code). Endpoints and redirect
 * URI mirror the Hermes Agent reference implementation
 * (`agent/anthropic_adapter.py` `_OAUTH_*` constants):
 *   - authorizationEndpoint: https://claude.ai/oauth/authorize
 *   - tokenEndpoint:         https://console.anthropic.com/v1/oauth/token
 *   - redirectUri:           https://console.anthropic.com/oauth/code/callback
 *
 * The Anthropic-hosted redirect URI displays the authorization code on the
 * post-redirect page so the user can paste it back into the CLI prompt
 * (the same headless paste-back flow Hermes and Claude Code use). No local
 * HTTP listener is required.
 *
 * @task T9302
 * @task T9344
 */
const ANTHROPIC_OAUTH: ProviderOAuthConfig = {
  mode: 'pkce',
  clientId: resolveAnthropicClientId(),
  authorizationEndpoint: 'https://claude.ai/oauth/authorize',
  tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
  scope: 'org:create_api_key user:profile user:inference',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
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
