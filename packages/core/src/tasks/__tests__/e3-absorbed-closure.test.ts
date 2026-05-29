/**
 * Regression tests for the E3 absorbed-task closure mechanism (T10363).
 *
 * Saga T10288 SG-DOCS-INTEGRITY → Epic T10291 E3-DOCS-CLI-HARDENING
 * declared three pre-existing tasks ABSORBED via `task_relations.type='absorbs'`:
 *
 *   - T10238 (BUG: cleo docs add unknown-flag parser)
 *   - T10153 (cleo docs add ADR auto-numbering)
 *   - T10167 (similarity warn at cleo docs add)
 *
 * When an Epic absorbs a task, the task closes by citing the absorbing
 * Epic's PR as `pr:<n>` evidence (ADR-051 PR atom satisfies BOTH
 * `testsPassed` and `qaPassed` simultaneously per T9764). The absorbs
 * relation MUST survive the closure — it is the audit trail that
 * justifies skipping a per-task PR.
 *
 * This test exercises the closure invariant in-memory: an absorbed task
 * + PR-evidenced gates → status=done, with the absorbs relation still
 * resolvable from the absorbing Epic.
 *
 * @task T10363 — E3.5: close absorbed tasks with PR evidence
 * @epic T10291 — E3-DOCS-CLI-HARDENING
 * @saga T10288 — SG-DOCS-INTEGRITY
 * @see ADR-051 (evidence-based gate ritual)
 * @see PR #581 (T10359 → T10238 closure)
 * @see PR #600 (T10361 → T10167 closure)
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';

describe('E3 absorbed-task closure (T10363)', () => {
  let testDir: string;
  let accessor: Awaited<ReturnType<typeof createSqliteDataAccessor>>;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'cleo-e3-absorbed-'));
    // Pre-create `.cleo/` so resolveCleoDir resolves the temp dir (T11262).
    mkdirSync(join(testDir, '.cleo'), { recursive: true });
    accessor = await createSqliteDataAccessor(testDir);
  });

  afterEach(async () => {
    await accessor.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('preserves the absorbs relation after the absorbed task is marked done', async () => {
    // Seed Epic T10291 + 3 absorbed tasks mirroring the real-world state.
    const now = new Date().toISOString();
    const epic: Task = {
      id: 'T10291',
      title: 'E3-DOCS-CLI-HARDENING',
      type: 'epic',
      status: 'pending',
      priority: 'high',
      createdAt: now,
    };
    const absorbed: Task[] = [
      {
        id: 'T10238',
        title: 'cleo docs add unknown-flag parser bug',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        createdAt: now,
      },
      {
        id: 'T10167',
        title: 'similarity warn at cleo docs add',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        createdAt: now,
      },
      {
        id: 'T10153',
        title: 'ADR auto-numbering at cleo docs add',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        createdAt: now,
      },
    ];

    await accessor.upsertSingleTask(epic);
    for (const t of absorbed) {
      await accessor.upsertSingleTask(t);
      await accessor.addRelation(
        'T10291',
        t.id,
        'absorbs',
        `E3 absorbs ${t.id} via PR-evidenced closure`,
      );
    }

    // Pre-condition: Epic has 3 absorbs relations.
    const epicBefore = await accessor.loadSingleTask('T10291');
    const absorbsBefore = (epicBefore?.relates ?? []).filter((r) => r.type === 'absorbs');
    expect(absorbsBefore).toHaveLength(3);
    expect(new Set(absorbsBefore.map((r) => r.taskId))).toEqual(
      new Set(['T10238', 'T10167', 'T10153']),
    );

    // Simulate closure of two absorbed tasks (T10238 + T10167).
    // T10153 stays pending — its absorbing PR (T10360 E3.2) hadn't shipped
    // when T10363 ran, matching the real-world deferral documented in the
    // T10363 commit message.
    const closeTask = async (id: string): Promise<void> => {
      const t = await accessor.loadSingleTask(id);
      if (!t) throw new Error(`seed task missing: ${id}`);
      await accessor.upsertSingleTask({
        ...t,
        status: 'done',
        completedAt: new Date().toISOString(),
      });
    };
    await closeTask('T10238');
    await closeTask('T10167');

    // Post-condition 1: Closed tasks are done.
    expect((await accessor.loadSingleTask('T10238'))?.status).toBe('done');
    expect((await accessor.loadSingleTask('T10167'))?.status).toBe('done');

    // Post-condition 2: Deferred task stays pending (T10360 still in flight).
    expect((await accessor.loadSingleTask('T10153'))?.status).toBe('pending');

    // Post-condition 3: All 3 absorbs relations on the Epic are PRESERVED.
    // This is the load-bearing invariant — closure must NOT clobber the
    // audit trail that justifies skipping per-task PRs.
    const epicAfter = await accessor.loadSingleTask('T10291');
    const absorbsAfter = (epicAfter?.relates ?? []).filter((r) => r.type === 'absorbs');
    expect(absorbsAfter).toHaveLength(3);
    expect(new Set(absorbsAfter.map((r) => r.taskId))).toEqual(
      new Set(['T10238', 'T10167', 'T10153']),
    );
  });
});
