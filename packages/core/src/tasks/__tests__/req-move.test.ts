/**
 * `cleo req move` (T14200): a criterion moves to another task as its next
 * AC<n>, keeping its uid and history, with an audit row on both tasks; a
 * done target and a criterion with recorded evidence are refused.
 *
 * @task T14200
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CleoError } from '../../errors.js';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { getDb, resetDbState } from '../../store/sqlite.js';
import * as schema from '../../store/tasks-schema.js';
import { addTask } from '../add.js';
import { reqMove } from '../req.js';

describe('reqMove (T14200)', () => {
  let env: TestDbEnv;
  let source: string;
  let target: string;

  async function add(title: string, acceptance: string[]): Promise<string> {
    const result = await addTask(
      {
        title,
        description: `${title} fixture for req move`,
        acceptance,
        skipContainmentInvariant: true,
      },
      env.tempDir,
      env.accessor,
    );
    return result.task.id;
  }

  beforeEach(async () => {
    env = await createTestDb();
    process.env['CLEO_DIR'] = env.cleoDir;
    source = await add('Move source', [
      'source keeps this',
      'this belongs to the other lane',
      'source keeps that',
    ]);
    target = await add('Move target', ['target criterion one']);
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('moves the criterion as the target next AC, keeping its uid and history, audited on both tasks', async () => {
    // A locked source stage: the move is not a weakening, so no reason is needed.
    await env.accessor.updateTaskFields(source, { pipelineStage: 'implementation' });
    const [moving] = (await env.accessor.getAcRows(source)).filter((r) => r.ordinal === 2);
    expect(moving?.uid).toBeTruthy();

    const result = await reqMove(env.tempDir, source, 'ac2', target, { accessor: env.accessor });
    expect(result.from).toMatchObject({ taskId: source, criterion: 'AC2', acId: moving?.id });
    expect(result.to).toMatchObject({ taskId: target, criterion: 'AC2' });
    expect(result.uid).toBe(moving?.uid);

    const sourceTask = await env.accessor.loadSingleTask(source);
    const targetTask = await env.accessor.loadSingleTask(target);
    expect(sourceTask?.acceptance).toEqual(['source keeps this', 'source keeps that']);
    expect(targetTask?.acceptance).toEqual([
      'target criterion one',
      'this belongs to the other lane',
    ]);

    const sourceRows = await env.accessor.getAcRows(source);
    expect(sourceRows.map((r) => r.ordinal)).toEqual([1, 3]);
    const moved = (await env.accessor.getAcRows(target)).find((r) => r.ordinal === 2);
    expect(moved).toMatchObject({ id: result.to.acId, text: 'this belongs to the other lane' });
    expect(moved?.uid).toBe(moving?.uid);

    const db = await getDb(env.tempDir);
    const history = await db
      .select()
      .from(schema.taskAcceptanceCriteriaHistory)
      .where(eq(schema.taskAcceptanceCriteriaHistory.acId, moving?.id ?? ''))
      .all();
    expect(history).toEqual([
      expect.objectContaining({
        reason: 'move',
        acUid: moving?.uid,
        previousText: 'this belongs to the other lane',
      }),
    ]);

    const audit = await env.accessor.queryAuditLog({
      taskIds: [source, target],
      actions: ['ac_moved'],
    });
    expect(audit.map((row) => row.taskId).sort()).toEqual([source, target].sort());
    for (const row of audit)
      expect(JSON.parse(row.detailsJson ?? '{}')).toMatchObject({
        criterion: 'AC2',
        fromTaskId: source,
        toTaskId: target,
        toCriterion: 'AC2',
        acUid: moving?.uid,
      });
    expect(audit.every((row) => typeof row.actor === 'string' && row.actor.length > 0)).toBe(true);
  });

  it('refuses a done target', async () => {
    await env.accessor.updateTaskFields(target, { status: 'done' });
    await expect(
      reqMove(env.tempDir, source, 'AC2', target, { accessor: env.accessor }),
    ).rejects.toThrow(/is done; a criterion moves only between open tasks/);
    expect((await env.accessor.loadSingleTask(source))?.acceptance).toHaveLength(3);
  });

  it('refuses a criterion with recorded evidence bindings', async () => {
    const [bound] = (await env.accessor.getAcRows(source)).filter((r) => r.ordinal === 2);
    const db = await getDb(env.tempDir);
    await db
      .insert(schema.evidenceAcBindings)
      .values({
        id: randomUUID(),
        evidenceAtomId: 'commit:abc1234',
        acId: bound?.id ?? '',
        bindingType: 'direct',
      })
      .run();
    const move = reqMove(env.tempDir, source, 'AC2', target, { accessor: env.accessor });
    await expect(move).rejects.toBeInstanceOf(CleoError);
    await expect(move).rejects.toThrow(/recorded evidence binding/);
    expect((await env.accessor.loadSingleTask(target))?.acceptance).toEqual([
      'target criterion one',
    ]);
  });
});
