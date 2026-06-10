/**
 * T11941 — `cleo service` CLI verbs: connect → list → revoke → status round-trip.
 *
 * Drives the {@link ServiceHandler} dispatch handler IN-PROCESS (never a
 * subprocess) against a TEMP-DIR global `cleo.db` (via `CLEO_HOME` override,
 * exodus-on-open muzzled). The CLI command (`commands/service.ts`) is a thin
 * `dispatchFromCli` wrapper over exactly these handler methods, so exercising
 * the handler proves the verb wiring + envelope shape end-to-end.
 *
 * Proves the M2-W4 ACs:
 *  - AC1/AC2: the four verbs dispatch to their core ops and render a valid LAFS
 *    envelope. `list` redacts secrets — the connections view carries
 *    `hasCredentials` (boolean) but NEVER the token; the raw token string never
 *    appears anywhere in the serialized envelope.
 *  - AC3: `revoke` removes the connection (count=1, deleted=[provider:label]) and
 *    cascades agent_service_grants; a second revoke is a no-op (count=0).
 *  - AC5: a connect→list→revoke round-trip passes; `status` reports expiry health
 *    (expired / needsRefresh) computed from `expires_at`.
 *
 * @task T11941
 * @epic T11765
 * @saga T10409
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetDualScopeDbCache, grantAgentAccess, listConnections } from '@cleocode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DispatchResponse } from '../../types.js';
import { ServiceHandler } from '../service.js';

let testRoot: string;
let prevCleoHome: string | undefined;
let prevExodus: string | undefined;
let handler: ServiceHandler;

const SECRET_TOKEN = 'gho_SUPERSECRET_access_token_value';
const SECRET_REFRESH = 'ghr_SUPERSECRET_refresh_token_value';

beforeEach(() => {
  testRoot = join(
    tmpdir(),
    `service-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testRoot, { recursive: true });
  // Redirect the GLOBAL cleo.db to the temp dir + muzzle exodus-on-open so the
  // canonical `openDualScopeDb('global')` the handler uses resolves to a fresh,
  // empty, migrated temp DB (the three service tables materialize on open).
  prevCleoHome = process.env['CLEO_HOME'];
  prevExodus = process.env['CLEO_DISABLE_EXODUS_ON_OPEN'];
  process.env['CLEO_HOME'] = testRoot;
  process.env['CLEO_DISABLE_EXODUS_ON_OPEN'] = '1';
  _resetDualScopeDbCache();
  handler = new ServiceHandler();
});

afterEach(() => {
  _resetDualScopeDbCache();
  if (prevCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevCleoHome;
  if (prevExodus === undefined) delete process.env['CLEO_DISABLE_EXODUS_ON_OPEN'];
  else process.env['CLEO_DISABLE_EXODUS_ON_OPEN'] = prevExodus;
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

/** Assert a dispatch response is a well-formed success envelope and return its data. */
function expectSuccess(res: DispatchResponse): Record<string, unknown> {
  expect(res.success, JSON.stringify(res.error)).toBe(true);
  expect(res.meta).toBeDefined();
  expect(res.meta.operation).toBeDefined();
  return res.data as Record<string, unknown>;
}

