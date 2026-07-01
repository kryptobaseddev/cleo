/**
 * Regression: `getDb()` liveness guard for the shared consolidated `cleo.db`
 * `DatabaseSync` handle (T12020).
 *
 * The tasks and brain domains share ONE native `DatabaseSync` (both extract
 * `$client` from the same `openDualScopeDb('project')` cache entry). When that
 * shared handle is reset — e.g. a concurrent/deferred `closeDb()` /
 * `_resetDualScopeDbCache('project')`, or a fire-and-forget brain write firing
 * across a test boundary — the cached tasks `_db` singleton is left pointing at
 * a CLOSED connection. Without a liveness guard, the next `getDb()` returns that
 * dead handle and its query throws `database is not open`. `observeBrain`'s
 * cross-db session write-guard swallows that error and mistakes it for
 * "session absent", silently nulling `sourceSessionId`.
 *
 * This surfaced as the CI-only flake `brain-retrieval.test.ts:795`
 * (`expected null to be 'S-123'`). `getBrainDb()` already carries this guard
 * (memory-sqlite.ts, T11522); `getDb()` did not — this test locks in the
 * symmetric guard.
 *
 * @task T12020
 * @epic T11992
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

describe('getDb liveness guard (T12020) — shared consolidated handle reset', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-getdb-liveness-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');

    const { getDb } = await import('../sqlite.js');
    const { sessions } = await import('../tasks-schema.js');
    const db = await getDb(tempDir);
    await db
      .insert(sessions)
      .values({ id: 'S-123', name: 'test-session', status: 'active' })
      .onConflictDoNothing()
      .run();
  });

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    const { closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  });

  it('re-derives a live handle when the shared connection is reset between writes', async () => {
    // Simulate a concurrent/deferred reset of the shared consolidated handle:
    // this evicts the dual-scope cache and closes the native connection, exactly
    // like another domain's `closeDb()` firing mid-flight. The tasks `_db`
    // singleton is now stale (closed native handle).
    const { _resetDualScopeDbCache } = await import('../dual-scope-db.js');
    _resetDualScopeDbCache('project');

    // The seeded S-123 is durable on disk. `observeBrain`'s write-guard must
    // re-derive a live handle (via the liveness guard) rather than query the
    // dead one, so the cross-db `sourceSessionId` reference is preserved.
    const { observeBrain, fetchBrainEntries } = await import('../../memory/brain-retrieval.js');
    const result = await observeBrain(tempDir, {
      text: 'observation after shared-handle reset',
      sourceType: 'session-debrief',
      project: 'cleo',
      sourceSessionId: 'S-123',
    });

    const fetched = await fetchBrainEntries(tempDir, { ids: [result.id] });
    expect(fetched.results).toHaveLength(1);
    const data = fetched.results[0].data as Record<string, unknown>;
    expect(data['sourceSessionId']).toBe('S-123');
  });

  it('reflects a live connection after a direct getDb() reset+reopen', async () => {
    const { getDb, closeDb } = await import('../sqlite.js');
    const { sessions } = await import('../tasks-schema.js');
    const { eq } = await import('drizzle-orm');

    // Close the handle, then re-acquire: the guard must hand back a live, usable
    // connection that still sees the durable seed row.
    closeDb();
    const db = await getDb(tempDir);
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, 'S-123'))
      .all();
    expect(rows.map((r) => r.id)).toEqual(['S-123']);
  });
});
