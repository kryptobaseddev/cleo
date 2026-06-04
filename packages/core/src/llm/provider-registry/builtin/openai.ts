/**
 * Builtin provider profile for OpenAI / Codex (ChatGPT backend).
 *
 * Registers the `openai` transport (aliases `codex`, `chatgpt`, `openai-codex`)
 * with BOTH auth paths:
 *   - `api_key` — standard `sk-...` keys against `https://api.openai.com/v1`.
 *   - `oauth`   — RFC 7636 PKCE login (`cleo llm login openai` / `... codex`)
 *     that authenticates a ChatGPT (Plus/Pro/Team) account against the Codex
 *     backend. OAuth tokens do NOT work against `api.openai.com`; the runtime
 *     routes them to `https://chatgpt.com/backend-api/codex` via
 *     {@link CodexResponsesTransport} + {@link buildCodexOAuthHeaders}.
 *
 * PKCE constants are the upstream codex-rs CLI's published first-party values,
 * cross-verified against three independent clients (opencode, openclaw,
 * hermes-agent) and the official `openai/codex` source — no per-app
 * registration required. Override the client id with
 * `CLEO_OPENAI_OAUTH_CLIENT_ID` for a custom OAuth application.
 *
 * @task T11669
 * @epic SG-PROVIDER-AUTH-UNIFICATION (E4-CODEX-PKCE-LOGIN)
 */

import type { ProviderProfile } from '@cleocode/contracts';
import type { ProviderOAuthConfig } from '@cleocode/contracts/llm/oauth.js';

/**
 * Canonical OpenAI/Codex OAuth PKCE client id (the codex-rs CLI first-party
 * client). Override via `CLEO_OPENAI_OAUTH_CLIENT_ID`.
 */
export const OPENAI_CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Resolve the OpenAI OAuth client id (env override → canonical default). */
function resolveOpenaiClientId(): string {
  return process.env['CLEO_OPENAI_OAUTH_CLIENT_ID'] ?? OPENAI_CODEX_OAUTH_CLIENT_ID;
}

/**
 * OpenAI/Codex OAuth PKCE configuration.
 *
 * Single issuer host (`auth.openai.com`) for both authorize + token, a FIXED
 * loopback redirect on port 1455 (the codex-rs CLI's pre-registered callback —
 * the login flow binds its local server to this exact port), and the three
 * non-RFC authorize params the Codex simplified flow requires.
 */
const OPENAI_CODEX_OAUTH: ProviderOAuthConfig = {
  mode: 'pkce',
  clientId: resolveOpenaiClientId(),
  authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  scope: 'openid profile email offline_access',
  redirectUri: 'http://localhost:1455/auth/callback',
  extraAuthParams: {
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
  },
};

/**
 * OpenAI / Codex provider profile.
 *
 * `defaultModel` is a static FALLBACK used when no live catalog snapshot is
 * available (i.e. before `cleo llm refresh-catalog` has been run). At runtime,
 * `cleo llm use openai` / `cleo llm profile <role> openai` derive the default
 * from the live catalog via `resolveProviderDefaultModel` and validate any
 * explicit `--model` against `validateModelForProvider` (T11773 · E8).
 *
 * Override per-credential:
 *   `cleo llm use openai --model <m>`
 *   `cleo llm profile <role> openai --model <m>`
 *
 * @task T11773
 */
export const openaiProfile: ProviderProfile = {
  name: 'openai',
  displayName: 'OpenAI Codex (ChatGPT)',
  authTypes: ['api_key', 'oauth'],
  baseUrl: 'https://api.openai.com/v1',
  // Static fallback — catalog-driven resolver replaces this at runtime when a
  // disk snapshot is available (T11773 · E8). Updated from stale 'gpt-5-codex'
  // to the confirmed latest OpenAI model (catalog release_date 2026-04-23).
  defaultModel: 'gpt-5.5',
  aliases: ['codex', 'chatgpt', 'openai-codex'],
  oauth: OPENAI_CODEX_OAUTH,
};
