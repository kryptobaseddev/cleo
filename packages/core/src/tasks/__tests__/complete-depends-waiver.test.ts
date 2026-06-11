/**
 * Dependency-gate completion semantics — T11954 / DHQ-071.
 *
 * Covers three behaviours of the `cleo complete` dependency gate:
 *
 *  1. Terminal-status deps (done / cancelled / archived) NEVER block completion
 *     — verified against the canonical `TERMINAL_TASK_STATUSES` SSoT (so a dep
 *     that is already closed cannot be "flagged stale" and block).
 *  2. A genuinely non-terminal dep blocks with `E_CLEO_DEPENDENCY`, surfacing
 *     each offending dep WITH its current status in `error.details.unresolvedDeps`
 *     and offering the one-shot `--waive-depends` override in `error.fix`.
 *  3. Supplying `waiveDependsReason` (the `--waive-depends` flag) allows
 *     completion over a stale/over-specified edge and writes an audit row to
 *     `.cleo/audit/depends-waiver.jsonl`.
 *
 * @task T11954
 * @epic T11679
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { completeTask } from '../complete.js';

const permissiveConfig = JSON.stringify({
  enforcement: {
    session: { requiredForMutate: false },
    acceptance: { mode: 'off' },
  },
  lifecycle: { mode: 'off' },
  verification: { enabled: false },
});

const now = new Date().toISOString();

/** Build a flat task fixture with optional depends/status. */
function makeTask(
  id: string,
  opts: {
    status?: 'pending' | 'active' | 'blocked' | 'done' | 'cancelled' | 'archived';
    depends?: string[];
  } = {},
) {
  return {
    id,
    title: `Task ${id}`,
    type: 'task' as const,
    status: opts.status ?? 'pending',
    priority: 'medium' as const,
    createdAt: now,
    updatedAt: now,
    ...(opts.depends ? { depends: opts.depends } : {}),
    ...(opts.status === 'done' ? { completedAt: now } : {}),
  };
}

describe('T11954: cleo complete dependency-gate waiver (DHQ-071)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeFile(join(env.cleoDir, 'config.json'), permissiveConfig);
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('does NOT block completion on a done dependency', async () => {
    await seedTasks(accessor, [
      makeTask('T001', { status: 'done' }),
      makeTask('T002', { depends: ['T001'] }),
    ]);

    const result = await completeTask({ taskId: 'T002' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });

  it('does NOT block completion on a cancelled dependency (closed but "stale")', async () => {
    await seedTasks(accessor, [
      makeTask('T001', { status: 'cancelled' }),
      makeTask('T002', { depends: ['T001'] }),
    ]);

    const result = await completeTask({ taskId: 'T002' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });

  it('does NOT block when the dependency reference is to a deleted/missing task', async () => {
    // T999 is never seeded — loadTasks returns no row for it, so it must not
    // be treated as an unresolved blocker.
    await seedTasks(accessor, [makeTask('T002', { depends: ['T999'] })]);

    const result = await completeTask({ taskId: 'T002' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });

  it('BLOCKS on a non-terminal dep, surfacing the dep + status + override hint', async () => {
    await seedTasks(accessor, [
      makeTask('T001', { status: 'pending' }),
      makeTask('T002', { depends: ['T001'] }),
    ]);

    await expect(completeTask({ taskId: 'T002' }, env.tempDir, accessor)).rejects.toMatchObject({
      code: ExitCode.DEPENDENCY_ERROR,
      message: expect.stringContaining('T001'),
      details: {
        unresolvedDeps: expect.arrayContaining([{ id: 'T001', status: 'pending' }]),
      },
    });

    await expect(completeTask({ taskId: 'T002' }, env.tempDir, accessor)).rejects.toMatchObject({
      fix: expect.stringContaining('--waive-depends'),
    });

    const t002 = await accessor.loadSingleTask('T002');
    expect(t002?.status).not.toBe('done');
  });

  it('ALLOWS completion when waiveDependsReason is supplied', async () => {
    await seedTasks(accessor, [
      makeTask('T001', { status: 'blocked' }),
      makeTask('T002', { depends: ['T001'] }),
    ]);

    const result = await completeTask(
      { taskId: 'T002', waiveDependsReason: 'edge over-specified — T002 work is done' },
      env.tempDir,
      accessor,
    );
    expect(result.task.status).toBe('done');
  });

  it('writes the waiver to .cleo/audit/depends-waiver.jsonl', async () => {
    await seedTasks(accessor, [
      makeTask('T001', { status: 'active' }),
      makeTask('T002', { depends: ['T001'] }),
    ]);

    await completeTask(
      { taskId: 'T002', waiveDependsReason: 'incident-77 stale edge' },
      env.tempDir,
      accessor,
    );

    const auditPath = join(env.tempDir, '.cleo', 'audit', 'depends-waiver.jsonl');
    const raw = await readFile(auditPath, 'utf8');
    const entries = raw
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as {
            taskId: string;
            unresolvedDeps: Array<{ id: string; status: string }>;
            waiverReason: string;
            timestamp: string;
            agent: string;
          },
      );

    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.taskId).toBe('T002');
    expect(entry?.unresolvedDeps).toContainEqual({ id: 'T001', status: 'active' });
    expect(entry?.waiverReason).toBe('incident-77 stale edge');
    expect(entry?.timestamp).toBeTruthy();
    expect(entry?.agent).toBeTruthy();
  });

  it('does NOT write an audit row when the gate blocks (no waiver)', async () => {
    await seedTasks(accessor, [
      makeTask('T001', { status: 'pending' }),
      makeTask('T002', { depends: ['T001'] }),
    ]);

    await expect(completeTask({ taskId: 'T002' }, env.tempDir, accessor)).rejects.toMatchObject({
      code: ExitCode.DEPENDENCY_ERROR,
    });

    const auditPath = join(env.tempDir, '.cleo', 'audit', 'depends-waiver.jsonl');
    await expect(readFile(auditPath, 'utf8')).rejects.toThrow();
  });
});
