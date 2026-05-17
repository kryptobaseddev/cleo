/**
 * Credential pool management endpoint for the Studio `/keys` UI.
 *
 * GET  /api/credentials
 *   → `{ entries: SafeCredentialEntry[] }`
 *
 *   Returns every entry in the unified credential pool with all secret
 *   material stripped (`accessToken`, `refreshToken`, `extraHeaders`,
 *   `metadata` removed). Only the fields a human operator needs to
 *   identify, audit, and remove a credential are exposed — provider,
 *   label, source, authType, expiry, last-status, request count.
 *
 *   This is a deliberate write-only contract: there is NO API path
 *   that returns credential values to a browser. Adding/rotating a
 *   key MUST be done in-place via POST (the client sends the secret
 *   in, never receives one back).
 *
 * POST /api/credentials
 *   body: { provider: ProviderId, label: string, apiKey: string }
 *   → `{ success: true, data: { provider, label } }`
 *
 *   Calls `@cleocode/core/llm/credentials-store#addCredential` with
 *   `authType: 'api_key'` and `source: 'manual'`. The CredentialPool's
 *   60s seed cache is invalidated by the underlying upsert because the
 *   store mutation clears its internal Anthropic-key cache; the next
 *   GET reflects the new entry immediately.
 *
 * SECURITY: this endpoint never returns credential values. Every
 *  `SafeCredentialEntry` projection is constructed by hand so a future
 *  refactor cannot accidentally spread `accessToken` into the response.
 *
 * @task T9426
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-7)
 */

import { getCredentialPool } from '@cleocode/core/llm/credential-pool.js';
import { addCredential } from '@cleocode/core/llm/credentials-store.js';
import { json } from '@sveltejs/kit';
import { err, isParseError, ok, parseJsonBody, requireString } from '../memory/_lafs.js';
import type { RequestHandler } from './$types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Safe projection of `StoredCredential` for HTTP responses.
 *
 * SECURITY: ANY new field added to this interface MUST be one that is
 * safe to disclose to a browser. Do NOT add `accessToken`,
 * `refreshToken`, `extraHeaders`, `metadata`, or any other field that
 * may carry secret material.
 *
 * @task T9426
 */
export interface SafeCredentialEntry {
  /** LLM provider id (e.g. `'anthropic'`, `'openai'`). */
  provider: string;
  /** Human-readable identifier, unique within the provider. */
  label: string;
  /** Seeder source id (`'env'`, `'claude-code'`, `'manual'`, …). */
  source: string;
  /** Storage-level auth scheme. */
  authType: 'api_key' | 'oauth' | 'aws_sdk';
  /** Numeric priority (lower wins in `priorityWithFallback`). */
  priority: number;
  /** Epoch ms; `null` for non-expiring credentials. */
  expiresAt: number | null;
  /** `undefined` when no request has been observed yet. */
  lastStatus?: 'ok' | 'exhausted' | 'invalid';
  /** Last observed HTTP error code (401 / 429 / 500 / …). */
  lastErrorCode?: number;
  /** Epoch ms when the active cooldown expires. */
  lastErrorResetAt?: number;
  /** Cumulative request count for the `least_used` rotation strategy. */
  requestCount?: number;
  /** When true, the picker skips this entry. */
  disabled: boolean;
}

/**
 * GET response envelope.
 *
 * Contains the credential list grouped client-side; the API layer
 * returns a flat array so the same shape powers diagnostic tooling.
 *
 * @task T9426
 */
export interface ListCredentialsData {
  entries: SafeCredentialEntry[];
}

/**
 * POST response envelope.
 *
 * NEVER carries the apiKey value — only the `(provider, label)` pair
 * that was upserted, so the client can locate the new row in the
 * subsequent GET.
 *
 * @task T9426
 */
