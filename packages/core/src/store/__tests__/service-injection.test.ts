/**
 * Service-credential injection at the tool boundary (T11940 · M2-W3 · AC1–AC5).
 *
 * Required proofs:
 *  - **AC1 — host/path matching.** `matchServiceHost` / `matchServiceUrl` resolve a
 *    request host (and path) to the right {@link ServiceProviderDef} + host rule,
 *    pick the most specific path-prefixed rule, and return `null` for an unclaimed
 *    host.
 *  - **AC2 — injection (trust-gated, sealed).** `injectServiceCredentials` resolves
 *    a granted github connection and materializes the `Authorization: Bearer <token>`
 *    header on the request; a `basic-x-access-token` host frames the token as
 *    `Authorization: Basic base64("x-access-token:<token>")`; a stale Authorization
 *    the tool emitted is stripped and replaced.
 *  - **AC3 — redaction.** The full plaintext token appears in NO field of the result
 *    diagnostic and the deep walk of the diagnostic finds it nowhere; the ONLY
 *    credential-derived diagnostic string is the non-secret `tokenPreview`.
 *  - **AC4 — no proxy.** The injector is a pure function over a request descriptor —
 *    no network I/O fires (the injected `fetch`/`now` deps are never invoked for a
 *    non-expired connection).
 *  - **deny path** — a non-granted agent gets `injected: false`, the original request
 *    untouched, and `decryptGlobal` is NEVER called (policy-before-decrypt).
 *
 * The vault is a TEMP-DIR `cleo.db` (off `.cleo/*.db`); no real network, no MITM.
 *
 * @epic T11765
 * @task T11940
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CleoGlobalDb } from '../dual-scope-db.js';
import { _resetDualScopeDbCache } from '../dual-scope-db.js';
import {
  connectService,
  grantAgentAccess,
  openServiceVaultAtPath,
  type ServiceVaultDeps,
} from '../service-connections-accessor.js';
import { matchServiceHost, matchServiceUrl } from '../service-host-matcher.js';
import { injectionRulesForStrategy, injectServiceCredentials } from '../service-injection.js';

const AGENT = 'agent-injection-test';
const TOKEN = 'gho_SECRET_service_token_do_not_leak_4242abcd';

let testRoot: string;
let db: CleoGlobalDb;

beforeEach(async () => {
  testRoot = join(
    tmpdir(),
    `service-injection-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testRoot, { recursive: true });
  db = await openServiceVaultAtPath(join(testRoot, 'cleo.db'));
});

afterEach(() => {
  _resetDualScopeDbCache();
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Connect a github credential and grant the agent access. */
async function connectAndGrant(label = 'default'): Promise<void> {
  const connId = await connectService(
    { provider: 'github', label, tokens: { accessToken: TOKEN } },
    { db },
  );
  await grantAgentAccess(AGENT, connId, { mode: 'allow' }, { db });
}

/** Recursively collect every string reachable from a value (not descending functions). */
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

// ===========================================================================
// AC1 — host/path matching
// ===========================================================================

describe('service host matcher (AC1)', () => {
  it('matches an exact api host to its provider + strategy', () => {
    const m = matchServiceHost('api.github.com', '/user');
    expect(m?.provider.provider).toBe('github');
    expect(m?.strategy).toBe('bearer');
  });

  it('frames git-over-https github.com as basic-x-access-token', () => {
    const m = matchServiceHost('github.com', '/owner/repo.git');
    expect(m?.provider.provider).toBe('github');
    expect(m?.strategy).toBe('basic-x-access-token');
  });

  it('prefers the most specific path-prefixed rule', () => {
    // www.googleapis.com/gmail/ → gmail; /drive/ → google-drive.
    expect(matchServiceHost('www.googleapis.com', '/gmail/v1/users/me')?.provider.provider).toBe(
      'gmail',
    );
    expect(matchServiceHost('www.googleapis.com', '/drive/v3/files')?.provider.provider).toBe(
      'google-drive',
    );
  });

  it('returns null for an unclaimed host', () => {
    expect(matchServiceHost('example.invalid', '/x')).toBeNull();
    expect(matchServiceUrl('not a url')).toBeNull();
  });

  it('tolerates a port and trailing dot on the host', () => {
    expect(matchServiceHost('api.github.com:443')?.provider.provider).toBe('github');
    expect(matchServiceUrl('https://api.github.com./user')?.provider.provider).toBe('github');
  });
});

// ===========================================================================
// AC2 — injection (trust-gated, sealed)
// ===========================================================================

