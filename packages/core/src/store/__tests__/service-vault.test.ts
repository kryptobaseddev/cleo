/**
 * T11937 — universal service-vault FOUNDATION round-trip + policy-before-decrypt.
 *
 * Proves the M2-W1a ACs against a TEMP-DIR global `cleo.db` (never `.cleo/*.db`):
 *
 *  - AC2/AC6 (migration): opening the global cleo.db applies the
 *    `…_t11937-service-vault` forward migration → the three tables
 *    (`service_connections` / `service_configs` / `agent_service_grants`)
 *    materialize; a second open is a no-op (IF NOT EXISTS).
 *  - AC3/AC6 (store CRUD round-trip): connect → get → list → revoke through the
 *    accessor, with the REAL `encryptGlobal`/`decryptGlobal`. The token is
 *    CIPHERTEXT at rest (never plaintext in the row) and the plaintext is reached
 *    ONLY via the sealed handle's `fetch()`.
 *  - AC4 (policy-before-decrypt): a denied agent (no grant) and a blocked agent
 *    (`mode:'block'`) BOTH resolve to `null` WITHOUT the injected `decrypt` spy
 *    ever being called; a granted agent resolves a sealed handle whose `fetch()`
 *    materializes the access token.
 *
 * @task T11937
 * @epic T11765
 * @saga T10409
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CleoGlobalDb } from '../dual-scope-db.js';
import { _resetDualScopeDbCache } from '../dual-scope-db.js';
import {
  connectService,
  getConnection,
  grantAgentAccess,
  listConnections,
  openServiceVaultAtPath,
  resolveSealedConnection,
  revokeConnection,
  type ServiceTokenBlob,
  type ServiceVaultDeps,
} from '../service-connections-accessor.js';

let testRoot: string;
let db: CleoGlobalDb;

beforeEach(async () => {
  testRoot = join(
    tmpdir(),
    `service-vault-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testRoot, { recursive: true });
  db = await openServiceVaultAtPath(join(testRoot, 'cleo.db'));
});

afterEach(() => {
  _resetDualScopeDbCache();
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

/** Reach the native handle for raw sqlite_master / column-value assertions. */
function native(handle: CleoGlobalDb): DatabaseSync {
  return (handle as unknown as { $client: DatabaseSync }).$client;
}

describe('service-vault migration — global cleo.db', () => {
  it('materialises the three service tables', () => {
    const raw = native(db);
    for (const table of ['service_connections', 'service_configs', 'agent_service_grants']) {
      const row = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { name: string } | undefined;
      expect(row?.name, `table '${table}' must exist`).toBe(table);
    }
  }, 30_000);

  it('re-opening the same DB is a no-op (IF NOT EXISTS idempotency)', async () => {
    _resetDualScopeDbCache();
    // Re-open the SAME path; the migration must not throw on already-present tables.
    const db2 = await openServiceVaultAtPath(join(testRoot, 'cleo.db'));
    const raw = native(db2);
    const row = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='service_connections'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('service_connections');
  }, 30_000);
});

describe('service-vault store CRUD round-trip (real crypto)', () => {
  const tokens: ServiceTokenBlob = {
    accessToken: 'gho_realAccessTokenSecret123',
    refreshToken: 'ghr_realRefreshTokenSecret456',
  };

  it('connect → get → list → revoke with ciphertext at rest', async () => {
    const deps: ServiceVaultDeps = { db };

    const id = await connectService(
      {
        provider: 'github',
        label: 'personal',
        tokens,
        scopes: ['repo', 'read:user'],
        metadata: { username: 'octocat' },
      },
      deps,
    );
    expect(id).toBeGreaterThan(0);

    // GET — non-secret view, no token.
    const view = await getConnection('github', 'personal', deps);
    expect(view).not.toBeNull();
    expect(view?.provider).toBe('github');
    expect(view?.status).toBe('active');
    expect(view?.scopes).toEqual(['repo', 'read:user']);
    expect(view?.metadata).toEqual({ username: 'octocat' });
    expect(view?.hasCredentials).toBe(true);
    // The view object carries NO plaintext token field anywhere.
    expect(JSON.stringify(view)).not.toContain(tokens.accessToken);

    // CIPHERTEXT AT REST — the raw row's credentials_enc is NOT the plaintext.
    const raw = native(db);
    const rowEnc = raw
      .prepare('SELECT credentials_enc FROM service_connections WHERE provider=? AND label=?')
      .get('github', 'personal') as { credentials_enc: string } | undefined;
    expect(rowEnc?.credentials_enc).toBeTruthy();
    expect(rowEnc?.credentials_enc).not.toContain(tokens.accessToken);
    expect(rowEnc?.credentials_enc).not.toContain(tokens.refreshToken);

    // LIST.
    const all = await listConnections(undefined, deps);
    expect(all.map((v) => `${v.provider}:${v.label}`)).toContain('github:personal');
    const byProvider = await listConnections('github', deps);
    expect(byProvider).toHaveLength(1);

    // REVOKE — status flips, credential blob cleared.
    const revoked = await revokeConnection('github', 'personal', deps);
    expect(revoked).toBe(true);
    const afterRevoke = await getConnection('github', 'personal', deps);
    expect(afterRevoke?.status).toBe('revoked');
    expect(afterRevoke?.hasCredentials).toBe(false);
  }, 30_000);

  it('plaintext is reachable ONLY via the sealed handle fetch() for a granted agent', async () => {
    const deps: ServiceVaultDeps = { db };
    const connId = await connectService({ provider: 'github', label: 'work', tokens }, deps);
    await grantAgentAccess('agent-1', connId, { mode: 'allow' }, deps);

    const sealed = await resolveSealedConnection(
      { agentId: 'agent-1', provider: 'github', label: 'work' },
      deps,
    );
    expect(sealed).not.toBeNull();
    // The sealed handle names the credential but carries NO plaintext inline.
    expect(JSON.stringify({ provider: sealed?.provider, account: sealed?.account })).not.toContain(
      tokens.accessToken,
    );
    // Materialize at the wire — real encrypt→decrypt round-trip yields the token.
    const decrypted = await sealed?.fetch();
    expect(decrypted?.value).toBe(tokens.accessToken);
  }, 30_000);
});

