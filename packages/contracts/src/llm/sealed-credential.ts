/**
 * Sealed credential handle — the E10 on-demand-decrypt contract (T11752).
 *
 * ## Why a sealed handle exists
 *
 * Until E10, a resolved credential carried the secret **inline** as a bare
 * `apiKey: string` field on `CredentialResultWire` / `ResolvedLLM`. That
 * plaintext token traveled up the entire resolution call stack — through
 * `resolveLLMForRole` → `resolveLLMForSystem` → consumers — where it could be
 * accidentally logged, serialized into a LAFS envelope, or copied into a
 * diagnostic. Every layer that merely *routed* the credential to the wire still
 * had structural read access to the plaintext.
 *
 * A {@link SealedCredential} inverts that. The resolver returns an **opaque
 * handle** that names the credential (`provider` + `account`) and exposes a
 * single asynchronous {@link SealedCredential.fetch} method. The plaintext token
 * is materialized ONLY when `fetch()` is invoked — and by E10 design that call
 * happens at exactly two trust boundaries:
 *
 *  1. the wire — `transportForProvider` / `session-factory.ts` immediately
 *     before building the provider transport / auth headers, or
 *  2. daemon worker-injection — the daemon brokering a short-lived credential
 *     into a spawned agent.
 *
 * Between the resolver and those boundaries, NO layer holds a plaintext secret;
 * it holds a handle whose `fetch()` is the sole decryption chokepoint.
 *
 * ## Types-only (Gate 10 contracts purity)
 *
 * This module is **types-only**. {@link SealedCredential.fetch} is a
 * *function-typed field* on an interface — a declaration of shape, NOT a bodied
 * runtime function — so it satisfies the contracts-purity gate
 * (`lint-no-runtime-in-contracts`). The concrete implementation of `fetch()`
 * (the actual `crypto/credentials.ts` decrypt + the vault/daemon round-trip)
 * lives in `@cleocode/core` — never in contracts.
 *
 * @module llm/sealed-credential
 * @task T11752
 * @epic T11746
 * @see ADR-072 §Type lock-in
 */

import type { ProviderId } from './provider-id.js';

/**
 * The plaintext secret materialized by {@link SealedCredential.fetch}.
 *
 * ## Branded so it cannot be silently created or widened
 *
 * `DecryptedToken` is a *branded* string: an opaque nominal type produced ONLY
 * by the core decrypt chokepoint inside {@link SealedCredential.fetch}. The
 * `readonly __decryptedToken` brand is a phantom marker — it is NEVER assigned a
 * runtime value (there is no runtime field; this is purely a compile-time
 * nominal tag), so a plain `string` cannot be passed where a `DecryptedToken`
 * is expected, and a `DecryptedToken` is not assignable to an arbitrary
 * `string` sink without an explicit, auditable read of `.value`.
 *
 * ## NEVER serialized
 *
 * A `DecryptedToken` MUST NEVER be:
 *   - returned up the resolver call stack (it exists only transiently inside
 *     the `fetch()` consumer at the wire / daemon worker-injection boundary),
 *   - placed on any envelope, `NormalizedResponse.providerData`, log line,
 *     diagnostic, or `cleo llm whoami` output,
 *   - persisted, cached across calls, or held beyond the single transport
 *     construction / auth-header build that consumed it.
 *
 * The CI chokepoint lint (`lint-llm-chokepoint`) plus the E10 redaction tests
 * (T11754) enforce that no bare secret string crosses the resolver boundary.
 *
 * Because the brand is phantom (compile-time only) and there is no enumerable
 * runtime field, `JSON.stringify(token)` over the value field yields only the
 * underlying string — which is precisely why callers MUST treat the value as
 * write-once-to-the-wire and never route it into a serializer.
 *
 * @task T11752
 */
export type DecryptedToken = {
  /**
   * Phantom brand marker — compile-time only, never materialized at runtime.
   * Prevents a plain `string` from being assigned where a {@link DecryptedToken}
   * is required (nominal typing). Reading this field is meaningless at runtime;
   * it exists solely to make the type opaque.
   *
   * @internal
   */
  readonly __decryptedToken: 'DecryptedToken';
  /**
   * The materialized plaintext secret (API key or OAuth bearer token).
   *
   * SECURITY: read this ONLY at the wire (`transportForProvider`) or daemon
   * worker-injection, build the auth header, and discard. NEVER log, serialize,
   * or return it up the stack. Marked `readonly` so a consumer cannot mutate it
   * in place.
   */
  readonly value: string;
};

/**
 * An opaque, sealed reference to a credential whose plaintext is fetched on
 * demand at the wire — never carried inline up the resolver stack.
 *
 * The resolver returns this *instead of* a bare `apiKey: string` (E10 ·
 * T11753). Consumers route the handle to the transport boundary unchanged;
 * only the boundary calls {@link fetch} to materialize the
 * {@link DecryptedToken}, build the provider auth headers, and discard the
 * plaintext.
 *
 * @example
 * ```ts
 * // At the wire boundary (session-factory.ts) — the ONLY place fetch() runs.
 * // Prefer `authHeadersFromSealed` (core), which invokes fetch() internally so
 * // the plaintext is never bound to a caller-visible variable:
 * const headers = await authHeadersFromSealed(sealed, authType);
 * // …or, for diagnostics, name the credential WITHOUT materializing it:
 * log.info({ provider: sealed.provider, preview: sealed.tokenPreview });
 * // The full token is NEVER returned, logged, or serialized.
 * ```
 *
 * @task T11752
 */
export interface SealedCredential {
  /** Provider this credential targets (e.g. `'anthropic'`, `'openai'`). */
  readonly provider: ProviderId;
  /**
   * Account / store-label identifier this handle resolves against (e.g.
   * `'default'`, `'work'`). Names *which* credential the handle points at
   * without revealing its secret — safe to log and serialize.
   */
  readonly account: string;
  /**
   * Non-secret, redacted preview of the underlying credential (e.g. `'…6789'`
   * or `'oat-…6789'` for OAuth). The SOLE token-derived value safe to place on
   * a log line, LAFS envelope, or `cleo llm whoami` diagnostic.
   *
   * SECURITY: this is computed ONCE at seal time from at most the last 4 token
   * characters via the core redaction chokepoint (`tokenPreviewOf`) — it can
   * never be reversed into the plaintext. Diagnostics that need to *name* a
   * credential without materializing it MUST read this field, never call
   * {@link fetch}. The E10 redaction test (T11754 · AC3) asserts that the
   * preview, not the full token, is the only credential-derived string that
   * crosses any logging/diagnostic boundary.
   *
   * @task T11754
   */
  readonly tokenPreview: string;
  /**
   * Materialize the plaintext secret on demand.
   *
   * SECURITY INVARIANT: the returned {@link DecryptedToken} is the ONLY point
   * at which the secret exists in plaintext. Implementations (in
   * `@cleocode/core`) run the `crypto/credentials.ts` decrypt INSIDE this
   * method and MUST be invoked ONLY at the wire (`transportForProvider` /
   * `session-factory.ts`) or daemon worker-injection — never to surface a key
   * up the resolution stack. The result MUST NOT be cached, persisted, logged,
   * or serialized by any caller.
   *
   * This is a *function-typed field on an interface* (a type, not a bodied
   * function), so the declaration is contracts-purity-safe (Gate 10): the body
   * lives in core.
   *
   * @returns The materialized plaintext token, valid only for immediate
   *   wire/daemon use.
   */
  readonly fetch: () => Promise<DecryptedToken>;
}
