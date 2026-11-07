/**
 * Claim and focus identity is (session, agent) (T14269, decision D11234).
 *
 * The real harness shape: Claude Code Agent-tool teammates inherit their
 * lead's `CLAUDE_CODE_SESSION_ID`, so the provider key names ONE shared
 * harness session. Each teammate names itself with `CLEO_AGENT_ID`; its
 * first mutation gets it its own CLEO session, so one teammate's `cleo start`
 * never releases another's claim, and teammates can review each other. An
 * unnamed mutation that cannot tell the agents apart is refused.
 *
 * @task T14269
 */

import { randomUUID } from 'node:crypto';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CleoError } from '../../errors.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import {
  bindTerminalToSession,
  createSession,
  getSession,
  resolveBoundSession,
  unbindSessionTerminals,
} from '../../store/session-store.js';
import { claimAllows, sameClaimAgent } from '../../store/task-claim.js';
import { startTask } from '../../task-work/index.js';
import {
  buildReviewPacket,
  type ReviewDeps,
  recordReviewVerdict,
} from '../../tasks/review-verdict.js';
import { resolveTerminalKeys } from '../terminal-identity.js';

/** Identity variables cleared for every test, so the host shell never leaks in. */
const IDENTITY_ENV = [
  'CLEO_SESSION_ID',
  'CLEO_SESSION',
  'CLAUDE_SESSION_ID',
  'AIDER_SESSION_ID',
  'CLEO_AGENT_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'GEMINI_SESSION_ID',
  'TMUX',
  'TMUX_PANE',
  'ZELLIJ_PANE_ID',
  'WEZTERM_PANE',
  'WT_SESSION',
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
];

/** The harness session id every teammate inherits (Claude Code's real shape). */
const SHARED_HARNESS = 'c77fb93a-dd95-4198-a7bc-92a3fc8ef1ff';
const LEAD = 'ses_20261106000000_1ead00';

let env: TestDbEnv;

/** Act as the process `CLEO_AGENT_ID` names inside the shared harness ('' = the lead). */
function as(agentId: string): void {
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', SHARED_HARNESS);
  vi.stubEnv('CLEO_AGENT_ID', agentId);
}

beforeEach(async () => {
  for (const name of IDENTITY_ENV) vi.stubEnv(name, '');
  env = await createTestDb();
  await seedTasks(
    env.accessor,
    ['T001', 'T002', 'T003', 'T004'].map((id) => ({
      id,
      title: `Task ${id}`,
      status: 'pending' as const,
      priority: 'medium' as const,
    })),
  );
  // The lead started its session in the harness tab: the plain provider key is its.
  const now = new Date().toISOString();
  await createSession(
    {
      id: LEAD,
      name: 'lead',
      status: 'active',
      scope: { type: 'global' },
      taskWork: { taskId: null, setAt: null },
      startedAt: now,
    },
    env.tempDir,
  );
  as('');
  await bindTerminalToSession(LEAD, env.tempDir, resolveTerminalKeys());
});

afterEach(async () => {
  await env.cleanup();
  vi.unstubAllEnvs();
});

const claimOf = async (id: string) => (await env.accessor.loadSingleTask(id))?.claim;

