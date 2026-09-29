/**
 * Leased task claims (T12502 · epic T12497), in one process.
 *
 * `task-claims-multiprocess.test.ts` proves the compare-and-set across real
 * processes; this file covers the lease lifecycle:
 *
 *  - `cleo start` takes the caller session's lease; the human assignee is
 *    untouched (AC3);
 *  - a second session is refused with `E_TASK_CLAIMED` naming the holder and
 *    lease expiry, and nothing it would have written is written (AC1);
 *  - an expired lease still blocks a plain start, is taken with `--take-over`
 *    (audited), and a live one only with `--force-claim` (audited) (AC2);
 *  - renew (heartbeat and explicit), stop, completion, session end and
 *    session deletion release or extend the lease;
 *  - spawn takes the lease for the spawned session, hands it over from the
 *    orchestrator, and is refused by a foreign holder.
 *
 * @task T12502
 * @epic T12497
 */

import { ExitCode, type Session, type TaskClaimedDetails } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CleoError } from '../../errors.js';
import { readFocusState } from '../../sessions/focus-state-store.js';
import { requireSpawnSession } from '../../spawn/agent-identity.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { endSession } from '../../store/session-store.js';
import { taskVersion } from '../../store/task-version.js';
import { claimSpawnedTask, renewClaimsForSession, startTask, stopTask } from '../index.js';

const ENV_KEYS = [
  'CLEO_SESSION_ID',
  'CLEO_SESSION',
  'CLAUDE_SESSION_ID',
  'AIDER_SESSION_ID',
  'CLEO_AGENT_ID',
  'CLEO_CLAIM_LEASE_MINUTES',
];

const SES_A = 'ses_20260929000001_aaaaaa';
const SES_B = 'ses_20260929000002_bbbbbb';

/** Run `fn` as the process bound to `sessionId` (or unbound for `null`). */
async function as<T>(sessionId: string | null, fn: () => Promise<T>): Promise<T> {
  const prev = process.env['CLEO_SESSION_ID'];
  if (sessionId) process.env['CLEO_SESSION_ID'] = sessionId;
  else delete process.env['CLEO_SESSION_ID'];
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env['CLEO_SESSION_ID'];
    else process.env['CLEO_SESSION_ID'] = prev;
  }
}

/** Capture the CleoError a promise rejects with. */
async function rejection(p: Promise<unknown>): Promise<CleoError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CleoError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

function session(id: string): Session {
  const now = new Date().toISOString();
  return {
    id,
    name: `session-${id}`,
    status: 'active',
    scope: { type: 'global' },
    taskWork: { taskId: null, setAt: null },
    startedAt: now,
    agentHandle: `agent-${id.slice(-6)}`,
  };
}

