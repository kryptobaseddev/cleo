/**
 * Codex OAuth Cloudflare headers + endpoint for the OpenAI Responses API.
 *
 * The OpenAI Codex endpoint (`https://chatgpt.com/backend-api/codex`) sits
 * behind a Cloudflare layer that whitelists a small set of first-party
 * originators (`codex_cli_rs`, `codex_vscode`, `codex_sdk_ts`). Requests from
 * non-residential IPs (VPS / server-hosted agents) that do NOT advertise an
 * allowed originator are served a 403 `cf-mitigated: challenge` regardless of
 * auth correctness.
 *
 * This module mirrors hermes-agent's `_codex_cloudflare_headers`
 * (`agent/auxiliary_client.py:444`) so a stored Codex CLI OAuth token can drive
 * a background role through {@link CodexResponsesTransport}:
 *   - pin `originator: codex_cli_rs` (matches the upstream codex-rs CLI),
 *   - set a `codex_cli_rs`-shaped `User-Agent`,
 *   - extract `ChatGPT-Account-ID` (canonical casing) from the OAuth JWT's
 *     `chatgpt_account_id` claim.
 *
 * Malformed tokens are tolerated — the account-ID header is simply dropped so a
 * bad token surfaces as a clean 401 rather than crashing at construction.
 *
 * @module llm/transports/codex-oauth-headers
 * @task T11617
 * @epic E-LLM-PROFILE-MAPPING
 */

/**
 * Canonical OpenAI Codex OAuth endpoint (the ChatGPT backend, NOT
 * `api.openai.com`). OAuth Codex tokens authenticate here; the standard
 * `api.openai.com` endpoint rejects ChatGPT OAuth bearer tokens.
 */
export const CODEX_OAUTH_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/** `User-Agent` shaped to match the upstream codex-rs CLI fingerprint. */
const CODEX_USER_AGENT = 'codex_cli_rs/0.0.0 (CLEO)';

/**
 * Decode the `chatgpt_account_id` claim from a Codex OAuth JWT access token.
 *
 * The claim lives under the `https://api.openai.com/auth` namespace in the
 * JWT payload. Returns `null` for any token that is not a parseable JWT or
 * does not carry the claim — callers MUST treat `null` as "omit the header".
 *
 * @param accessToken - The OAuth access token (JWT).
 * @returns The ChatGPT account id, or `null` when absent/unparseable.
 */
export function extractChatGptAccountId(accessToken: string): string | null {
  if (typeof accessToken !== 'string' || !accessToken.trim()) return null;
  const parts = accessToken.split('.');
  if (parts.length < 2) return null;
  const payloadSegment = parts[1];
  if (!payloadSegment) return null;
  try {
    // base64url → base64 with padding restored.
    const b64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const claims = JSON.parse(json) as Record<string, unknown>;
    const authClaim = claims['https://api.openai.com/auth'];
    if (authClaim && typeof authClaim === 'object' && !Array.isArray(authClaim)) {
      const acctId = (authClaim as Record<string, unknown>)['chatgpt_account_id'];
      if (typeof acctId === 'string' && acctId) return acctId;
    }
  } catch {
    // Malformed token — caller drops the account-ID header and lets the
    // request fail with a clean 401 instead of crashing here.
  }
  return null;
}

/**
 * Build the Cloudflare-bypass header set required to reach the Codex OAuth
 * endpoint with a stored OAuth access token.
 *
 * @param accessToken - The OAuth access token (JWT bearer).
 * @returns Headers to merge into the {@link CodexResponsesTransport} request.
 */
export function buildCodexOAuthHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': CODEX_USER_AGENT,
    originator: 'codex_cli_rs',
  };
  const acctId = extractChatGptAccountId(accessToken);
  if (acctId) headers['ChatGPT-Account-ID'] = acctId;
  return headers;
}
