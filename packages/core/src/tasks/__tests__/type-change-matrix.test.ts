/**
 * T12883 R4: a type change keeps the parent/child type matrix — for the task
 * under its parent, and for every child under the task's new type.
 *
 * @task T12883
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { updateTask } from '../update.js';

let env: TestDbEnv;
let accessor: DataAccessor;
const createdAt = new Date().toISOString();

beforeEach(async () => {
  env = await createTestDb();
  accessor = env.accessor;
  process.env['CLEO_DIR'] = env.cleoDir;
  await writeFile(
    join(env.cleoDir, 'config.json'),
    JSON.stringify({
      enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    }),
  );
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  resetDbState();
  await env.cleanup();
});

const row = (id: string, type: 'saga' | 'epic' | 'task' | 'subtask', parentId?: string) => ({
  id,
  title: `Row ${id}`,
  status: 'pending' as const,
  priority: 'medium' as const,
  type,
  createdAt,
  ...(parentId ? { parentId } : {}),
});

async function codeOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return (err as { code?: unknown }).code ?? 'thrown';
  }
}

describe('T12883 R4 — type changes keep the type matrix', () => {
  it('refuses re-typing an epic whose tasks a task could not contain', async () => {
    await seedTasks(accessor, [row('T10', 'epic'), row('T11', 'task', 'T10')]);
    expect(await codeOf(updateTask({ taskId: 'T10', type: 'task' }, env.tempDir, accessor))).toBe(
      ExitCode.INVALID_PARENT_TYPE,
    );
    expect((await accessor.loadSingleTask('T10'))?.type).toBe('epic');
  });

  it('refuses re-typing a task to a type its parent cannot contain', async () => {
    await seedTasks(accessor, [row('T20', 'epic'), row('T21', 'task', 'T20')]);
    expect(await codeOf(updateTask({ taskId: 'T21', type: 'epic' }, env.tempDir, accessor))).toBe(
      ExitCode.INVALID_PARENT_TYPE,
    );
  });

  it('allows a type change the matrix accepts (a childless root epic becomes a saga)', async () => {
    await seedTasks(accessor, [row('T30', 'epic')]);
    await updateTask({ taskId: 'T30', type: 'saga' }, env.tempDir, accessor);
    expect((await accessor.loadSingleTask('T30'))?.type).toBe('saga');
  });
});
