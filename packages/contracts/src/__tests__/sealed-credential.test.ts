/**
 * Type + purity tests for the E10 sealed credential handle (T11752).
 *
 * Pins the {@link SealedCredential} / {@link DecryptedToken} contract so that:
 *   - `SealedCredential` is exactly `{ provider, account, fetch }` with
 *     `fetch: () => Promise<DecryptedToken>` (AC1).
 *   - `ResolvedLLM` carries a sealed-credential-typed field (AC2).
 *   - `DecryptedToken` is a *branded* string — a plain `string` is NOT
 *     assignable to it, so the secret cannot be silently fabricated and a
 *     `DecryptedToken` cannot leak into an arbitrary `string` sink without an
 *     explicit `.value` read (the "never serialized" invariant, AC2).
 *   - The module is types-only (no runtime export), satisfying contracts
 *     purity (Gate 10 · AC3).
 *
 * @task T11752
 * @epic T11746
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ProviderId } from '../llm/provider-id.js';
import type { DecryptedToken, SealedCredential } from '../llm/sealed-credential.js';
import type { ResolvedLLM } from '../operations/llm.js';

describe('SealedCredential shape (AC1)', () => {
  it('is exactly { provider, account, fetch } — pins the field set', () => {
    expectTypeOf<keyof SealedCredential>().toEqualTypeOf<'provider' | 'account' | 'fetch'>();
  });

  it('provider is a ProviderId', () => {
    expectTypeOf<SealedCredential['provider']>().toEqualTypeOf<ProviderId>();
  });

  it('account is a plain (loggable) string', () => {
    expectTypeOf<SealedCredential['account']>().toEqualTypeOf<string>();
  });

  it('fetch resolves to a DecryptedToken (never a bare string)', () => {
    expectTypeOf<SealedCredential['fetch']>().toEqualTypeOf<() => Promise<DecryptedToken>>();
    expectTypeOf<ReturnType<SealedCredential['fetch']>>().resolves.toEqualTypeOf<DecryptedToken>();
  });

  it('all fields are readonly (a handle cannot be mutated in place)', () => {
    // Removing `readonly` from any field would make this fail to compile.
    expectTypeOf<SealedCredential>().toEqualTypeOf<{
      readonly provider: ProviderId;
      readonly account: string;
      readonly fetch: () => Promise<DecryptedToken>;
    }>();
  });
});

describe('DecryptedToken branding (AC2 — never serialized / never fabricated)', () => {
  it('is NOT assignable from a plain string (nominal brand)', () => {
    // A plain string lacks the phantom `__decryptedToken` brand, so it cannot
    // be passed where a DecryptedToken is required.
    expectTypeOf<string>().not.toMatchTypeOf<DecryptedToken>();
  });

  it('is NOT a plain string sink (must read .value explicitly to serialize)', () => {
    expectTypeOf<DecryptedToken>().not.toEqualTypeOf<string>();
  });

  it('exposes a readonly plaintext .value of type string', () => {
    expectTypeOf<DecryptedToken['value']>().toEqualTypeOf<string>();
  });

  it('carries the phantom brand marker (compile-time only)', () => {
    expectTypeOf<DecryptedToken['__decryptedToken']>().toEqualTypeOf<'DecryptedToken'>();
  });
});

describe('ResolvedLLM.sealedCredential (AC2 · T11753)', () => {
  it('is the required (non-optional) canonical credential surface', () => {
    // T11753 promotes the field from optional to required: the resolver ALWAYS
    // populates it (a handle when a credential resolved, `null` otherwise).
    expectTypeOf<ResolvedLLM['sealedCredential']>().toEqualTypeOf<SealedCredential | null>();
  });

  it('the inline credential metadata carries NO plaintext apiKey (T11753)', () => {
    // The secret-bearing `apiKey` field is structurally removed from the inline
    // credential — the plaintext crosses ONLY through `sealedCredential.fetch()`.
    type Cred = NonNullable<ResolvedLLM['credential']>;
    expectTypeOf<Cred>().not.toHaveProperty('apiKey');
  });
});

describe('contracts purity (AC3) — sealed-credential is types-only', () => {
  it('the module exposes no runtime exports (no decrypt logic in contracts)', async () => {
    const mod = await import('../llm/sealed-credential.js');
    // A pure type module compiles to an empty ESM namespace at runtime.
    expect(Object.keys(mod)).toHaveLength(0);
  });
});
