/**
 * Regression test for GH #401 / T9839 — severity P0 silent downgrade.
 *
 * BUG (pre-fix): `cleo update <id> --severity P0` returned `success:true`
 * with `task.severity:"P0"` in the response envelope, but the underlying
 * SQLite row was unchanged (still showed `P1`). The same defect affected
 * the `kind` and `scope` orthogonal axes added by T944 / T9072.
 *
 * ROOT CAUSE: `upsertTask` in `store/db-helpers.ts` builds an
 * `onConflictDoUpdate({ set })` clause that EXPLICITLY lists every column
 * the UPDATE branch is allowed to touch. The `kind` (DB col `role`),
 * `scope`, and `severity` columns were never appended to that list, so
 * UPDATE silently dropped those fields. INSERT carried them via the
 * `values` object (`taskToRow` returns them), which is why a freshly
 * `cleo add`-ed task showed the right severity — only updates to an
 * existing row were affected.
 *
 * The fix adds `kind`, `scope`, and `severity` to the `set` object. These
 * tests guard against regression by exercising the full `updateTask` path
 * and then re-reading the row via `loadSingleTask` to confirm the DB
 * state matches the response envelope.
 *
 * @task T9839
 * @issue gh-401
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { updateTask } from '../update.js';

describe('updateTask — orthogonal axes persistence (GH #401 / T9839)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeFile(
      join(env.cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: {
          session: { requiredForMutate: false },
          acceptance: { mode: 'off' },
        },
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

  describe('severity', () => {
    it('persists P1 -> P0 escalation to the DB (response envelope MUST match DB state)', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task with P1 severity',
          status: 'pending',
          priority: 'medium',
          severity: 'P1',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask({ taskId: 'T001', severity: 'P0' }, env.tempDir, accessor);

      // Response envelope claim
      expect(result.task.severity).toBe('P0');
      expect(result.changes).toContain('severity');

      // GH #401 invariant — DB state matches the response envelope
      const reloaded = await accessor.loadSingleTask('T001');
      expect(reloaded?.severity).toBe('P0');
    });

    it('persists P0 -> P1 de-escalation (no attestation required on write path)', async () => {
      await seedTasks(accessor, [
        {
          id: 'T002',
          title: 'P0 task being de-escalated',
          status: 'pending',
          priority: 'high',
          severity: 'P0',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask({ taskId: 'T002', severity: 'P1' }, env.tempDir, accessor);

      expect(result.task.severity).toBe('P1');
      const reloaded = await accessor.loadSingleTask('T002');
      expect(reloaded?.severity).toBe('P1');
    });

    it('persists severity on a task that previously had none (null -> P2)', async () => {
      await seedTasks(accessor, [
        {
          id: 'T003',
          title: 'Task with no severity',
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        },
      ]);

      // Sanity check the seed
      const seeded = await accessor.loadSingleTask('T003');
      expect(seeded?.severity).toBeUndefined();

      const result = await updateTask({ taskId: 'T003', severity: 'P2' }, env.tempDir, accessor);
      expect(result.task.severity).toBe('P2');
      const reloaded = await accessor.loadSingleTask('T003');
      expect(reloaded?.severity).toBe('P2');
    });

    it('preserves severity when updating unrelated fields (kind/scope/severity not in set clause regression-guard)', async () => {
      await seedTasks(accessor, [
        {
          id: 'T004',
          title: 'P0 task',
          status: 'pending',
          priority: 'high',
          severity: 'P0',
          createdAt: new Date().toISOString(),
        },
      ]);

      // Update title only — severity must remain P0
      await updateTask({ taskId: 'T004', title: 'P0 task (renamed)' }, env.tempDir, accessor);
      const reloaded = await accessor.loadSingleTask('T004');
      expect(reloaded?.title).toBe('P0 task (renamed)');
      expect(reloaded?.severity).toBe('P0');
    });
  });

  describe('kind (T944 / DB col role) — same defect class as severity', () => {
    it('persists kind change to the DB (work -> bug)', async () => {
      await seedTasks(accessor, [
        {
          id: 'T010',
          title: 'Work task being reclassified',
          status: 'pending',
          priority: 'medium',
          kind: 'work',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask({ taskId: 'T010', kind: 'bug' }, env.tempDir, accessor);
      expect(result.task.kind).toBe('bug');
      expect(result.changes).toContain('kind');

      const reloaded = await accessor.loadSingleTask('T010');
      expect(reloaded?.kind).toBe('bug');
    });
  });

  describe('scope (T944) — same defect class as severity', () => {
    it('persists scope change to the DB (feature -> project)', async () => {
      await seedTasks(accessor, [
        {
          id: 'T020',
          title: 'Feature-scoped task',
          status: 'pending',
          priority: 'medium',
          scope: 'feature',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask({ taskId: 'T020', scope: 'project' }, env.tempDir, accessor);
      expect(result.task.scope).toBe('project');
      expect(result.changes).toContain('scope');

      const reloaded = await accessor.loadSingleTask('T020');
      expect(reloaded?.scope).toBe('project');
    });
  });

  describe('combined orthogonal axes — multi-field update persists every field', () => {
    it('updates kind+scope+severity in a single call and persists all three', async () => {
      await seedTasks(accessor, [
        {
          id: 'T030',
          title: 'Triple-axis update',
          status: 'pending',
          priority: 'medium',
          kind: 'work',
          scope: 'feature',
          severity: 'P3',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T030', kind: 'bug', scope: 'project', severity: 'P0' },
        env.tempDir,
        accessor,
      );
      expect(result.task.kind).toBe('bug');
      expect(result.task.scope).toBe('project');
      expect(result.task.severity).toBe('P0');

      const reloaded = await accessor.loadSingleTask('T030');
      expect(reloaded?.kind).toBe('bug');
      expect(reloaded?.scope).toBe('project');
      expect(reloaded?.severity).toBe('P0');
    });
  });
});