export interface AddCredentialData {
  provider: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Project a `StoredCredential` into the safe response shape.
 *
 * Implemented as an explicit field-by-field copy (rather than a `{ ...c }`
 * spread minus deletions) so a future contributor adding a new secret
 * field to `StoredCredential` cannot inadvertently leak it through this
 * endpoint.
 *
 * @param c - Stored credential as returned by the pool's `list()`.
 * @returns Safe projection with all secret material removed.
 *
 * @task T9426
 */
function toSafeEntry(c: {
  provider: string;
  label: string;
  source?: string;
  authType: 'api_key' | 'oauth' | 'aws_sdk';
  priority: number;
  expiresAt?: number | null;
  lastStatus?: 'ok' | 'exhausted' | 'invalid';
  lastErrorCode?: number;
  lastErrorResetAt?: number;
  requestCount?: number;
  disabled?: boolean;
}): SafeCredentialEntry {
  const entry: SafeCredentialEntry = {
    provider: c.provider,
    label: c.label,
    source: c.source ?? 'manual',
    authType: c.authType,
    priority: c.priority,
    expiresAt: c.expiresAt ?? null,
    disabled: c.disabled ?? false,
  };
  if (c.lastStatus !== undefined) entry.lastStatus = c.lastStatus;
  if (c.lastErrorCode !== undefined) entry.lastErrorCode = c.lastErrorCode;
  if (c.lastErrorResetAt !== undefined) entry.lastErrorResetAt = c.lastErrorResetAt;
  if (c.requestCount !== undefined) entry.requestCount = c.requestCount;
  return entry;
}

/**
 * Closed list of provider ids accepted by POST.
 *
 * Mirrors `BuiltinProviderId` from `@cleocode/contracts/llm/provider-id`.
 * We do not import the type at runtime because `ProviderId` is open
 * (`BuiltinProviderId | string & Record<never, never>`) — accepting an
 * arbitrary string from the browser would let a caller spam the store
 * with non-routable entries.
 *
 * @task T9426
 */
const ALLOWED_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'gemini',
  'moonshot',
  'openrouter',
  'bedrock',
  'deepseek',
  'xai',
  'groq',
  'kimi-code',
  'ollama',
]);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/credentials — list pool entries (secrets stripped).
 *
 * @task T9426
 */
export const GET: RequestHandler = async () => {
  const pool = getCredentialPool();
  const entries = await pool.list();
  const safe = entries.map(toSafeEntry);
  return json(ok<ListCredentialsData>({ entries: safe }));
};

/**
 * POST /api/credentials — upsert a manual API-key credential.
 *
 * Body: `{ provider, label, apiKey }`. The endpoint validates that
 * `provider` is a recognised builtin, that `label` and `apiKey` are
 * non-empty strings of reasonable length, and that `apiKey` does not
 * leak whitespace. The credential is persisted with `source: 'manual'`
 * and `authType: 'api_key'` so a subsequent `cleo auth remove` knows
 * to dispatch to `MANUAL_REMOVAL_STEP`.
 *
 * @task T9426
 */
export const POST: RequestHandler = async ({ request }) => {
  const body = await parseJsonBody(request);
  if (isParseError(body)) {
    return json(err('E_VALIDATION', body._parseError), { status: 400 });
  }

  const providerR = requireString(body, 'provider', 64);
  if (!providerR.ok) {
    return json(err('E_VALIDATION', providerR.message), { status: 400 });
  }
  const labelR = requireString(body, 'label', 200);
  if (!labelR.ok) {
    return json(err('E_VALIDATION', labelR.message), { status: 400 });
  }
  const apiKeyR = requireString(body, 'apiKey', 4_096);
  if (!apiKeyR.ok) {
    return json(err('E_VALIDATION', apiKeyR.message), { status: 400 });
  }

  const provider = providerR.value.trim();
  if (!ALLOWED_PROVIDERS.has(provider)) {
    return json(
      err('E_VALIDATION', `Unknown provider '${provider}'. Must be a CLEO builtin transport.`),
      { status: 400 },
    );
  }
  const label = labelR.value.trim();
  // The API key is intentionally NOT trimmed beyond rejecting
  // surrounding whitespace — providers may legitimately use keys with
  // internal punctuation, but a leading/trailing space is always a
  // paste artefact and never part of a valid token.
  const apiKey = apiKeyR.value;
  if (apiKey !== apiKey.trim()) {
    return json(err('E_VALIDATION', 'apiKey must not have leading or trailing whitespace'), {
      status: 400,
    });
  }

  try {
    await addCredential({
      // `provider` is narrowed by ALLOWED_PROVIDERS above to one of the
      // closed `BuiltinProviderId` literals. The cast is safe.
      provider: provider as Parameters<typeof addCredential>[0]['provider'],
      label,
      authType: 'api_key',
      accessToken: apiKey,
      source: 'manual',
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json(err('E_WRITE_FAILED', `Failed to persist credential: ${message}`), {
      status: 500,
    });
  }

  return json(ok<AddCredentialData>({ provider, label }));
};
