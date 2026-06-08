/**
 * E10 decrypt-at-wire + redaction tests (T11754 — AC1 · AC2 · AC3).
 *
 * The security invariant this file enforces:
 *
 *  - **AC1 — decrypt-only-at-wire.** The crypto decrypt (`resolveToken`) runs
 *    ONLY inside the sealed handle's `fetch()`, which is invoked ONLY at a wire
 *    boundary (`authHeadersFromSealed` / `transportForProvider` /
 *    daemon worker-injection). We prove this by counting how many times the
 *    `resolveToken` thunk fires: zero until a wire helper is called.
 *  - **AC2 — auth headers built AT THE WIRE from the handle.**
 *    `authHeadersFromSealed(sealed, authType)` materializes the token inside
 *    itself and returns ONLY the provider-specific headers — `x-api-key` for an
 *    Anthropic API key, `Authorization: Bearer …` for OAuth and for
 *    openai/gemini/moonshot API keys — without the plaintext ever being bound to
 *    a caller variable.
 *  - **AC3 — redaction.** The plaintext token appears in NO log line, envelope,
 *    or diagnostic surface. The ONLY token-derived string a diagnostic may carry
 *    is the non-secret {@link makeSealedCredential} `tokenPreview` (≤ last 4
 *    chars). A deep walk + JSON dump of the handle and of a simulated diagnostic
 *    record finds the full secret nowhere.
 *
 * @task T11754
 * @epic T11746
 */

import { describe, expect, it } from 'vitest';
import { authHeadersFromSealed } from '../credentials.js';
import { makeSealedCredential, tokenPreview } from '../sealed-credential.js';

const SECRET = 'sk-ant-SECRET-decrypt-at-wire-do-not-leak-9876543210';

/**
 * Recursively collect every primitive string reachable from `value`, descending
 * into plain objects + arrays but NOT into functions (the fetch closure is the
 * intended, opaque secret home).
 */
function reachableStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) out.push(...reachableStrings(item, seen));
    return out;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    out.push(...reachableStrings(v, seen));
  }
  return out;
}

describe('AC1 — decrypt (resolveToken) runs ONLY inside fetch(), at the wire (T11754)', () => {
  it('the resolveToken thunk does NOT fire when the handle is built — only on fetch()', async () => {
    let decryptCalls = 0;
    const sealed = makeSealedCredential({
      provider: 'anthropic',
      account: 'default',
      tokenPreview: tokenPreview(SECRET, 'api_key'),
      resolveToken: () => {
        decryptCalls += 1;
        return SECRET;
      },
    });
    // Building the handle, reading its non-secret fields, and serializing it must
    // NOT decrypt.
    expect(sealed.provider).toBe('anthropic');
    expect(sealed.tokenPreview).toBe('…3210');
    JSON.stringify({ provider: sealed.provider, preview: sealed.tokenPreview });
    expect(decryptCalls).toBe(0);

    // Only the wire helper triggers the single decrypt.
    await authHeadersFromSealed(sealed, 'api_key');
    expect(decryptCalls).toBe(1);
  });

  it('a wire helper that bypasses fetch() never sees the plaintext (aws_sdk short-circuits)', async () => {
    let decryptCalls = 0;
    const sealed = makeSealedCredential({
      provider: 'bedrock',
      account: 'default',
      tokenPreview: tokenPreview('', 'api_key'),
      resolveToken: () => {
        decryptCalls += 1;
        return '';
      },
    });
    // aws_sdk owns auth out-of-band — authHeadersFromSealed must NOT call fetch().
    const headers = await authHeadersFromSealed(sealed, 'aws_sdk');
    expect(headers).toEqual({});
    expect(decryptCalls).toBe(0);
  });
});

