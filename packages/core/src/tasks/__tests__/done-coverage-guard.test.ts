/**
 * T12883 R2: a task becomes done only with its acceptance criteria covered,
 * on writers other than `cleo complete` — `tasks.bulk-move` and unarchive to
 * done. (Saga auto-close is covered in `sagas/__tests__/reconcile.test.ts`.)
 *
 * @task T12883
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../add.js';
import { coreTaskBulkMove, coreTaskUnarchive } from '../task-reparent.js';

let env: TestDbEnv;
let accessor: DataAccessor;

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

async function seed(title: string, acceptance: string[]): Promise<string> {
  return (
    await addTask(
      {
        title,
        description: `${title} — seeded fixture for T12883 R2`,
        acceptance,
        skipContainmentInvariant: true,
      },
      env.tempDir,
      accessor,
    )
  ).task.id;
}

async function codeOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return (err as { code?: unknown }).code ?? 'thrown';
  }
}

describe('T12883 R2 — done only with covered acceptance criteria', () => {
  it('tasks.bulk-move to done refuses a task with an uncovered criterion', async () => {
    const id = await seed('Uncovered bulk', ['Outcome is proven']);
    expect(
      await codeOf(
        coreTaskBulkMove(env.tempDir, [id], { status: 'done', pipelineStage: 'contribution' }),
      ),
    ).toBe(ExitCode.AC_COVERAGE_INCOMPLETE);
    expect((await accessor.loadSingleTask(id))?.status).toBe('pending');
  });

  it('unarchive to done refuses a task with an uncovered criterion', async () => {
    const id = await seed('Uncovered archived', ['Outcome is proven']);
    await accessor.archiveSingleTask(id, {
      archivedAt: new Date().toISOString(),
      archiveReason: 'superseded',
    });
    expect(await codeOf(coreTaskUnarchive(env.tempDir, id, { status: 'done' }))).toBe(
      ExitCode.AC_COVERAGE_INCOMPLETE,
    );
    expect((await accessor.loadSingleTask(id))?.status).toBe('archived');
  });
});

describe('coreTaskUnarchive regression (T12883)', () => {
  it('unarchives an archived task: the archived row is not mistaken for an active one, and the requested status is written', async () => {
    const id = await seed('Archived then restored', ['Outcome is proven']);
    await accessor.archiveSingleTask(id, {
      archivedAt: new Date().toISOString(),
      archiveReason: 'superseded',
    });
    expect((await accessor.loadSingleTask(id))?.status).toBe('archived');

    const back = await coreTaskUnarchive(env.tempDir, id, { status: 'active' });
    expect(back).toMatchObject({ task: id, unarchived: true, status: 'active' });
    expect((await accessor.loadSingleTask(id))?.status).toBe('active');
    // A task that is already active is still refused.
    await expect(coreTaskUnarchive(env.tempDir, id)).rejects.toThrow(
      /already exists in active tasks/,
    );
  });
});
