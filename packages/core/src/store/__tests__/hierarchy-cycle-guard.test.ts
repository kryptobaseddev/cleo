/**
 * Cycle guards on the recursive hierarchy walks, and the write that refuses a
 * self-edge in the first place.
 *
 * `getAncestorChain` and `getSubtree` are raw `WITH RECURSIVE` CTEs. Before
 * T12307 none of them carried a termination guard, so a single row whose
 * `parent_id` equalled its own `id` recursed forever. SQLite materialises that
 * in NATIVE memory, which `--max-old-space-size` does not bound, so the
 * observable symptom was not a heap error but a silent machine death: five CI
 * runs lost to `exit 143` "the runner has received a shutdown signal", and
 * three developer-workstation OOM freezes.
 *
 * Both production triggers miss the self-edge on INSERT.
 * `tasks_parent_type_matrix_insert` and `tasks_parent_cycle_guard_insert` each
 * resolve the parent with `WHERE parent.id = NEW.parent_id`, which matches
 * nothing while that very row is being inserted, so their `WHEN` clauses are
 * vacuously false. A multi-node cycle IS caught, because those parents exist.
 * That is why the self-edge is the only shape that needs a new write guard, and
 * why the CTE tests below have to inject theirs with raw SQL: the guard now
 * refuses it through the accessor, but a store written before the guard can
 * still contain one.
 *
 * A warning for whoever changes these CTEs next: the per-test timeouts below do
 * NOT save you. Measured by reverting the guard and re-running this file — the
 * run was killed at a 300s wall with exit 143, the exact CI signature, and
 * vitest's 15s `testTimeout` never fired. The hang is inside a SYNCHRONOUS
 * native SQLite call, and no JS timer can interrupt one. So these tests do not
 * convert a regression into a fast red assertion; they hang exactly like
 * production did. The timeouts are a floor, not a safety net. The real
 * protections are the CTE guards themselves and the write-side refusal.
 *
 * @task T12307
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

/** A regression must go red fast, not hang. */
const GUARD_TIMEOUT_MS = 15_000;

describe('hierarchy containment cycles are refused and survivable (T12307)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  /**
   * Write a self-parented row straight past the accessor guard and the
   * triggers, reproducing a store persisted before either existed.
   */
  function injectSelfParentedRow(templateId: string, newId: string): void {
    const db = new DatabaseSync(join(env.cleoDir, 'cleo.db'));
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      // Clone a real row so every NOT NULL column is populated, then INSERT it.
      // The INSERT path is the actual production hole: both triggers resolve the
      // parent with `WHERE parent.id = NEW.parent_id`, which matches nothing
      // while this row is being inserted. An UPDATE would be caught, because by
      // then the row exists — which is exactly the asymmetry under test.
      db.exec('CREATE TEMP TABLE self_edge_seed AS SELECT * FROM tasks_tasks WHERE id IS NULL');
      db.prepare('INSERT INTO self_edge_seed SELECT * FROM tasks_tasks WHERE id = ?').run(
        templateId,
      );
      db.prepare('UPDATE self_edge_seed SET id = ?, parent_id = ?').run(newId, newId);
      db.exec('INSERT INTO tasks_tasks SELECT * FROM self_edge_seed');
      db.exec('DROP TABLE self_edge_seed');
    } finally {
      db.close();
    }
  }

  it(
    'the accessor refuses to write a task that parents itself',
    async () => {
      await expect(
        seedTasks(env.accessor, [
          { id: 'T1', title: 'self', type: 'task', parentId: 'T1', status: 'pending' },
        ]),
      ).rejects.toThrow(/E_TASK_PARENT_SELF/);
    },
    GUARD_TIMEOUT_MS,
  );

  it(
    'getAncestorChain returns instead of recursing forever on a pre-existing self-edge',
    async () => {
      await seedTasks(env.accessor, [
        { id: 'T1', title: 'saga', type: 'saga', status: 'pending' },
        { id: 'T2', title: 'epic', type: 'epic', parentId: 'T1', status: 'pending' },
      ]);
      injectSelfParentedRow('T2', 'SELF1');

      const chain = await env.accessor.getAncestorChain('SELF1');

      // The guard stops at the first revisit; it does not invent an empty result.
      expect(chain.map((t) => t.id)).toEqual(['SELF1']);
    },
    GUARD_TIMEOUT_MS,
  );

  it(
    'getSubtree returns instead of recursing forever on a pre-existing self-edge',
    async () => {
      await seedTasks(env.accessor, [
        { id: 'T1', title: 'saga', type: 'saga', status: 'pending' },
        { id: 'T2', title: 'epic', type: 'epic', parentId: 'T1', status: 'pending' },
      ]);
      injectSelfParentedRow('T2', 'SELF1');

      const subtree = await env.accessor.getSubtree('SELF1');

      expect(subtree.map((t) => t.id)).toEqual(['SELF1']);
    },
    GUARD_TIMEOUT_MS,
  );

  it(
    'the guards do NOT truncate a legitimate full-depth chain',
    async () => {
      // saga -> epic -> task -> subtask is the deepest chain the containment
      // matrix admits. A depth cap would have shortened this; the cycle guard
      // must not. This is the half that makes the fix worth anything.
      await seedTasks(env.accessor, [
        { id: 'T1', title: 'saga', type: 'saga', status: 'pending' },
        { id: 'T2', title: 'epic', type: 'epic', parentId: 'T1', status: 'pending' },
        { id: 'T3', title: 'task', type: 'task', parentId: 'T2', status: 'pending' },
        { id: 'T4', title: 'subtask', type: 'subtask', parentId: 'T3', status: 'pending' },
      ]);

      // Outermost ancestor first.
      const chain = await env.accessor.getAncestorChain('T4');
      expect(chain.map((t) => t.id)).toEqual(['T1', 'T2', 'T3']);

      const subtree = await env.accessor.getSubtree('T1');
      expect(subtree.map((t) => t.id).sort()).toEqual(['T1', 'T2', 'T3', 'T4']);
    },
    GUARD_TIMEOUT_MS,
  );
});
