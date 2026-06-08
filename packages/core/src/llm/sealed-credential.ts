/**
 * Sealed credential handle — runtime implementation (E10 · T11753).
 *
 * The {@link SealedCredential} **type** lives in `@cleocode/contracts`
 * (`llm/sealed-credential.ts`, types-only for Gate 10 purity). Its `fetch()` is
 * a function-TYPED interface field; the concrete body — the on-demand
 * materialization of the plaintext token — lives HERE in `@cleocode/core`.
 *
 * ## Why this module exists
 *
 * Before E10, {@link import('./role-resolver.js').resolveLLMForRole} returned
 * the resolved credential's plaintext `apiKey` **inline** on its envelope. That
 * bare secret string travelled up the entire resolution call stack
 * (`resolveLLMForRole` → `resolveLLMForSystem` → consumers) where any layer that
 * merely *routed* it to the wire could accidentally log it, serialize it into a
 * LAFS envelope, or copy it into a diagnostic.
 *
 * {@link makeSealedCredential} inverts that. The resolver builds an opaque
 * {@link SealedCredential} handle whose `fetch()` closure captures a
 * `resolveToken` thunk. The plaintext is materialized **only** when a wire
 * boundary (`transportForProvider` / `session-factory.ts`) or daemon
 * worker-injection invokes `fetch()`. Between the resolver and those boundaries,
 * NO layer holds a plaintext secret — it holds a handle.
 *
 * ## The brand chokepoint
 *
 * {@link brandDecryptedToken} is the SOLE place a {@link DecryptedToken} is
 * minted from a raw string. Because `DecryptedToken` is a phantom-branded type
 * (contracts), a plain `string` cannot be widened into one anywhere else — so an
 * audit of "who mints a token" reduces to "who calls `brandDecryptedToken`",
 * and that is exclusively this module (invoked inside `fetch()`).
 *
 * @module llm/sealed-credential
 * @task T11753
 * @epic T11746
 * @see ADR-072 §Type lock-in
 */

import type { DecryptedToken, ProviderId, SealedCredential } from '@cleocode/contracts';

/**
 * Build the non-secret, redacted preview of a credential string.
 *
 * SECURITY: this is the SOLE token→preview redaction chokepoint for the sealed
 * handle. It reveals at most the last 4 characters of the token plus an
 * auth-scheme marker (`oat-…` for OAuth, `…` otherwise) — never enough to
 * reconstruct the secret. It is computed ONCE at seal time and stored on the
 * handle's {@link SealedCredential.tokenPreview}; the full plaintext is NOT
 * retained for it.
 *
 * The preview is the ONLY credential-derived string that may cross a
 * logging/diagnostic/envelope boundary (E10 · T11754 · AC3); everything else
 * goes through {@link SealedCredential.fetch} at the wire and is discarded.
 *
 * @param token - The plaintext secret (read transiently; not retained).
 * @param authType - Auth scheme, used only to pick the cosmetic prefix.
 * @returns A redacted preview safe to log and serialize.
 * @task T11754
 */
export function tokenPreview(token: string, authType: 'api_key' | 'oauth'): string {
  const prefix = authType === 'oauth' ? 'oat-…' : '…';
  if (!token) return prefix;
  if (token.length <= 4) return `${prefix}${token}`;
  return `${prefix}${token.slice(-4)}`;
}

/**
 * Mint a {@link DecryptedToken} from a raw plaintext secret.
 *
 * SECURITY: this is the ONE chokepoint that produces a branded
 * {@link DecryptedToken}. It MUST be called only from inside a
 * {@link SealedCredential.fetch} closure (see {@link makeSealedCredential}) —
 * i.e. at the wire / daemon worker-injection boundary — never to surface a
 * plaintext up the resolver stack.
 *
 * The brand is phantom (compile-time only); at runtime this returns a frozen
 * object `{ value }`. The `__decryptedToken` marker is never materialized at
 * runtime — the cast below is the deliberate, single, audited point where a
 * `string` becomes a `DecryptedToken`.
 *
 * @param value - The materialized plaintext secret (API key / OAuth bearer).
 * @returns The branded token, valid only for immediate wire/daemon use.
 * @internal
 */
