/**
 * `cleo done --plan` / `cleo verify --auto` and `cleo complete` agree on an
 * epic (T14073): the plan names what completion would still refuse — an
 * unfinished child, or a criterion with no evidence and the write that binds
 * it — and says `cleo complete` only when completion accepts the epic.
 *
 * @task T14073
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { getDb, resetDbState } from '../../store/sqlite.js';
import * as schema from '../../store/tasks-schema.js';
import { computeAcCoverage } from '../ac-coverage-gate.js';
import { addTask } from '../add.js';
import { deriveTaskEvidence } from '../done-plan.js';

let env: TestDbEnv;
let accessor: DataAccessor;

beforeEach(async () => {
  env = await createTestDb();
  accessor = env.accessor;
  process.env['CLEO_DIR'] = env.cleoDir;
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  resetDbState();
  await env.cleanup();
});

async function epicWithChild(): Promise<{ epicId: string; childId: string }> {
  const epic = await addTask(
    {
      title: 'Plan epic',
      description: 'Plan epic — seeded fixture for T14073',
      type: 'epic',
      acceptance: ['Epic outcome is proven'],
      skipContainmentInvariant: true,
    },
    env.tempDir,
    accessor,
  );
  const child = await addTask(
    {
      title: 'Plan child',
      description: 'Plan child — seeded fixture for T14073',
      acceptance: ['Child outcome'],
      parentId: epic.task.id,
      skipContainmentInvariant: true,
    },
    env.tempDir,
    accessor,
  );
  return { epicId: epic.task.id, childId: child.task.id };
}

async function finish(taskId: string): Promise<void> {
  const task = await accessor.loadSingleTask(taskId);
  if (!task) throw new Error(`${taskId} missing`);
  await accessor.upsertSingleTask({ ...task, status: 'done', pipelineStage: 'contribution' });
}

describe('epic plan agrees with completion (T14073)', () => {
  it('an unfinished child is named as the next step', async () => {
    const { epicId, childId } = await epicWithChild();
    const plan = await deriveTaskEvidence(epicId, { projectRoot: env.tempDir });
    expect(plan.ready).toBe(false);
    expect(plan.blockers[0]?.message).toContain(`${childId} is not done`);
    expect(plan.next?.command).toBe(`cleo show ${childId}`);
  });

  it('with the child done, the epic own criterion is named with the write that binds it', async () => {
    const { epicId, childId } = await epicWithChild();
    await finish(childId);
    const plan = await deriveTaskEvidence(epicId, { projectRoot: env.tempDir });
    const alias = (await accessor.getAcRows(epicId)).find(
      (r) => r.text === 'Epic outcome is proven',
    );
    expect(alias).toBeDefined();
    const binding = `satisfies:${epicId}#AC${alias?.ordinal}`;
    expect(plan.blockers[0]?.message).toContain(`AC${alias?.ordinal}`);
    expect(plan.next?.command).toContain(`cleo verify ${epicId} --gate implemented`);
    expect(plan.next?.command).toContain(binding);
    expect(plan.commands).toHaveLength(1);
  });

  it('once every criterion is covered, the plan says cleo complete, and coverage agrees', async () => {
    const { epicId, childId } = await epicWithChild();
    await finish(childId);
    const own = (await accessor.getAcRows(epicId)).find((r) => r.text === 'Epic outcome is proven');
    if (!own) throw new Error('epic criterion missing');
    const db = await getDb(env.tempDir);
    await db
      .insert(schema.evidenceAcBindings)
      .values({
        id: randomUUID(),
        evidenceAtomId: 'commit:abc123',
        acId: own.id,
        bindingType: 'direct',
      })
      .run();
    expect((await computeAcCoverage(epicId, accessor)).ok).toBe(true);
    const plan = await deriveTaskEvidence(epicId, { projectRoot: env.tempDir });
    expect(plan.next?.command).toBe(`cleo complete ${epicId}`);
    expect(plan.commands).toEqual([`cleo complete ${epicId}`]);
  });
});
