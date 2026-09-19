/** Behavioral storage regressions for T12198. All stores are disposable. */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionAccessor } from '../data-accessor.js';
import { closeDb, getDbPath, getNativeTasksDb } from '../sqlite.js';
import { createSqliteDataAccessor, setMetaValue } from '../sqlite-data-accessor.js';

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
    // This fixture addresses two projects; a process-wide root pin overrides discovery.
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_PROJECT_ROOT', undefined);
  });
  afterEach(async () => {
    const { awaitBackgroundOps } = await import('../background-ops.js');
    await awaitBackgroundOps();
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

  it('does not roll back another concurrent caller after that caller reports success', async () => {
    const a = await createSqliteDataAccessor(projectA);
    const b = await createSqliteDataAccessor(projectA);
    const failed = a.transaction(async (tx) => {
      await tx.upsertSingleTask(task('T1', 'Rolled back'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error('first caller failure');
    });
    const succeeded = b.transaction(async (tx) => {
      await tx.upsertSingleTask(task('T2', 'Committed'));
    });
    const outcomes = await Promise.allSettled([failed, succeeded]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'fulfilled']);
    expect(persisted(projectA, 'SELECT id, title FROM tasks_tasks ORDER BY id')).toBe(
      '[{"id":"T2","title":"Committed"}]',
    );
  });

  it.each(['commit', 'abort'])('expires inherited transaction ownership after %s', async (end) => {
    const store = await createSqliteDataAccessor(projectA);
    const launch = Promise.withResolvers<void>();
    let delayed = Promise.resolve();
    await store
      .transaction(async () => {
        delayed = launch.promise.then(() => store.upsertSingleTask(task('T3', 'Independent')));
        if (end === 'abort') throw new DOMException('cancelled', 'AbortError');
      })
      .catch((error) => {
        if (error.name !== 'AbortError') throw error;
      });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failing = store
      .transaction(async (tx) => {
        await tx.upsertSingleTask(task('T4', 'Must rollback'));
        entered.resolve();
        await release.promise;
        throw new Error('unrelated rollback');
      })
      .catch((error) => error.message);
    await entered.promise;
    launch.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release.resolve();
    expect(await failing).toBe('unrelated rollback');
    await delayed;
    expect(persisted(projectA, 'SELECT id, title FROM tasks_tasks ORDER BY id')).toBe(
      '[{"id":"T3","title":"Independent"}]',
    );
  });

  it('serializes sibling savepoints and preserves awaited nested rollback', async () => {
    const store = await createSqliteDataAccessor(projectA);
    await store.transaction(async (tx) => {
      await tx.upsertSingleTask(task('T1', 'Outer'));
      const outcomes = await Promise.allSettled([
        store.transaction(async (inner) => {
          await inner.upsertSingleTask(task('T2', 'Successful sibling'));
          await new Promise((resolve) => setTimeout(resolve, 20));
        }),
        store.transaction(async (inner) => {
          await inner.upsertSingleTask(task('T3', 'Cancelled sibling'));
          await store.transaction(async (deep) => {
            await deep.upsertSingleTask(task('T4', 'Cancelled descendant'));
          });
          throw new DOMException('cancelled', 'AbortError');
        }),
      ]);
      expect(outcomes.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    });
    expect(persisted(projectA, 'SELECT id FROM tasks_tasks ORDER BY id')).toBe(
      '[{"id":"T1"},{"id":"T2"}]',
    );
  });

  it.each([
    'independent',
    'parent',
  ])('queues standalone writes from an %s caller behind another scope', async (origin) => {
    const store = await createSqliteDataAccessor(projectA);
    await store.upsertSingleTask(task('T1', 'First', { position: 1 }));
    await store.upsertSingleTask(task('T2', 'Second'));
    const scenario = async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const failing = store
        .transaction(async (tx) => {
          await tx.upsertSingleTask(task('T4', 'Must rollback'));
          entered.resolve();
          await release.promise;
          throw new Error('other scope rollback');
        })
        .catch((error) => error.message);
      await entered.promise;
      const writes = Promise.all([
        store.addRelation('T1', 'T2', 'related'),
        store.shiftPositions(null, 1, 2),
        store.claimTask('T1', 'agent-committed'),
        store.appendLog({ id: 'durable-audit', action: 'test', taskId: 'T1' }),
        store.setMetaValue('accessor-marker', 'durable'),
        setMetaValue(projectA, 'exported-marker', 'durable'),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      release.resolve();
      expect(await failing).toBe('other scope rollback');
      await writes;
    };
    if (origin === 'parent') await store.transaction(scenario);
    else await scenario();
    expect(persisted(projectA, 'SELECT task_id, related_to FROM tasks_task_relations')).toBe(
      '[{"task_id":"T1","related_to":"T2"}]',
    );
    expect(persisted(projectA, "SELECT position, assignee FROM tasks_tasks WHERE id = 'T1'")).toBe(
      '[{"position":3,"assignee":"agent-committed"}]',
    );
    expect(persisted(projectA, "SELECT id FROM main.audit_log WHERE id = 'durable-audit'")).toBe(
      '[{"id":"durable-audit"}]',
    );
    expect(await store.getMetaValue('accessor-marker')).toBe('durable');
    expect(await store.getMetaValue('exported-marker')).toBe('durable');
  });

  it('queues transaction-port writes behind a failing sibling savepoint', async () => {
    const store = await createSqliteDataAccessor(projectA);
    await store.transaction(async (tx) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const failed = store
        .transaction(async (inner) => {
          await inner.upsertSingleTask(task('T1', 'Rolled back sibling'));
          entered.resolve();
          await release.promise;
          throw new Error('sibling rollback');
        })
        .catch((error) => error.message);
      await entered.promise;
      const kept = tx.upsertSingleTask(task('T2', 'Kept port write'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      release.resolve();
      expect(await failed).toBe('sibling rollback');
      await kept;
    });
    expect(persisted(projectA, 'SELECT id FROM tasks_tasks')).toBe('[{"id":"T2"}]');
  });

  it('rejects joining a native transaction whose caller has no accessor ownership', async () => {
    const store = await createSqliteDataAccessor(projectA);
    const native = getNativeTasksDb(projectA)!;
    native.exec('BEGIN IMMEDIATE');
    try {
      await expect(store.upsertSingleTask(task('T1', 'Must reject'))).rejects.toThrow(
        'without an active task-accessor owner',
      );
    } finally {
      native.exec('ROLLBACK');
    }
    expect(persisted(projectA, 'SELECT id FROM tasks_tasks')).toBe('[]');
  });

  it('rejects writes through a transaction port after its scope ends', async () => {
    const store = await createSqliteDataAccessor(projectA);
    const captured = Promise.withResolvers<TransactionAccessor>();
    await store.transaction(async (tx) => {
      captured.resolve(tx);
    });
    const expired = await captured.promise;
    await expect(expired.setMetaValue('escaped', 'must not exist')).rejects.toThrow(
      'Transaction scope has ended',
    );
    await expect(expired.upsertSingleTask(task('T1', 'Escaped'))).rejects.toThrow(
      'Transaction scope has ended',
    );
    expect(await store.getMetaValue('escaped')).toBeNull();
    expect(persisted(projectA, 'SELECT id FROM tasks_tasks')).toBe('[]');
  });

  it('rolls back a standalone upsert when its dependency insertion fails', async () => {
    const a = await createSqliteDataAccessor(projectA);
    await a.upsertSingleTask(task('T1', 'Dependency'));
    getNativeTasksDb(projectA)!.exec(
      "CREATE TRIGGER fail_dep BEFORE INSERT ON tasks_task_dependencies BEGIN SELECT RAISE(ABORT, 'injected write failure'); END",
    );
    await expect(
      a.upsertSingleTask(task('T2', 'Must rollback', { depends: ['T1'] })),
    ).rejects.toThrow();
    expect(persisted(projectA, "SELECT id FROM tasks_tasks WHERE id = 'T2'")).toBe('[]');
  });

  it('persists formerly omitted SDK update fields and acceptance rows in a fresh process', async () => {
    const a = await createSqliteDataAccessor(projectA);
    await a.upsertSingleTask(task('T1', 'Original'));
    const { updateTask } = await import('../tasks-sqlite.js');
    await updateTask(
      'T1',
      {
        title: 'Changed',
        kind: 'bug',
        scope: 'unit',
        severity: 'P0',
        positionVersion: 7,
        noAutoComplete: true,
        pipelineStage: 'implementation',
        acceptance: ['First', 'Second'],
        provenance: { createdBy: 'creator', modifiedBy: 'editor', sessionId: null },
      },
      projectA,
    );
    expect(
      persisted(
        projectA,
        "SELECT title, role, scope, severity, position_version, no_auto_complete, pipeline_stage, acceptance_json, created_by, modified_by FROM tasks_tasks WHERE id = 'T1'",
      ),
    ).toBe(
      JSON.stringify([
        {
          title: 'Changed',
          role: 'bug',
          scope: 'unit',
          severity: 'P0',
          position_version: 7,
          no_auto_complete: 1,
          pipeline_stage: 'implementation',
          acceptance_json: '["First","Second"]',
          created_by: 'creator',
          modified_by: 'editor',
        },
      ]),
    );
    expect(
      persisted(
        projectA,
        "SELECT text FROM tasks_task_acceptance_criteria WHERE task_id = 'T1' ORDER BY ordinal",
      ),
    ).toBe('[{"text":"First"},{"text":"Second"}]');
    await updateTask('T1', { severity: null }, projectA);
    expect(persisted(projectA, "SELECT severity FROM tasks_tasks WHERE id = 'T1'")).toBe(
      '[{"severity":null}]',
    );
  });

  it('creates concurrent project-owned task, parent, dependency and criterion records', async () => {
    const a = await createSqliteDataAccessor(projectA);
    const b = await createSqliteDataAccessor(projectB);
    await Promise.all(
      ([a, b] as const).map(async (store, index) => {
        const title = index === 0 ? 'A' : 'B';
        await store.transaction(async (tx) => {
          await tx.upsertSingleTask(task('T1', `${title} parent`));
          await tx.upsertSingleTask(
            task('T2', `${title} child`, {
              parentId: 'T1',
              acceptance: [`${title} criterion`],
              depends: ['T1'],
            }),
          );
          await tx.insertAcRows([
            { id: `${title}-ac`, taskId: 'T2', ordinal: 1, text: `${title} criterion` },
          ]);
        });
      }),
    );
    for (const [project, title] of [
      [projectA, 'A'],
      [projectB, 'B'],
    ] as const) {
      expect(
        persisted(
          project,
          "SELECT id, title, parent_id, acceptance_json FROM tasks_tasks WHERE id = 'T2'",
        ),
      ).toBe(
        JSON.stringify([
          {
            id: 'T2',
            title: `${title} child`,
            parent_id: 'T1',
            acceptance_json: JSON.stringify([`${title} criterion`]),
          },
        ]),
      );
      expect(persisted(project, 'SELECT task_id, text FROM tasks_task_acceptance_criteria')).toBe(
        JSON.stringify([{ task_id: 'T2', text: `${title} criterion` }]),
      );
      expect(persisted(project, 'SELECT task_id, depends_on FROM tasks_task_dependencies')).toBe(
        '[{"task_id":"T2","depends_on":"T1"}]',
      );
    }
  });

  it('surfaces diagnostic read failures instead of returning empty relationships', async () => {
    const a = await createSqliteDataAccessor(projectA);
    getNativeTasksDb(projectA)!.exec(
      'ALTER TABLE tasks_task_dependencies RENAME TO unavailable_dependencies',
    );
    await expect(a.getDependencyChain('T1')).rejects.toThrow(/no such table/);
  });

  it('rolls back SDK updates and creations when acceptance or dependency storage fails', async () => {
    const a = await createSqliteDataAccessor(projectA);
    await a.upsertSingleTask(task('T1', 'Original'));
    const { createTask, updateTask } = await import('../tasks-sqlite.js');
    getNativeTasksDb(projectA)!.exec(
      "CREATE TRIGGER fail_ac BEFORE INSERT ON tasks_task_acceptance_criteria BEGIN SELECT RAISE(ABORT, 'AC failure'); END",
    );
    await expect(
      updateTask('T1', { title: 'Lost', acceptance: ['Must rollback'] }, projectA),
    ).rejects.toThrow();
    expect(
      persisted(projectA, "SELECT title, acceptance_json FROM tasks_tasks WHERE id = 'T1'"),
    ).toBe('[{"title":"Original","acceptance_json":"[]"}]');
    getNativeTasksDb(projectA)!.exec(
      "CREATE TRIGGER fail_dep BEFORE INSERT ON tasks_task_dependencies BEGIN SELECT RAISE(ABORT, 'dependency failure'); END",
    );
    await expect(
      createTask(task('T2', 'Rejected', { depends: ['T1'] }), projectA),
    ).rejects.toThrow();
    expect(persisted(projectA, "SELECT id FROM tasks_tasks WHERE id = 'T2'")).toBe('[]');
    await updateTask('T1', { title: undefined, description: 'Updated only description' }, projectA);
    expect(persisted(projectA, "SELECT title FROM tasks_tasks WHERE id = 'T1'")).toBe(
      '[{"title":"Original"}]',
    );
  });

  it('rolls back SDK task, acceptance and dependency changes when relation insertion fails', async () => {
    const { createTask, updateTask } = await import('../tasks-sqlite.js');
    await createTask(task('T1', 'Original', { acceptance: ['Original criterion'] }), projectA);
    await createTask(task('T2', 'Related target'), projectA);
    getNativeTasksDb(projectA)!.exec(
      "CREATE TRIGGER fail_relation BEFORE INSERT ON tasks_task_relations BEGIN SELECT RAISE(ABORT, 'relation failure'); END",
    );
    await expect(
      updateTask(
        'T1',
        {
          title: 'Rejected',
          acceptance: ['Rejected criterion'],
          depends: ['T2'],
          relates: [{ taskId: 'T2', type: 'related' }],
        },
        projectA,
      ),
    ).rejects.toThrow();
    await expect(
      createTask(
        task('T3', 'Rejected creation', {
          acceptance: ['Rejected criterion'],
          depends: ['T2'],
          relates: [{ taskId: 'T2', type: 'related' }],
        }),
        projectA,
      ),
    ).rejects.toThrow();
    expect(persisted(projectA, 'SELECT id, title FROM tasks_tasks ORDER BY id')).toBe(
      '[{"id":"T1","title":"Original"},{"id":"T2","title":"Related target"}]',
    );
    expect(persisted(projectA, 'SELECT text FROM tasks_task_acceptance_criteria')).toBe(
      '[{"text":"Original criterion"}]',
    );
    expect(persisted(projectA, 'SELECT task_id FROM tasks_task_dependencies')).toBe('[]');
    expect(persisted(projectA, 'SELECT task_id FROM tasks_task_relations')).toBe('[]');
  });

  it('doctor detects equal-count content drift and propagates a failed diagnostic query', async () => {
    const a = await createSqliteDataAccessor(projectA);
    await a.transaction(async (tx) => {
      await tx.upsertSingleTask(task('T1', 'Drifting', { acceptance: ['Expected criterion'] }));
      await tx.insertAcRows([
        { id: 'drift-ac', taskId: 'T1', ordinal: 1, text: 'Different criterion' },
      ]);
    });
    const { scanAcceptanceDrift } = await import('../../doctor/acceptance-drift.js');
    const scan = scanAcceptanceDrift(projectA);
    expect(scan.unbaselined).toMatchObject([
      { taskId: 'T1', kind: 'content-mismatch', jsonCount: 1, textRowCount: 1 },
    ]);
    getNativeTasksDb(projectA)!.exec(
      'ALTER TABLE tasks_task_acceptance_criteria RENAME TO unavailable_criteria',
    );
    expect(() => scanAcceptanceDrift(projectA)).toThrow(/no such table/);
  });

  it('doctor preserves literal pipes and accepts matching criteria with ordinal gaps', async () => {
    const a = await createSqliteDataAccessor(projectA);
    await a.transaction(async (tx) => {
      await tx.upsertSingleTask(
        task('T1', 'Agrees', { acceptance: ['Type "left | right"', 'Second criterion'] }),
      );
      await tx.insertAcRows([
        { id: 'first-ac', taskId: 'T1', ordinal: 5, text: 'Type "left | right"' },
        { id: 'second-ac', taskId: 'T1', ordinal: 9, text: 'Second criterion' },
      ]);
    });
    const { scanAcceptanceDrift } = await import('../../doctor/acceptance-drift.js');
    expect(scanAcceptanceDrift(projectA).entries).toEqual([]);
  });

  it('allocates durable unique IDs through concurrent public addTask calls across projects', async () => {
    const { addTask } = await import('../../tasks/add.js');
    const { createTask } = await import('../tasks-sqlite.js');
    for (const project of [projectA, projectB]) {
      await mkdir(join(project, '.git'));
      await writeFile(
        join(project, '.cleo', 'config.json'),
        JSON.stringify({
          enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
          lifecycle: { mode: 'off' },
          verification: { enabled: false },
        }),
      );
      await createTask(
        task('T001', 'Parent', { type: 'epic', acceptance: ['Parent criterion'] }),
        project,
      );
    }
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) => {
        const project = index % 2 === 0 ? projectA : projectB;
        const title = `Concurrent work ${index}`;
        const acceptance = [`Criterion number ${index}`];
        const result = await addTask(
          {
            title,
            description: `Unique implementation ${index}`,
            type: 'task',
            parentId: 'T001',
            acceptance,
            depends: ['T001'],
            forceDuplicate: true,
          },
          project,
        );
        return { project, title, acceptance, id: result.task.id };
      }),
    );
    expect(
      outcomes.map((outcome) => outcome.status),
      outcomes
        .flatMap((outcome) => (outcome.status === 'rejected' ? [String(outcome.reason)] : []))
        .join('\n'),
    ).toEqual(Array(8).fill('fulfilled'));
    const results = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    for (const project of [projectA, projectB]) {
      const created = results.filter((result) => result.project === project);
      expect(new Set(created.map((result) => result.id)).size).toBe(4);
      expect(persisted(project, 'SELECT COUNT(*) AS n FROM tasks_tasks')).toBe('[{"n":5}]');
      for (const row of created) {
        expect(row.id).toMatch(/^T[0-9]+$/);
        expect(
          persisted(
            project,
            `SELECT title, parent_id, acceptance_json FROM tasks_tasks WHERE id = '${row.id}'`,
          ),
        ).toBe(
          JSON.stringify([
            {
              title: row.title,
              parent_id: 'T001',
              acceptance_json: JSON.stringify(row.acceptance),
            },
          ]),
        );
        expect(
          persisted(
            project,
            `SELECT text FROM tasks_task_acceptance_criteria WHERE task_id = '${row.id}' ORDER BY ordinal`,
          ),
        ).toBe(JSON.stringify(row.acceptance.map((text) => ({ text }))));
        expect(
          persisted(
            project,
            `SELECT depends_on FROM tasks_task_dependencies WHERE task_id = '${row.id}'`,
          ),
        ).toBe('[{"depends_on":"T001"}]');
      }
      const { scanAcceptanceDrift } = await import('../../doctor/acceptance-drift.js');
      expect(scanAcceptanceDrift(project).entries).toEqual([]);
    }
  });

  it('rejects an update that addresses no row', async () => {
    const a = await createSqliteDataAccessor(projectA);
    await expect(a.updateTaskFields('T404', { title: 'Never persisted' })).rejects.toThrow(
      /not found/i,
    );
  });
});
