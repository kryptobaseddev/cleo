/**
 * T12590 — building the attention digest must not close the shared project
 * handle.
 *
 * `cleo focus` builds the digest concurrently with memory search and the
 * ready-wave assessment. `resolveAttentionIdentity` closed its task accessor,
 * and that close evicts every project-scope binding in the process, so the
 * concurrent reads failed with "BRAIN database unavailable" and
 * "Failed query: select id from tasks_tasks".
 *
 * @task T12590
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { buildAttentionDigest, resolveAttentionIdentity } from '../attention.js';

describe('attention identity keeps the shared project handle open (T12590)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: 'T100', title: 'Epic', type: 'epic' },
      { id: 'T001', title: 'Task', type: 'task', parentId: 'T100' },
    ]);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('leaves the tasks and brain handles bound after resolving identity', async () => {
    const { getDb, getNativeTasksDb } = await import('../../store/sqlite.js');
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    await getDb(env.tempDir);
    await getBrainDb(env.tempDir);
    const tasksHandle = getNativeTasksDb(env.tempDir);
    const brainHandle = getBrainNativeDb(env.tempDir);
    expect(tasksHandle).not.toBeNull();
    expect(brainHandle).not.toBeNull();

    await resolveAttentionIdentity(env.tempDir, { taskId: 'T001' });

    // A reader that bound before the digest ran keeps working, and the
    // binding still resolves (memory search reads it synchronously).
    expect(tasksHandle?.isOpen).toBe(true);
    expect(getNativeTasksDb(env.tempDir)).toBe(tasksHandle);
    expect(getBrainNativeDb(env.tempDir)).not.toBeNull();
    expect(tasksHandle?.prepare('SELECT id FROM tasks_tasks').all().length).toBe(2);
  });

  it('does not fail a read that holds the handle across the digest', async () => {
    const { getDb, getNativeTasksDb } = await import('../../store/sqlite.js');
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    await getDb(env.tempDir);
    await getBrainDb(env.tempDir);
    // Shape of orchestrateReady / memory search: bind, await other work, read.
    const reader = (async () => {
      const handle = getNativeTasksDb(env.tempDir);
      await buildAttentionDigest(env.tempDir);
      return {
        brain: getBrainNativeDb(env.tempDir) !== null,
        tasks: handle?.prepare('SELECT id FROM tasks_tasks').all().length,
      };
    })();
    await expect(reader).resolves.toEqual({ brain: true, tasks: 2 });
  });
});
