/**
 * T12693 (owner decision D11161) — agents may change a task's ranking inputs
 * (priority, severity, kind, depends) directly, with an audit trail: every
 * such change records actor, session and reason plus before/after, in the
 * same write; `cleo history ranking` lists them; one command reverts one.
 *
 * @task T12693
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainWarnings } from '../../output.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { deleteTask } from '../delete.js';
import {
  listRankingHistory,
  RANKING_CHANGED_ACTION,
  revertRankingChange,
} from '../ranking-audit.js';
import { updateTask } from '../update.js';

let env: TestDbEnv;
let accessor: DataAccessor;

beforeEach(async () => {
  env = await createTestDb();
  accessor = env.accessor;
  vi.stubEnv('CLEO_DIR', env.cleoDir);
  vi.stubEnv('CLEO_AGENT_ID', 'agent-ranker');
  vi.stubEnv('CLEO_SESSION_ID', 'ses_ranker');
  await writeFile(
    join(env.cleoDir, 'config.json'),
    JSON.stringify({
      enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    }),
  );
  await seedTasks(accessor, [
    { id: 'T001', title: 'Ranked', status: 'pending', priority: 'medium' },
    { id: 'T002', title: 'Prerequisite', status: 'pending', priority: 'low' },
    { id: 'T003', title: 'Another', status: 'pending', priority: 'low' },
  ]);
  drainWarnings();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await env.cleanup();
});

const history = (id: string) => listRankingHistory(id, env.tempDir);

describe('every ranking-input change is audited', () => {
  it('priority: actor, session, reason and before/after, in one row', async () => {
    await updateTask(
      { taskId: 'T001', priority: 'high', reason: 'blocks the release' },
      env.tempDir,
      accessor,
    );
    const [entry, ...rest] = await history('T001');
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      taskId: 'T001',
      actor: 'agent-ranker',
      sessionId: 'ses_ranker',
      reason: 'blocks the release',
      source: 'update',
      fields: ['priority'],
      before: { priority: 'medium' },
      after: { priority: 'high' },
    });
  });

  it('severity, kind and depends are ranking inputs too', async () => {
    await updateTask(
      { taskId: 'T001', severity: 'P1', kind: 'bug', addDepends: ['T002'], reason: 'triage' },
      env.tempDir,
      accessor,
    );
    const [entry] = await history('T001');
    expect(entry?.fields).toEqual(['severity', 'kind', 'depends']);
    expect(entry?.after).toMatchObject({ severity: 'P1', kind: 'bug', depends: ['T002'] });
  });

  it('a change to anything else writes no ranking row', async () => {
    await updateTask({ taskId: 'T001', title: 'Renamed' }, env.tempDir, accessor);
    expect(await history('T001')).toEqual([]);
  });

  it('a human change is attributed to `human`', async () => {
    vi.stubEnv('CLEO_AGENT_ID', '');
    await updateTask({ taskId: 'T001', priority: 'low' }, env.tempDir, accessor);
    expect((await history('T001'))[0]?.actor).toBe('human');
  });

  it('an agent that gives no reason is asked for one', async () => {
    await updateTask({ taskId: 'T001', priority: 'high' }, env.tempDir, accessor);
    expect(drainWarnings()?.map((w) => w.code)).toContain('W_RANKING_REASON_MISSING');
    await updateTask({ taskId: 'T001', priority: 'low', reason: 'why' }, env.tempDir, accessor);
    expect(drainWarnings()?.map((w) => w.code) ?? []).not.toContain('W_RANKING_REASON_MISSING');
  });

  it("deleting a prerequisite audits the dependent's depends change", async () => {
    await updateTask(
      { taskId: 'T001', addDepends: ['T002'], reason: 'order' },
      env.tempDir,
      accessor,
    );
    await deleteTask({ taskId: 'T002', force: true }, env.tempDir, accessor);
    const [entry] = await history('T001');
    expect(entry).toMatchObject({
      source: 'delete-cascade',
      fields: ['depends'],
      before: { depends: ['T002'] },
      after: { depends: [] },
      reason: 'dependency T002 deleted',
    });
  });

  it('the row lands in the same transaction as the change', async () => {
    await updateTask({ taskId: 'T001', priority: 'high', reason: 'x' }, env.tempDir, accessor);
    const rows = await accessor.queryAuditLog({
      taskIds: ['T001'],
      actions: [RANKING_CHANGED_ACTION],
    });
    expect(rows).toHaveLength(1);
    expect((await accessor.loadSingleTask('T001'))?.priority).toBe('high');
  });
});

describe('one command reverts one change', () => {
  it('restores the before values as a new audited change', async () => {
    await updateTask(
      {
        taskId: 'T001',
        priority: 'critical',
        severity: 'P0',
        dependsWaiver: 'standalone',
        reason: 'escalate',
      },
      env.tempDir,
      accessor,
    );
    const [change] = await history('T001');
    const result = await revertRankingChange(
      change?.id as string,
      { reason: 'over-escalated' },
      env.tempDir,
    );
    expect(result).toMatchObject({ taskId: 'T001', fields: ['priority', 'severity'] });
    const task = await accessor.loadSingleTask('T001');
    expect(task?.priority).toBe('medium');
    expect(task?.severity ?? null).toBeNull();
    const [revert] = await history('T001');
    expect(revert).toMatchObject({
      source: 'revert',
      reason: `revert ${change?.id}: over-escalated`,
      before: { priority: 'critical', severity: 'P0' },
      after: { priority: 'medium', severity: null },
    });
  });

  it('refuses when a field changed again since, unless forced', async () => {
    await updateTask({ taskId: 'T001', priority: 'high', reason: 'a' }, env.tempDir, accessor);
    const [first] = await history('T001');
    await updateTask({ taskId: 'T001', priority: 'low', reason: 'b' }, env.tempDir, accessor);
    await expect(revertRankingChange(first?.id as string, {}, env.tempDir)).rejects.toMatchObject({
      code: ExitCode.VALIDATION_ERROR,
    });
    await revertRankingChange(first?.id as string, { force: true }, env.tempDir);
    expect((await accessor.loadSingleTask('T001'))?.priority).toBe('medium');
  });

  it('an unknown entry is not found', async () => {
    await expect(revertRankingChange('log-nope', {}, env.tempDir)).rejects.toMatchObject({
      code: ExitCode.NOT_FOUND,
    });
  });
});
