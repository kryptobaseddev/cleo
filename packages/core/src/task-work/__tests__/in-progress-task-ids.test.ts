/**
 * The worktree-protection set (T14268, owner decision D11230): a task is in
 * progress while its claim lease is live, and a session's focus keeps it so
 * when the lease lapses mid-run; the lease is read against the one claim clock.
 *
 * @task T14268
 */

import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { getNativeTasksDb } from '../../store/sqlite.js';
import {
  claimClockNow,
  isLiveClaim,
  leaseExpiresAtFrom,
  setClaimClock,
} from '../../store/task-claim.js';
import { inProgressTaskIds } from '../claims.js';

const T0 = Date.parse('2026-11-05T12:00:00.000Z');
const MINUTE = 60_000;

const task = (id: string, status: Task['status'] = 'pending'): Task =>
  ({
    id,
    title: `Seed ${id}`,
    type: 'task',
    status,
    priority: 'medium',
    acceptance: [],
    createdAt: new Date(T0).toISOString(),
  }) as Task;

describe('inProgressTaskIds (T14268)', () => {
  let env: TestDbEnv;
  let clock = T0;

  beforeEach(async () => {
    env = await createTestDb();
    clock = T0;
    setClaimClock(() => clock);
  });

  afterEach(async () => {
    setClaimClock(null);
    await env.cleanup();
  });

  it('keeps live leases and focused tasks; a lease that lapses mid-run keeps its focused worktree', async () => {
    await seedTasks(env.accessor, [
      task('T0001'),
      task('T0002'),
      task('T0003'),
      task('T0004', 'active'),
      task('T0005'),
    ]);
    const db = getNativeTasksDb(env.tempDir);
    if (!db) throw new Error('native db not open');
    const lease = (id: string, session: string) =>
      db
        .prepare(
          `UPDATE tasks_tasks SET claimed_by_session = ?, claimed_at = ?, lease_expires_at = ?
            WHERE id = ?`,
        )
        .run(session, claimClockNow(), leaseExpiresAtFrom(claimClockNow(), MINUTE), id);
    db.prepare(
      `INSERT INTO tasks_sessions (id, name, status, current_task) VALUES
         ('ses_worker', 'worker', 'active', 'T0002'), ('ses_gone', 'gone', 'ended', 'T0005')`,
    ).run();
    lease('T0001', 'ses_other');
    lease('T0002', 'ses_worker');
    lease('T0003', 'ses_lapsed');

    // T0004 is still stored active until the retirement migration.
    expect([...(await inProgressTaskIds(env.tempDir))].sort()).toEqual([
      'T0001',
      'T0002',
      'T0003',
      'T0004',
    ]);

    // Two minutes on: every lease lapsed with no write. The worker's focus
    // still protects T0002; T0003 (no focus) and T0005 (ended session) do not.
    clock = T0 + 2 * MINUTE;
    const claim = (await env.accessor.loadSingleTask('T0002'))?.claim;
    expect(isLiveClaim(claim)).toBe(false);
    expect([...(await inProgressTaskIds(env.tempDir))].sort()).toEqual(['T0002', 'T0004']);
  });
});