describe('leased task claims (T12502)', () => {
  let env: TestDbEnv;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Target', status: 'pending', priority: 'medium' },
      { id: 'T002', title: 'Other', status: 'pending', priority: 'medium' },
    ]);
    await env.accessor.updateTaskFields('T001', { assignee: 'keaton' });
    await env.accessor.upsertSingleSession(session(SES_A));
    await env.accessor.upsertSingleSession(session(SES_B));
  });

  afterEach(async () => {
    await env.cleanup();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const start = (sessionId: string | null, taskId = 'T001', opts = {}) =>
    as(sessionId, () => startTask(taskId, env.tempDir, env.accessor, opts));

  /** Push T001's lease into the past (simulates a holder that stopped renewing). */
  const expireLease = () =>
    env.accessor.updateTaskFields(
      'T001',
      { leaseExpiresAt: '2000-01-01T00:00:00.000Z' },
      { keepVersion: true },
    );

  it('start takes the session lease and leaves the human assignee alone (AC1, AC3)', async () => {
    const result = await start(SES_A);
    expect(result.claim).toMatchObject({ sessionId: SES_A, agentId: 'agent-aaaaaa' });
    const task = await env.accessor.loadSingleTask('T001');
    expect(task?.assignee).toBe('keaton');
    expect(task?.claim?.sessionId).toBe(SES_A);
    expect(Date.parse(task?.claim?.leaseExpiresAt ?? '')).toBeGreaterThan(Date.now());
  });

  it('a second session is refused with E_TASK_CLAIMED naming the holder; nothing is written (AC1)', async () => {
    await start(SES_A);
    const before = await env.accessor.loadSingleTask('T001');
    const err = await rejection(start(SES_B));
    expect(err.code).toBe(ExitCode.TASK_CLAIMED);
    expect(err.toLAFSError().code).toBe('E_TASK_CLAIMED');
    expect(err.message).toContain(SES_A);
    const expected: Partial<TaskClaimedDetails> = {
      field: 'claimedBySession',
      taskId: 'T001',
      expired: false,
      override: '--force-claim',
    };
    expect(err.details).toMatchObject({
      ...expected,
      holder: { sessionId: SES_A, leaseExpiresAt: before?.claim?.leaseExpiresAt },
      requester: { sessionId: SES_B },
    });
    // The refused start wrote nothing: no focus for B, no version change.
    expect(await readFocusState(env.accessor, SES_B)).toBeNull();
    const after = await env.accessor.loadSingleTask('T001');
    expect(taskVersion(after)).toBe(taskVersion(before));
    expect(after?.claim?.sessionId).toBe(SES_A);
  });

  it('an unbound caller holds no lease but is refused by a held one', async () => {
    const free = await start(null, 'T002');
    expect(free.claim).toBeNull();
    expect((await env.accessor.loadSingleTask('T002'))?.claim).toBeUndefined();
    await start(SES_A);
    const err = await rejection(start(null));
    expect(err.code).toBe(ExitCode.TASK_CLAIMED);
  });

  it('the holder re-starting renews its own lease without moving the version', async () => {
    const first = await start(SES_A);
    const v = taskVersion(await env.accessor.loadSingleTask('T001'));
    await expireLease();
    const again = await start(SES_A);
    expect(again.claim?.claimedAt).toBe(first.claim?.claimedAt);
    expect(Date.parse(again.claim?.leaseExpiresAt ?? '')).toBeGreaterThan(Date.now());
    expect(taskVersion(await env.accessor.loadSingleTask('T001'))).toBe(v);
  });

  it('an expired lease blocks a plain start and is taken over explicitly, audited (AC2)', async () => {
    await start(SES_A);
    await expireLease();
    const err = await rejection(start(SES_B));
    expect(err.details).toMatchObject({ expired: true, override: '--take-over' });
    expect(err.fix).toContain('--take-over');

    const taken = await start(SES_B, 'T001', { takeOver: true });
    expect(taken.claim?.sessionId).toBe(SES_B);
    const audit = await env.accessor.queryAuditLog({
      taskIds: ['T001'],
      actions: ['task_claim_takeover'],
    });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.beforeJson ?? '{}')).toMatchObject({ sessionId: SES_A });
    expect(JSON.parse(audit[0]?.detailsJson ?? '{}')).toMatchObject({ leaseExpired: true });
  });

  it('--take-over does not take a LIVE lease; --force-claim does, audited', async () => {
    await start(SES_A);
    const err = await rejection(start(SES_B, 'T001', { takeOver: true }));
    expect(err.code).toBe(ExitCode.TASK_CLAIMED);
    const forced = await start(SES_B, 'T001', { forceClaim: true });
    expect(forced.claim?.sessionId).toBe(SES_B);
    const audit = await env.accessor.queryAuditLog({
      taskIds: ['T001'],
      actions: ['task_claim_force'],
    });
    expect(audit).toHaveLength(1);
  });

  it('the heartbeat extends every lease the session holds, without a version change', async () => {
    await start(SES_A);
    await expireLease();
    const v = taskVersion(await env.accessor.loadSingleTask('T001'));
    expect(await renewClaimsForSession(env.accessor, SES_A)).toBe(1);
    const task = await env.accessor.loadSingleTask('T001');
    expect(Date.parse(task?.claim?.leaseExpiresAt ?? '')).toBeGreaterThan(Date.now());
    expect(taskVersion(task)).toBe(v);
    expect(await renewClaimsForSession(env.accessor, SES_B)).toBe(0);
  });

  it('explicit renew works only for the holder', async () => {
    await start(SES_A);
    const err = await rejection(
      env.accessor.claimTask('T001', { sessionId: SES_B, agentId: null, mode: 'renew' }),
    );
    expect(err.code).toBe(ExitCode.TASK_CLAIMED);
    const renewed = await env.accessor.claimTask('T001', {
      sessionId: SES_A,
      agentId: null,
      mode: 'renew',
    });
    expect(renewed?.sessionId).toBe(SES_A);
  });

  it('stop releases the caller’s lease; starting another task releases the previous one', async () => {
    await start(SES_A, 'T002');
    await start(SES_A, 'T001');
    expect((await env.accessor.loadSingleTask('T002'))?.claim).toBeUndefined();
    await as(SES_A, () => stopTask(env.tempDir, env.accessor));
    expect((await env.accessor.loadSingleTask('T001'))?.claim).toBeUndefined();
  });

  it('completion releases the lease (trigger)', async () => {
    await start(SES_A);
    await env.accessor.updateTaskFields('T001', {
      status: 'done',
      pipelineStage: 'contribution',
      completedAt: new Date().toISOString(),
    });
    expect((await env.accessor.loadSingleTask('T001'))?.claim).toBeUndefined();
  });

  it('the holder session ending or being deleted releases its leases (trigger)', async () => {
    await start(SES_A, 'T001');
    await start(SES_B, 'T002');
    await endSession(SES_A, undefined, env.tempDir);
    expect((await env.accessor.loadSingleTask('T001'))?.claim).toBeUndefined();
    expect((await env.accessor.loadSingleTask('T002'))?.claim?.sessionId).toBe(SES_B);
    await env.accessor.removeSingleSession(SES_B);
    expect((await env.accessor.loadSingleTask('T002'))?.claim).toBeUndefined();
  });

  it('spawn claims for the spawned session and hands off from the orchestrator, audited', async () => {
    await start(SES_A);
    const claim = await as(SES_A, () =>
      claimSpawnedTask(env.tempDir, 'T001', { sessionId: SES_B, agentId: 'agent-t001' }),
    );
    expect(claim?.sessionId).toBe(SES_B);
    const audit = await env.accessor.queryAuditLog({
      taskIds: ['T001'],
      actions: ['task_claim_handoff'],
    });
    expect(audit).toHaveLength(1);
  });

  it('spawn is refused with E_TASK_CLAIMED when another session holds the task', async () => {
    await start(SES_A);
    const spawned = await as(SES_B, () => requireSpawnSession(env.tempDir, 'T001'));
    expect(spawned.ok).toBe(false);
    if (spawned.ok) return;
    expect(spawned.code).toBe('E_TASK_CLAIMED');
    expect(spawned.exitCode).toBe(ExitCode.TASK_CLAIMED);
    expect(spawned.details).toMatchObject({ holder: { sessionId: SES_A } });
    // The session allocated for the refused spawn was ended, not leaked.
    const leaked = (await env.accessor.loadSessions()).filter(
      (s) => s.status === 'active' && s.agentHandle === 'agent-t001',
    );
    expect(leaked).toHaveLength(0);
  });
});
