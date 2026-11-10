/**
 * The `ivtr_state` retire migration (T14311, owner decision D11174).
 *
 * The migration runs on a COPY of a store that still carries IVTR state: the
 * copy archives each row's state into `tasks_audit_log`, drops the column,
 * and leaves the original store untouched. A task whose stale state froze it
 * at `implement` (the old `E_IVTR_INCOMPLETE` refusal) then completes in
 * strict mode.
 *
 * Set `CLEO_T14311_STORE_COPY=<path to a cleo.db snapshot>` to run the same
 * migration on a copy of a real store instead of the seeded one.
 *
 * @task T14311
 */

import { copyFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeTaskStrict } from '../../tasks/complete.js';
import { getNativeTasksDb, resetDbState } from '../sqlite.js';
import { createSqliteDataAccessor } from '../sqlite-data-accessor.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

const MIGRATION = 't14311-retire-ivtr-state';

/** IVTR state the retired loop left behind: frozen at `implement`. */
const STALE_STATE = JSON.stringify({
  taskId: 'T001',
  schemaVersion: 2,
  currentPhase: 'implement',
  phaseHistory: [
    {
      phase: 'implement',
      agentIdentity: null,
      startedAt: '2026-04-01T00:00:00.000Z',
      completedAt: null,
      passed: null,
      evidenceRefs: [],
    },
  ],
  startedAt: '2026-04-01T00:00:00.000Z',
  loopBackCount: { implement: 0, validate: 0, audit: 0, test: 0, released: 0 },
});

/** Column names of `tasks_tasks` in the store at `dbPath`. */
function taskColumns(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare('PRAGMA table_info(tasks_tasks)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
  } finally {
    db.close();
  }
}

describe('ivtr_state retire migration on a store copy (T14311)', () => {
  let env: TestDbEnv;
  let copyRoot: string;
  const previousCleoDir = process.env['CLEO_DIR'];
  const previousCleoHome = process.env['CLEO_HOME'];

  beforeEach(async () => {
    env = await createTestDb();
    copyRoot = mkdtempSync(join(tmpdir(), 'cleo-t14311-copy-'));
  });

  afterEach(async () => {
    resetDbState();
    process.env['CLEO_DIR'] = env.cleoDir;
    process.env['CLEO_HOME'] = join(env.tempDir, '.cleo-home');
    await env.cleanup();
    if (previousCleoDir === undefined) delete process.env['CLEO_DIR'];
    else process.env['CLEO_DIR'] = previousCleoDir;
    if (previousCleoHome === undefined) delete process.env['CLEO_HOME'];
    else process.env['CLEO_HOME'] = previousCleoHome;
    rmSync(copyRoot, { recursive: true, force: true });
  });

  it('archives the state, drops the column on the copy only, and the task completes', async () => {
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Frozen by IVTR', status: 'pending', priority: 'medium' },
      { id: 'T002', title: 'Never had IVTR', status: 'pending', priority: 'medium' },
    ]);
    const native = getNativeTasksDb(env.tempDir);
    if (!native) throw new Error('no native handle');
    // Rewind the store to an older build's shape: the column exists and T001
    // carries stale state; the retire migration has not run.
    native.exec('ALTER TABLE tasks_tasks ADD COLUMN ivtr_state TEXT');
    native
      .prepare(
        "UPDATE tasks_tasks SET ivtr_state = ?, verification_json = ?, updated_at = '2026-04-02T00:00:00.000Z' WHERE id = 'T001'",
      )
      .run(
        STALE_STATE,
        JSON.stringify({
          passed: true,
          round: 1,
          gates: { implemented: true, testsPassed: true, qaPassed: true },
          failureLog: [],
        }),
      );
    native.prepare(`DELETE FROM __drizzle_migrations WHERE name LIKE '%${MIGRATION}'`).run();
    await env.accessor.close();
    resetDbState();

    // The store copy: the whole project, so its identity and config come along.
    const project = join(copyRoot, 'project');
    cpSync(env.tempDir, project, { recursive: true });
    const realCopy = process.env['CLEO_T14311_STORE_COPY'];
    if (realCopy) copyFileSync(realCopy, join(project, '.cleo', 'cleo.db'));
    process.env['CLEO_DIR'] = join(project, '.cleo');
    process.env['CLEO_HOME'] = join(project, '.cleo-home');

    const migrated = await createSqliteDataAccessor(project);
    await migrated.close();
    resetDbState();

    expect(taskColumns(join(project, '.cleo', 'cleo.db'))).not.toContain('ivtr_state');
    // The original store is untouched.
    expect(taskColumns(join(env.cleoDir, 'cleo.db'))).toContain('ivtr_state');
    if (realCopy) return;

    const copy = new DatabaseSync(join(project, '.cleo', 'cleo.db'), { readOnly: true });
    try {
      const audit = copy
        .prepare(
          "SELECT id, task_id, timestamp, before_json, after_json FROM tasks_audit_log WHERE action = 'task_ivtr_state_retired' ORDER BY id",
        )
        .all() as Array<Record<string, string>>;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        id: `${MIGRATION}-T001`,
        task_id: 'T001',
        timestamp: '2026-04-02T00:00:00.000Z',
      });
      expect(JSON.parse(audit[0]?.before_json ?? '{}')).toEqual({ ivtrState: STALE_STATE });
      expect(JSON.parse(audit[0]?.after_json ?? '{}')).toEqual({ ivtrState: null });
    } finally {
      copy.close();
    }

    // Strict mode used to refuse T001 with E_IVTR_INCOMPLETE; now it completes.
    writeFileSync(
      join(project, '.cleo', 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
        lifecycle: { mode: 'strict' },
        verification: { enabled: false },
      }),
    );
    const result = await completeTaskStrict(project, 'T001');
    expect(result.error?.code).toBeUndefined();
    expect(result.success).toBe(true);
    if (result.success) expect(result.data?.task.status).toBe('done');
    resetDbState();
  });
});
