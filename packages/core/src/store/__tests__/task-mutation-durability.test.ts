/** Behavioral storage regressions for T12198. All stores are disposable. */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDbPath, getNativeTasksDb } from '../sqlite.js';
import { createSqliteDataAccessor } from '../sqlite-data-accessor.js';

function task(id: string, title: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title,
    description: title,
    status: 'pending',
    priority: 'medium',
    createdAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

function persisted(project: string, query: string): string {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all()));
    db.close();
  `,
      getDbPath(project),
      query,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(child.status, child.stderr).toBe(0);
  return child.stdout;
}

describe('task mutation durability', () => {
  let root: string;
  let projectA: string;
  let projectB: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-mutation-durability-'));
    projectA = join(root, 'a');
    projectB = join(root, 'b');
    await mkdir(join(projectA, '.cleo'), { recursive: true });
    await mkdir(join(projectB, '.cleo'), { recursive: true });
    vi.stubEnv('CLEO_DIR', '.cleo');
  });
  afterEach(async () => {
    closeDb();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('keeps interleaved project reads, position writes and claims bound to the addressed project', async () => {
    const a = await createSqliteDataAccessor(projectA);
    const b = await createSqliteDataAccessor(projectB);
    for (const [store, title] of [
      [a, 'A'],
      [b, 'B'],
    ] as const) {
      await store.upsertSingleTask(task('T1', title, { position: 1 }));
      await store.upsertSingleTask(
        task('T2', `${title} child`, { parentId: 'T1', depends: ['T1'] }),
      );
    }
    expect((await a.getAncestorChain('T2')).map((row) => row.title)).toEqual(['A']);
    expect((await b.getSubtree('T1')).map((row) => row.title).sort()).toEqual(['B', 'B child']);
    expect(await a.getDependencyChain('T2')).toEqual(['T1']);
    expect(await a.getNextPosition(null)).toBe(2);
    await a.shiftPositions(null, 1, 3);
    await b.claimTask('T1', 'agent-b');
    expect(
      persisted(projectA, "SELECT title, position, assignee FROM tasks_tasks WHERE id = 'T1'"),
    ).toBe('[{"title":"A","position":4,"assignee":null}]');
    expect(
      persisted(projectB, "SELECT title, position, assignee FROM tasks_tasks WHERE id = 'T1'"),
    ).toBe('[{"title":"B","position":1,"assignee":"agent-b"}]');
    await b.unclaimTask('T1');
  });

  it.each([
    'tasks_task_dependencies',
    'tasks_task_acceptance_criteria',
  ])('rolls back every write when %s rejects an insertion', async (table) => {
    const a = await createSqliteDataAccessor(projectA);
    await a.upsertSingleTask(task('T1', 'Dependency'));
    const native = getNativeTasksDb(projectA)!;
    native.exec(
      `CREATE TRIGGER fail_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`,
    );
    await expect(
      a.transaction(async (tx) => {
        await tx.upsertSingleTask(
          task('T2', 'Must rollback', { acceptance: ['Criterion'], depends: ['T1'] }),
        );
        await tx.insertAcRows([{ id: 'ac-t2', taskId: 'T2', ordinal: 1, text: 'Criterion' }]);
      }),
    ).rejects.toMatchObject({ cause: { message: 'injected write failure' } });
    expect(persisted(projectA, "SELECT id FROM tasks_tasks WHERE id = 'T2'")).toBe('[]');
    expect(
      persisted(projectA, "SELECT task_id FROM tasks_task_dependencies WHERE task_id = 'T2'"),
    ).toBe('[]');
    expect(
      persisted(
        projectA,
        "SELECT task_id FROM tasks_task_acceptance_criteria WHERE task_id = 'T2'",
      ),
    ).toBe('[]');
  });

  it('rejects an update that addresses no row', async () => {
    const a = await createSqliteDataAccessor(projectA);
    await expect(a.updateTaskFields('T404', { title: 'Never persisted' })).rejects.toThrow(
      /not found/i,
    );
  });
});