describe('per-agent claim identity in one shared harness session (T14269)', () => {
  it('real harness shape: B’s cleo start leaves A’s claim intact; each agent has its own session', async () => {
    as('lane-a');
    await startTask('T001', env.tempDir, env.accessor);
    as('lane-b');
    await startTask('T002', env.tempDir, env.accessor);
    // B refocuses: it releases its own T002, never A's T001.
    await startTask('T003', env.tempDir, env.accessor);

    const a = await claimOf('T001');
    const b = await claimOf('T003');
    expect(a?.agentId).toBe('lane-a');
    expect(b?.agentId).toBe('lane-b');
    expect(a?.sessionId).not.toBe(b?.sessionId);
    expect([a?.sessionId, b?.sessionId]).not.toContain(LEAD);
    expect(await claimOf('T002')).toBeUndefined();

    // Each agent session hangs off the shared harness session.
    const aSession = await getSession(a?.sessionId ?? '', env.tempDir);
    expect(aSession).toMatchObject({ parentSessionId: LEAD, agentIdentifier: 'lane-a' });

    // B cannot start A's live task.
    as('lane-b');
    const refused = await startTask('T001', env.tempDir, env.accessor).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CleoError);
    expect((refused as CleoError).code).toBe(ExitCode.TASK_CLAIMED);
    expect((await claimOf('T001'))?.agentId).toBe('lane-a');
  });

  it('the unqualified lead keeps its own binding and session (D11234)', async () => {
    as('lane-a');
    await startTask('T001', env.tempDir, env.accessor);
    as('');
    expect((await resolveBoundSession(env.tempDir))?.session.id).toBe(LEAD);
    await startTask('T004', env.tempDir, env.accessor);
    expect((await claimOf('T004'))?.sessionId).toBe(LEAD);
    expect((await claimOf('T001'))?.agentId).toBe('lane-a');
  });

  it('an unnamed mutation is refused with E_SESSION_AMBIGUOUS while two agents are live and the shared key has no session of its own', async () => {
    as('lane-a');
    await startTask('T001', env.tempDir, env.accessor);
    as('lane-b');
    await startTask('T002', env.tempDir, env.accessor);
    // The lead's binding goes away: the shared provider key now names nobody.
    await unbindSessionTerminals(LEAD, env.tempDir);
    as('');
    const refused = await startTask('T004', env.tempDir, env.accessor).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CleoError);
    expect((refused as CleoError).code).toBe(ExitCode.SESSION_AMBIGUOUS);
    expect((refused as CleoError).toLAFSError().code).toBe('E_SESSION_AMBIGUOUS');
    expect((refused as CleoError).fix).toContain('CLEO_AGENT_ID');
    expect((refused as CleoError).details).toMatchObject({ agents: ['lane-a', 'lane-b'] });
    expect(await claimOf('T004')).toBeUndefined();
    // Naming itself, the same caller proceeds.
    as('lane-c');
    await startTask('T004', env.tempDir, env.accessor);
    expect((await claimOf('T004'))?.agentId).toBe('lane-c');
  });

  it('an agent key never falls through to the shared session, and a read creates none', async () => {
    as('lane-c');
    expect(await resolveBoundSession(env.tempDir)).toBeNull();
    as('');
    expect((await resolveBoundSession(env.tempDir))?.session.id).toBe(LEAD);
  });

  it('a review verdict from one agent on the other’s task is accepted', async () => {
    await env.accessor.transaction(async (tx) => {
      await tx.insertAcRows([
        {
          id: randomUUID(),
          taskId: 'T001',
          ordinal: 1,
          text: 'list accepts a limit option',
          kind: 'text' as const,
          sourceKey: 'direct:1',
          targetTaskId: null,
          projection: 'legacy',
        },
      ]);
    });
    as('lane-a');
    await startTask('T001', env.tempDir, env.accessor);
    as('lane-b');
    await startTask('T002', env.tempDir, env.accessor);

    const head = 'a'.repeat(40);
    const deps: ReviewDeps = {
      prHead: async () => head,
      prDiff: async () =>
        [
          'diff --git a/src/list.ts b/src/list.ts',
          '--- a/src/list.ts',
          '+++ b/src/list.ts',
          '@@ -1 +1 @@',
          '-export const list = (xs: string[]) => xs;',
          '+export const list = (xs: string[], n?: number) => (n === undefined ? xs : xs.slice(0, n));',
          '',
        ].join('\n'),
    };
    const packet = await buildReviewPacket(env.tempDir, 7, 'T001', deps);
    const verdict = await recordReviewVerdict(
      env.tempDir,
      {
        prNumber: 7,
        taskId: 'T001',
        ac: 'AC1',
        verdict: 'met',
        reason: 'list takes an optional limit and slices to it.',
        packetSha256: packet.packetSha256,
      },
      { deps },
    );
    expect(verdict.reviewer.agentId).toBe('lane-b');
    expect(verdict.authors.agentIds).toEqual(['lane-a']);
  });
});

describe('claim compare on (session, agent) (T14269)', () => {
  const now = '2026-11-06T00:00:00.000Z';
  const lease = {
    sessionId: 'ses_shared',
    agentId: 'lane-a',
    claimedAt: now,
    leaseExpiresAt: '2999-01-01T00:00:00.000Z',
  };

  it('within one session, a different named agent is not the holder', () => {
    expect(claimAllows(lease, 'acquire', 'ses_shared', now, [], 'lane-b')).toBe(false);
    expect(claimAllows(lease, 'acquire', 'ses_shared', now, [], 'lane-a')).toBe(true);
    // An unnamed side matches as before.
    expect(claimAllows(lease, 'acquire', 'ses_shared', now)).toBe(true);
    expect(sameClaimAgent(null, 'lane-b')).toBe(true);
  });
});
