/**
 * T13270 — a snapshot export that carries uids marks the store shared even
 * when no project handle is bound: the marker is never skipped silently
 * (review-hotfix LOW on #1895, T13249).
 *
 * @task T13270
 */

// Row uids are opt-in (T12341); this test exercises them.
process.env.CLEO_ROW_UID_FILL = '1';

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { ROW_IDENTITY_SYNCED_KEY } from '../../store/row-identity.js';

const unbound = vi.hoisted(() => ({ on: false }));

vi.mock('../../store/sqlite.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../store/sqlite.js')>();
  return {
    ...mod,
    getNativeTasksDb: (cwd?: string) => (unbound.on ? null : mod.getNativeTasksDb(cwd)),
  };
});

let env: TestDbEnv;

beforeEach(async () => {
  env = await createTestDb();
  await seedTasks(env.accessor, [{ id: 'T001', title: 'carries a uid', type: 'task' }]);
});

afterEach(async () => {
  unbound.on = false;
  await env.cleanup();
});

describe('markIdentityShared without a bound handle (T13270)', () => {
  it('an export with uids opens the store and writes row_identity_synced', async () => {
    const { exportSnapshot } = await import('../index.js');
    unbound.on = true;
    const snapshot = await exportSnapshot(env.tempDir);
    expect(snapshot.tasks.some((t) => t.uid)).toBe(true);
    const db = new DatabaseSync(join(env.tempDir, '.cleo', 'cleo.db'), { readOnly: true });
    try {
      const row = db
        .prepare('SELECT value FROM tasks_row_identity_meta WHERE key = ?')
        .get(ROW_IDENTITY_SYNCED_KEY) as { value: string } | undefined;
      expect(row && JSON.parse(row.value).first).toBe('send');
    } finally {
      db.close();
    }
  });
});
