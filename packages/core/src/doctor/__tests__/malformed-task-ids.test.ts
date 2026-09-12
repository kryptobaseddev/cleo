/**
 * T12128 (gh#1249) — the repair path for rows the CLI cannot address.
 *
 * The write guard stops new malformed ids. These tests cover the other half:
 * a row already in the store whose id no read path accepts, which `cleo list`
 * returns but `show`/`update`/`delete` all refuse to touch.
 *
 * The malformed row has to be inserted with raw SQL precisely because the
 * supported path now rejects it — which is the point.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

/** Insert a row directly, bypassing the write-path guard. */
async function insertRawTaskRow(id: string, title: string): Promise<void> {
  const { sql } = await import('drizzle-orm');
  const { openDualScopeDb } = await import('../../store/dual-scope-db.js');
  const { db } = await openDualScopeDb('project', tempDir);
  await db.run(
    sql`INSERT INTO tasks_tasks (id, title, status, created_at)
        VALUES (${id}, ${title}, 'pending', ${new Date().toISOString()})`,
  );
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-malformed-'));
  const cleoDir = join(tempDir, '.cleo');
  process.env['CLEO_DIR'] = cleoDir;
  await mkdir(cleoDir, { recursive: true });
  await writeFile(
    join(cleoDir, 'config.json'),
    JSON.stringify({
      enforcement: { session: { requiredForMutate: false } },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    }),
  );
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
  await new Promise((r) => setTimeout(r, 50));
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

describe('scanMalformedTaskIds', () => {
  it('reports nothing on a clean store', async () => {
    const { createTask } = await import('../../store/tasks-sqlite.js');
    const { scanMalformedTaskIds } = await import('../malformed-task-ids.js');

    await createTask({
      id: 'T4242',
      title: 'well formed',
      status: 'pending',
      type: 'task',
      priority: 'medium',
      createdAt: new Date().toISOString(),
    } as never);

    const report = await scanMalformedTaskIds(tempDir);
    expect(report.rows).toEqual([]);
    expect(report.deleted).toBe(false);
  });

  it('finds a row whose id is a filesystem path — the value found in the wild', async () => {
    const { scanMalformedTaskIds } = await import('../malformed-task-ids.js');
    await insertRawTaskRow('/mnt/projects/cleocode', 'Task /mnt/projects/cleocode');

    const report = await scanMalformedTaskIds(tempDir);

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.id).toBe('/mnt/projects/cleocode');
    // The title is reported so the operator can recognise what is being
    // discarded before authorising a delete.
    expect(report.rows[0]?.title).toBe('Task /mnt/projects/cleocode');
  });

  it('does not delete without --fix', async () => {
    const { scanMalformedTaskIds } = await import('../malformed-task-ids.js');
    await insertRawTaskRow('/mnt/projects/cleocode', 'junk');

    await scanMalformedTaskIds(tempDir);

    // A repair that runs by default would destroy data on a diagnostic call.
    const after = await scanMalformedTaskIds(tempDir);
    expect(after.rows).toHaveLength(1);
    expect(after.deleted).toBe(false);
  });

  it('removes the row with --fix, and leaves well-formed rows alone', async () => {
    const { createTask } = await import('../../store/tasks-sqlite.js');
    const { scanMalformedTaskIds } = await import('../malformed-task-ids.js');

    await createTask({
      id: 'T4242',
      title: 'keep me',
      status: 'pending',
      type: 'task',
      priority: 'medium',
      createdAt: new Date().toISOString(),
    } as never);
    await insertRawTaskRow('/mnt/projects/cleocode', 'junk');

    const fixed = await scanMalformedTaskIds(tempDir, { fix: true });
    expect(fixed.deleted).toBe(true);
    expect(fixed.rows).toHaveLength(1);

    expect((await scanMalformedTaskIds(tempDir)).rows).toEqual([]);

    const { getTask } = await import('../../store/tasks-sqlite.js');
    expect(await getTask('T4242')).not.toBeNull();
  });
});