describe('AC2 — auth headers built AT THE WIRE from the handle (apiKey vs Bearer) (T11754)', () => {
  it('anthropic api_key → x-api-key header (NOT Bearer)', async () => {
    const sealed = makeSealedCredential({
      provider: 'anthropic',
      account: 'default',
      tokenPreview: tokenPreview(SECRET, 'api_key'),
      resolveToken: () => SECRET,
    });
    const headers = await authHeadersFromSealed(sealed, 'api_key');
    expect(headers['x-api-key']).toBe(SECRET);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.Authorization).toBeUndefined();
  });

  it('anthropic oauth → Authorization: Bearer + oauth beta header', async () => {
    const sealed = makeSealedCredential({
      provider: 'anthropic',
      account: 'work',
      tokenPreview: tokenPreview(SECRET, 'oauth'),
      resolveToken: () => SECRET,
    });
    const headers = await authHeadersFromSealed(sealed, 'oauth');
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('openai api_key → Authorization: Bearer (Bearer scheme, NOT x-api-key)', async () => {
    const sealed = makeSealedCredential({
      provider: 'openai',
      account: 'default',
      tokenPreview: tokenPreview(SECRET, 'api_key'),
      resolveToken: () => SECRET,
    });
    const headers = await authHeadersFromSealed(sealed, 'api_key');
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('the helper returns ONLY headers — the plaintext is bound to no caller variable', async () => {
    const sealed = makeSealedCredential({
      provider: 'anthropic',
      account: 'default',
      tokenPreview: tokenPreview(SECRET, 'api_key'),
      resolveToken: () => SECRET,
    });
    const result = await authHeadersFromSealed(sealed, 'api_key');
    // The plaintext appears ONLY inside the header value the wire will send —
    // there is no separate `token` binding in the caller frame.
    expect(Object.keys(result)).toEqual(expect.arrayContaining(['x-api-key']));
    // Sanity: the only place SECRET appears is the header value.
    const hits = reachableStrings(result).filter((s) => s.includes(SECRET));
    expect(hits).toEqual([SECRET]);
  });
});

describe('AC3 — redaction: the token never crosses a log/envelope/diagnostic (T11754)', () => {
  it('the handle exposes a non-secret tokenPreview, NEVER the full token', () => {
    const sealed = makeSealedCredential({
      provider: 'anthropic',
      account: 'default',
      tokenPreview: tokenPreview(SECRET, 'api_key'),
      resolveToken: () => SECRET,
    });
    // The preview is short, last-4 only, and is NOT the secret.
    expect(sealed.tokenPreview).toBe('…3210');
    expect(sealed.tokenPreview).not.toContain(SECRET);
    expect(sealed.tokenPreview.length).toBeLessThanOrEqual('oat-…0000'.length);

    // A structural walk / JSON dump of the handle never reveals the plaintext —
    // it lives only in the fetch() closure.
    expect(reachableStrings(sealed)).not.toContain(SECRET);
    expect(JSON.stringify(sealed)).not.toContain(SECRET);
    // …but the redacted preview IS reachable (and safe).
    expect(reachableStrings(sealed)).toContain('…3210');
  });

  it('a simulated diagnostic record built from the handle carries the preview, not the secret', () => {
    const sealed = makeSealedCredential({
      provider: 'anthropic',
      account: 'work',
      tokenPreview: tokenPreview(SECRET, 'oauth'),
      resolveToken: () => SECRET,
    });
    // The shape a `cleo llm whoami` / log line would emit: NEVER calls fetch().
    const diagnostic = {
      provider: sealed.provider,
      account: sealed.account,
      tokenPreview: sealed.tokenPreview,
      hasCredential: true,
    };
    expect(JSON.stringify(diagnostic)).not.toContain(SECRET);
    expect(diagnostic.tokenPreview).toBe('oat-…3210');
  });

  it('tokenPreview redacts to at most the last 4 chars (api_key and oauth prefixes)', () => {
    expect(tokenPreview('abcdEFGH', 'api_key')).toBe('…EFGH');
    expect(tokenPreview('abcdEFGH', 'oauth')).toBe('oat-…EFGH');
    // Short tokens never expose more than they are.
    expect(tokenPreview('xy', 'api_key')).toBe('…xy');
    // Empty / aws_sdk-style empty token → marker only, no chars.
    expect(tokenPreview('', 'api_key')).toBe('…');
    expect(tokenPreview('', 'oauth')).toBe('oat-…');
  });
});