describe('cleo service CLI verbs — connect → list → revoke → status', () => {
  it('connect (token-direct) stores a connection and returns the NON-SECRET identity', async () => {
    const res = await handler.mutate('connect', {
      provider: 'github',
      label: 'personal',
      token: SECRET_TOKEN,
      refreshToken: SECRET_REFRESH,
      scopes: ['repo', 'read:user'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const data = expectSuccess(res);
    expect(data['count']).toBe(1);
    expect(data['created']).toEqual(['1']);
    // The secret must NOT appear anywhere in the connect envelope.
    expect(JSON.stringify(res)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(res)).not.toContain(SECRET_REFRESH);
  }, 30_000);

  it('connect rejects an incomplete request (no token, no paste-code)', async () => {
    const res = await handler.mutate('connect', { provider: 'github', label: 'x' });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_INVALID_INPUT');
  }, 30_000);

  it('list redacts secrets — token NEVER present, tokenPreview/hasCredentials only', async () => {
    await handler.mutate('connect', { provider: 'github', label: 'personal', token: SECRET_TOKEN });
    const res = await handler.query('list', {});
    const data = expectSuccess(res);
    const connections = data['connections'] as Array<Record<string, unknown>>;
    expect(connections).toHaveLength(1);
    const view = connections[0] as Record<string, unknown>;
    expect(view['provider']).toBe('github');
    expect(view['label']).toBe('personal');
    expect(view['status']).toBe('active');
    // The view signals credential PRESENCE without leaking the token.
    expect(view['hasCredentials']).toBe(true);
    // SECRET-SAFETY PROOF: the access token / refresh token never appear in the
    // serialized list envelope, and there is no field carrying the plaintext.
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(SECRET_REFRESH);
    expect(view).not.toHaveProperty('token');
    expect(view).not.toHaveProperty('accessToken');
    expect(view).not.toHaveProperty('credentialsEnc');
  }, 30_000);

  it('list --provider filters to one provider', async () => {
    await handler.mutate('connect', { provider: 'github', label: 'g', token: SECRET_TOKEN });
    await handler.mutate('connect', { provider: 'notion', label: 'n', token: 'secret_notion_tok' });
    const res = await handler.query('list', { provider: 'notion' });
    const data = expectSuccess(res);
    const connections = data['connections'] as Array<Record<string, unknown>>;
    expect(connections).toHaveLength(1);
    expect(connections[0]?.['provider']).toBe('notion');
  }, 30_000);

  it('revoke removes the connection + cascades grants, then is a no-op', async () => {
    const connectRes = await handler.mutate('connect', {
      provider: 'github',
      label: 'personal',
      token: SECRET_TOKEN,
    });
    const connId = Number((expectSuccess(connectRes)['created'] as string[])[0]);
    // Attach an agent grant so the cascade has something to remove (AC3).
    await grantAgentAccess('agent-alpha', connId);

    const res = await handler.mutate('revoke', { provider: 'github', label: 'personal' });
    const data = expectSuccess(res);
    expect(data['count']).toBe(1);
    expect(data['deleted']).toEqual(['github:personal']);
    expect(data['grantsRemoved']).toBe(1);

    // The connection row is gone (hard delete, not a soft status flip).
    expect(await listConnections()).toHaveLength(0);

    // A second revoke finds nothing → count 0, deleted [].
    const again = await handler.mutate('revoke', { provider: 'github', label: 'personal' });
    const againData = expectSuccess(again);
    expect(againData['count']).toBe(0);
    expect(againData['deleted']).toEqual([]);
    expect(againData['grantsRemoved']).toBe(0);
  }, 30_000);

  it('status reports health: a future expiry is healthy, a past expiry needs refresh', async () => {
    await handler.mutate('connect', {
      provider: 'github',
      label: 'fresh',
      token: SECRET_TOKEN,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await handler.mutate('connect', {
      provider: 'github',
      label: 'stale',
      token: 'secret_stale_tok',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });

    const res = await handler.query('status', { provider: 'github' });
    const data = expectSuccess(res);
    const connections = data['connections'] as Array<Record<string, unknown>>;
    const byLabel = new Map(connections.map((c) => [c['label'], c]));

    const fresh = byLabel.get('fresh') as Record<string, unknown>;
    expect(fresh['expired']).toBe(false);
    expect(fresh['needsRefresh']).toBe(false);

    const stale = byLabel.get('stale') as Record<string, unknown>;
    expect(stale['expired']).toBe(true);
    expect(stale['needsRefresh']).toBe(true);

    // SECRET-SAFETY PROOF for status too.
    expect(JSON.stringify(res)).not.toContain(SECRET_TOKEN);
  }, 30_000);

  it('full round-trip: connect → list → revoke → list(empty)', async () => {
    expect(expectSuccess(await handler.query('list', {}))['connections'] as unknown[]).toHaveLength(
      0,
    );
    await handler.mutate('connect', { provider: 'google', label: 'work', token: SECRET_TOKEN });
    expect(expectSuccess(await handler.query('list', {}))['connections'] as unknown[]).toHaveLength(
      1,
    );
    const revoke = expectSuccess(
      await handler.mutate('revoke', { provider: 'google', label: 'work' }),
    );
    expect(revoke['count']).toBe(1);
    expect(expectSuccess(await handler.query('list', {}))['connections'] as unknown[]).toHaveLength(
      0,
    );
  }, 30_000);
});