describe('service-vault policy-before-decrypt (AC4)', () => {
  const tokens: ServiceTokenBlob = { accessToken: 'tok_secret_value_AAA' };

  it('a denied agent (no grant) resolves null WITHOUT calling decrypt', async () => {
    // Spy on decrypt — it must NEVER be called on a deny.
    const decryptSpy = vi
      .fn<(ciphertext: string, id: string) => Promise<string>>()
      .mockResolvedValue(JSON.stringify(tokens));
    const deps: ServiceVaultDeps = { db, decrypt: decryptSpy };

    await connectService({ provider: 'github', label: 'guarded', tokens }, deps);
    // NO grantAgentAccess → agent has no grant.

    const sealed = await resolveSealedConnection(
      { agentId: 'unauthorized-agent', provider: 'github', label: 'guarded' },
      deps,
    );
    expect(sealed).toBeNull();
    expect(decryptSpy).not.toHaveBeenCalled();
  }, 30_000);

  it('a BLOCKED agent (policy mode:block) resolves null WITHOUT calling decrypt', async () => {
    const decryptSpy = vi
      .fn<(ciphertext: string, id: string) => Promise<string>>()
      .mockResolvedValue(JSON.stringify(tokens));
    const deps: ServiceVaultDeps = { db, decrypt: decryptSpy };

    const connId = await connectService({ provider: 'github', label: 'blocked', tokens }, deps);
    // Grant exists, but the policy BLOCKS.
    await grantAgentAccess('blocked-agent', connId, { mode: 'block' }, deps);

    const sealed = await resolveSealedConnection(
      { agentId: 'blocked-agent', provider: 'github', label: 'blocked' },
      deps,
    );
    expect(sealed).toBeNull();
    expect(decryptSpy).not.toHaveBeenCalled();
  }, 30_000);

  it('a manual-approval policy denies WITHOUT decrypt until approved:true is supplied', async () => {
    const decryptSpy = vi
      .fn<(ciphertext: string, id: string) => Promise<string>>()
      .mockResolvedValue(JSON.stringify(tokens));
    const deps: ServiceVaultDeps = { db, decrypt: decryptSpy };

    const connId = await connectService({ provider: 'github', label: 'manual', tokens }, deps);
    await grantAgentAccess('manual-agent', connId, { mode: 'allow', manualApproval: true }, deps);

    // Without approval → denied, no decrypt.
    const denied = await resolveSealedConnection(
      { agentId: 'manual-agent', provider: 'github', label: 'manual' },
      deps,
    );
    expect(denied).toBeNull();
    expect(decryptSpy).not.toHaveBeenCalled();

    // With approval → allowed; fetch() now triggers exactly one decrypt.
    const approved = await resolveSealedConnection(
      { agentId: 'manual-agent', provider: 'github', label: 'manual', approved: true },
      deps,
    );
    expect(approved).not.toBeNull();
    expect(decryptSpy).not.toHaveBeenCalled(); // still not called until the wire
    const tok = await approved?.fetch();
    expect(tok?.value).toBe(tokens.accessToken);
    expect(decryptSpy).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('a granted agent resolves; decrypt fires only at the wire (fetch), once', async () => {
    const decryptSpy = vi
      .fn<(ciphertext: string, id: string) => Promise<string>>()
      .mockResolvedValue(JSON.stringify(tokens));
    const deps: ServiceVaultDeps = { db, decrypt: decryptSpy };

    const connId = await connectService({ provider: 'github', label: 'ok', tokens }, deps);
    await grantAgentAccess('good-agent', connId, { mode: 'allow' }, deps);

    const sealed = await resolveSealedConnection(
      { agentId: 'good-agent', provider: 'github', label: 'ok' },
      deps,
    );
    expect(sealed).not.toBeNull();
    // Resolve did NOT decrypt — decrypt is deferred to the wire.
    expect(decryptSpy).not.toHaveBeenCalled();
    const tok = await sealed?.fetch();
    expect(tok?.value).toBe(tokens.accessToken);
    expect(decryptSpy).toHaveBeenCalledTimes(1);
  }, 30_000);
});