describe('injectServiceCredentials (AC2)', () => {
  it('materializes a Bearer Authorization header for a granted github connection', async () => {
    await connectAndGrant();
    const res = await injectServiceCredentials(
      { agentId: AGENT, request: { url: 'https://api.github.com/user', headers: {} } },
      { vault: { db } },
    );
    expect(res.injected).toBe(true);
    expect(res.request.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(res.diagnostic.provider).toBe('github');
    expect(res.diagnostic.strategy).toBe('bearer');
  });

  it('frames a git-over-https request as Basic x-access-token', async () => {
    await connectAndGrant();
    const res = await injectServiceCredentials(
      { agentId: AGENT, request: { url: 'https://github.com/owner/repo.git', headers: {} } },
      { vault: { db } },
    );
    expect(res.injected).toBe(true);
    const expected = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
    expect(res.request.headers.Authorization).toBe(expected);
  });

  it('strips a stale Authorization the tool emitted and replaces it', async () => {
    await connectAndGrant();
    const res = await injectServiceCredentials(
      {
        agentId: AGENT,
        request: {
          url: 'https://api.github.com/user',
          headers: { authorization: 'Bearer STALE-PLACEHOLDER' },
        },
      },
      { vault: { db } },
    );
    // Exactly one Authorization header, carrying the vault token (case-normalized).
    const authKeys = Object.keys(res.request.headers).filter(
      (k) => k.toLowerCase() === 'authorization',
    );
    expect(authKeys).toHaveLength(1);
    expect(res.request.headers[authKeys[0] as string]).toBe(`Bearer ${TOKEN}`);
  });
});

// ===========================================================================
// AC3 — redaction (only tokenPreview crosses the boundary)
// ===========================================================================

describe('injectServiceCredentials redaction (AC3)', () => {
  it('never surfaces the plaintext in the diagnostic; only tokenPreview', async () => {
    await connectAndGrant();
    const res = await injectServiceCredentials(
      { agentId: AGENT, request: { url: 'https://api.github.com/user', headers: {} } },
      { vault: { db } },
    );
    // The injected header DOES carry the token (it is bound to the wire) — but the
    // DIAGNOSTIC must not. Walk every string in the diagnostic; none is the secret.
    const diagStrings = reachableStrings(res.diagnostic);
    expect(diagStrings).not.toContain(TOKEN);
    expect(JSON.stringify(res.diagnostic)).not.toContain(TOKEN);
    // The only credential-derived diagnostic string is the redacted preview.
    expect(res.diagnostic.tokenPreview).toBeTruthy();
    expect(res.diagnostic.tokenPreview).not.toBe(TOKEN);
    expect(res.diagnostic.tokenPreview?.length ?? 0).toBeLessThan(TOKEN.length);
  });
});

// ===========================================================================
// AC4 — no proxy / no network I/O on the non-expired path
// ===========================================================================

describe('injectServiceCredentials (AC4 — no MITM proxy / no network)', () => {
  it('performs no network I/O for a non-expired connection', async () => {
    await connectAndGrant();
    const fetchSpy = vi.fn();
    const res = await injectServiceCredentials(
      { agentId: AGENT, request: { url: 'https://api.github.com/user', headers: {} } },
      { vault: { db }, fetch: fetchSpy as never },
    );
    expect(res.injected).toBe(true);
    // No refresh needed → the injected HTTP transport is never touched.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.diagnostic.refreshed).toBe(false);
  });
});

// ===========================================================================
// deny path — policy-before-decrypt
// ===========================================================================

describe('injectServiceCredentials deny path (policy-before-decrypt)', () => {
  it('does not inject and NEVER decrypts when the agent is not granted', async () => {
    // Connect github but DO NOT grant the agent.
    await connectService(
      { provider: 'github', label: 'default', tokens: { accessToken: TOKEN } },
      { db },
    );
    const decryptSpy = vi.fn(async (_ciphertext: string, _id: string) => {
      // Should never run — assert via the call count below.
      return JSON.stringify({ accessToken: 'LEAKED' });
    });
    const original = { url: 'https://api.github.com/user', headers: { 'X-Keep': '1' } };
    const res = await injectServiceCredentials(
      { agentId: AGENT, request: original },
      { vault: { db, decrypt: decryptSpy as ServiceVaultDeps['decrypt'] } },
    );
    expect(res.injected).toBe(false);
    // The original request is returned untouched (no Authorization added).
    expect(res.request.headers.Authorization).toBeUndefined();
    expect(res.request.headers['X-Keep']).toBe('1');
    // Policy-before-decrypt: no crypto ran on the deny path.
    expect(decryptSpy).not.toHaveBeenCalled();
    expect(res.diagnostic.tokenPreview).toBeNull();
  });

  it('leaves an unclaimed-host request untouched (injected: false)', async () => {
    await connectAndGrant();
    const res = await injectServiceCredentials(
      { agentId: AGENT, request: { url: 'https://example.invalid/x', headers: { a: 'b' } } },
      { vault: { db } },
    );
    expect(res.injected).toBe(false);
    expect(res.request.headers).toEqual({ a: 'b' });
    expect(res.diagnostic.provider).toBeNull();
  });
});

// ===========================================================================
// strategy → rule mapping
// ===========================================================================

describe('injectionRulesForStrategy', () => {
  it('strips then sets Authorization for every strategy', () => {
    for (const strategy of ['bearer', 'basic-x-access-token', 'header'] as const) {
      const rules = injectionRulesForStrategy(strategy);
      expect(rules[0]).toMatchObject({ kind: 'remove-header', name: 'Authorization' });
      expect(rules[1]).toMatchObject({
        kind: 'set-header',
        name: 'Authorization',
        framing: strategy,
      });
    }
  });
});
