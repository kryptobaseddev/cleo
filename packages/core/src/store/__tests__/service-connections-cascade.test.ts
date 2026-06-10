/**
 * T11941 — service-vault accessor: cascade-delete + redacted-view round-trip.
 *
 * Backs the `cleo service connect/list/revoke/status` CLI verbs at the CORE
 * layer (the thin dispatch handler is a pass-through). Proves against a
 * TEMP-DIR global `cleo.db` (never `.cleo/*.db`):
 *
 *  - connect → list → revoke round-trip (the verb chain the CLI exposes).
 *  - {@link listConnections} returns NON-SECRET {@link ServiceConnectionView}s:
 *    the decrypted token NEVER appears (only `hasCredentials`), proving the
 *    list/status secret-redaction contract (AC2).
 *  - {@link deleteConnectionCascade} HARD-deletes the connection AND cascades
 *    its `agent_service_grants` (AC3): the connection row is gone, the grant
 *    rows are gone, and a second delete is a no-op.
 *
 * @task T11941
 * @epic T11765
 * @saga T10409
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CleoGlobalDb } from '../dual-scope-db.js';
import { _resetDualScopeDbCache } from '../dual-scope-db.js';
import { agentServiceGrants } from '../schema/cleo-global/services.js';
import {
  connectService,
  deleteConnectionCascade,
  grantAgentAccess,
  listConnections,
  openServiceVaultAtPath,
} from '../service-connections-accessor.js';

let testRoot: string;
let db: CleoGlobalDb;

const SECRET_TOKEN = 'gho_SUPERSECRET_access_token_value';
const SECRET_REFRESH = 'ghr_SUPERSECRET_refresh_token_value';

beforeEach(async () => {
  testRoot = join(
    tmpdir(),
    `service-cascade-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

/** Reach the native handle for raw row-count assertions. */
function native(handle: CleoGlobalDb): DatabaseSync {
  return (handle as unknown as { $client: DatabaseSync }).$client;
}

describe('service-vault accessor — connect → list → revoke (cascade) round-trip', () => {
  it('list returns NON-SECRET views — the token NEVER appears', async () => {
    await connectService(
      {
        provider: 'github',
        label: 'personal',
        tokens: { accessToken: SECRET_TOKEN, refreshToken: SECRET_REFRESH },
        scopes: ['repo'],
      },
      { db },
    );

    const views = await listConnections(undefined, { db });
    expect(views).toHaveLength(1);
    const view = views[0];
    expect(view?.provider).toBe('github');
    expect(view?.label).toBe('personal');
    expect(view?.hasCredentials).toBe(true);

    // SECRET-SAFETY PROOF: no field of the view carries the plaintext token,
    // and the serialized view never contains the secret string.
    const serialized = JSON.stringify(views);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(SECRET_REFRESH);
    expect(view).not.toHaveProperty('token');
    expect(view).not.toHaveProperty('accessToken');
    expect(view).not.toHaveProperty('credentialsEnc');
    expect(view).not.toHaveProperty('tokens');
  }, 30_000);

  it('deleteConnectionCascade removes the connection AND cascades its grants', async () => {
    const connId = await connectService(
      { provider: 'github', label: 'personal', tokens: { accessToken: SECRET_TOKEN } },
      { db },
    );
    // Two agents granted on the SAME connection → both grants must cascade.
    await grantAgentAccess('agent-alpha', connId, { mode: 'allow' }, { db });
    await grantAgentAccess('agent-beta', connId, { mode: 'allow' }, { db });

    // Pre-condition: 2 grant rows exist.
    const grantsBefore = await db.select().from(agentServiceGrants);
    expect(grantsBefore).toHaveLength(2);

    const result = await deleteConnectionCascade('github', 'personal', { db });
    expect(result.deleted).toBe(true);
    expect(result.connectionId).toBe(connId);
    expect(result.grantsRemoved).toBe(2);

    // The connection row is GONE (hard delete, not a soft status flip).
    expect(await listConnections(undefined, { db })).toHaveLength(0);
    const raw = native(db);
    const connCount = raw.prepare('SELECT COUNT(*) AS n FROM service_connections').get() as {
      n: number;
    };
    expect(connCount.n).toBe(0);

    // The grant rows are GONE (cascade).
    const grantsAfter = await db.select().from(agentServiceGrants);
    expect(grantsAfter).toHaveLength(0);
  }, 30_000);

  it('deleteConnectionCascade on a missing connection is a no-op', async () => {
    const result = await deleteConnectionCascade('github', 'nope', { db });
    expect(result.deleted).toBe(false);
    expect(result.connectionId).toBeNull();
    expect(result.grantsRemoved).toBe(0);
  }, 30_000);

  it('full round-trip: connect → list(1) → revoke(cascade) → list(0)', async () => {
    expect(await listConnections(undefined, { db })).toHaveLength(0);
    await connectService(
      { provider: 'google', label: 'work', tokens: { accessToken: SECRET_TOKEN } },
      { db },
    );
    expect(await listConnections(undefined, { db })).toHaveLength(1);
    const del = await deleteConnectionCascade('google', 'work', { db });
    expect(del.deleted).toBe(true);
    expect(await listConnections(undefined, { db })).toHaveLength(0);
  }, 30_000);
});