function brandDecryptedToken(value: string): DecryptedToken {
  // The single, audited string→DecryptedToken mint. `Object.freeze` prevents a
  // consumer from mutating `value` in place after fetch().
  return Object.freeze({ value }) as DecryptedToken;
}

/**
 * Parameters for {@link makeSealedCredential}.
 *
 * @task T11753
 */
export interface MakeSealedCredentialParams {
  /** Provider this handle targets (e.g. `'anthropic'`). */
  readonly provider: ProviderId;
  /**
   * Account / store-label this handle resolves against (e.g. `'default'`,
   * `'work'`). Names *which* credential without revealing its secret — safe to
   * log and serialize.
   */
  readonly account: string;
  /**
   * Non-secret redacted preview (e.g. `'…6789'` / `'oat-…6789'`) computed once
   * by the resolver via {@link tokenPreview}. Carried on the handle so
   * diagnostics can *name* the credential without invoking {@link SealedCredential.fetch}.
   * NEVER the full token.
   *
   * @task T11754
   */
  readonly tokenPreview: string;
  /**
   * On-demand plaintext resolver. Invoked ONLY inside {@link SealedCredential.fetch}
   * — i.e. at the wire / daemon worker-injection boundary. May be synchronous
   * (today's in-process credential pool, which already holds the plaintext) or
   * asynchronous (a future vault / daemon round-trip per T11754). Returns the
   * raw plaintext string; {@link makeSealedCredential} brands it.
   *
   * MUST throw if the credential is unreachable so the caller's existing
   * graceful-degradation path fires identically to the pre-E10 `apiKey === null`
   * check.
   */
  readonly resolveToken: () => string | Promise<string>;
}

/**
 * Build a {@link SealedCredential} handle from a provider/account and an
 * on-demand token resolver.
 *
 * The returned handle carries ONLY the non-secret `provider` + `account`
 * inline. Its `fetch()` closure captures {@link MakeSealedCredentialParams.resolveToken}
 * and brands the result — the plaintext exists transiently inside `fetch()` and
 * is NEVER attached to the handle object, so the handle can be logged or
 * serialized without leaking the secret.
 *
 * @example
 * ```ts
 * // In the resolver — capture the already-resolved token in the closure but do
 * // NOT place it on the returned envelope:
 * const sealed = makeSealedCredential({
 *   provider: 'anthropic',
 *   account: usedLabel ?? 'default',
 *   tokenPreview: tokenPreview(token, authType), // non-secret; safe to log
 *   resolveToken: () => token, // captured, not surfaced
 * });
 * // At the wire — the ONLY place fetch() runs (via authHeadersFromSealed):
 * const headers = await authHeadersFromSealed(sealed, authType);
 * // the plaintext never escapes authHeadersFromSealed; only headers come out.
 * ```
 *
 * @param params - Provider, account label, and the on-demand token resolver.
 * @returns An opaque sealed-credential handle.
 * @task T11753
 */
export function makeSealedCredential(params: MakeSealedCredentialParams): SealedCredential {
  const { provider, account, tokenPreview: preview, resolveToken } = params;
  return {
    provider,
    account,
    tokenPreview: preview,
    fetch: async (): Promise<DecryptedToken> => {
      // The SOLE decrypt/materialize point. `resolveToken` re-obtains (or, in
      // T11754, decrypts) the plaintext on demand; we brand it and hand it to
      // the wire. The plaintext never escapes this closure except as the
      // branded return value the caller is contractually bound to discard.
      const plaintext = await resolveToken();
      return brandDecryptedToken(plaintext);
    },
  };
}
