/**
 * `cleo doctor --coherence` reports existing violations of the T12883 rules:
 * a terminal parent over a live (incl. blocked) child (R1), a done task whose
 * acceptance criteria have no evidence (R2), and a child its parent's type
 * cannot contain (R4).
 *
 * @task T12883
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../../tasks/add.js';
import { coreCoherenceCheck, DONE_WITHOUT_AC_SAMPLE } from '../validate-ops.js';

let env: TestDbEnv;
const createdAt = new Date().toISOString();

beforeEach(async () => {
  env = await createTestDb();
  process.env['CLEO_DIR'] = env.cleoDir;
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  resetDbState();
  await env.cleanup();
});

describe('coreCoherenceCheck reports T12883 violations', () => {
  it('flags a cancelled parent over a blocked child, a done task without AC evidence, and a type-matrix violation', async () => {
    await seedTasks(env.accessor, [
      {
        id: 'T1',
        title: 'Cancelled epic',
        type: 'epic',
        status: 'cancelled',
        pipelineStage: 'cancelled',
        priority: 'medium',
        createdAt,
      },
      {
        id: 'T2',
        title: 'Blocked child',
        type: 'task',
        status: 'blocked',
        priority: 'medium',
        parentId: 'T1',
        createdAt,
      },
      {
        id: 'T3',
        title: 'Live epic',
        type: 'epic',
        status: 'pending',
        priority: 'medium',
        createdAt,
      },
      {
        id: 'T4',
        title: 'Subtask straight under an epic',
        type: 'subtask',
        status: 'pending',
        priority: 'medium',
        parentId: 'T3',
        createdAt,
      },
    ]);
    const done = (
      await addTask(
        {
          title: 'Done without evidence',
          description: 'Done without evidence — fixture for T12883 doctor',
          acceptance: ['Outcome is proven'],
          skipContainmentInvariant: true,
        },
        env.tempDir,
        env.accessor,
      )
    ).task;
    const stored = await env.accessor.loadSingleTask(done.id);
    if (!stored) throw new Error('fixture missing');
    await env.accessor.upsertSingleTask({
      ...stored,
      status: 'done',
      pipelineStage: 'contribution',
    });

    const { issues } = await coreCoherenceCheck(env.tempDir);
    const of = (type: string) => issues.filter((i) => i.type === type).map((i) => i.taskId);
    expect(of('status_inconsistency')).toContain('T2');
    expect(of('done_without_ac_evidence')).toContain(done.id);
    expect(of('type_matrix_violation')).toContain('T4');
  });

  it('stays bounded with many legacy done tasks: a sample of the newest, plus one summary holding every id', async () => {
    const total = DONE_WITHOUT_AC_SAMPLE + 15;
    const ids: string[] = [];
    for (let i = 0; i < total; i++) {
      const task = (
        await addTask(
          {
            title: `Legacy done ${i}`,
            description: `Legacy done ${i} — fixture for the bounded doctor report`,
            acceptance: ['Outcome is proven'],
            skipContainmentInvariant: true,
          },
          env.tempDir,
          env.accessor,
        )
      ).task;
      const stored = await env.accessor.loadSingleTask(task.id);
      if (!stored) throw new Error('fixture missing');
      const completedAt = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
      await env.accessor.upsertSingleTask({
        ...stored,
        status: 'done',
        pipelineStage: 'contribution',
        completedAt,
      });
      ids.push(task.id);
    }

    const { issues } = await coreCoherenceCheck(env.tempDir);
    const listed = issues.filter((i) => i.type === 'done_without_ac_evidence');
    expect(listed).toHaveLength(DONE_WITHOUT_AC_SAMPLE);
    // The newest come first.
    expect(listed[0]?.taskId).toBe(ids[total - 1]);
    const summary = issues.filter((i) => i.type === 'done_without_ac_evidence_total');
    expect(summary).toHaveLength(1);
    expect(summary[0]?.taskIds?.sort()).toEqual([...ids].sort());
    expect(summary[0]?.message).toContain(`${total} done tasks`);
  });
});
