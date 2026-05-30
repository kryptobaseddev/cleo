/**
 * Multi-agent session-identity isolation regression suite (T11348 · Epic T11284).
 *
 * THE capture test for the foundation bug this Epic eliminates: multi-agent
 * session-bleed and memory scope-leakage are the SAME root cause — agent
 * identity used to resolve from two global, non-agent-keyed singletons
 * (`getActiveSession()` = most-recent active row, and ONE global `focus_state`
 * meta key). Every short-lived `cleo` call inside a spawned agent's worktree
 * therefore collapsed onto "whoever touched the DB last".
 *
 * This suite spins up a real SQLite-backed accessor (via {@link createTestDb})
 * and simulates >=3 concurrent agents, each with a distinct
 * `CLEO_SESSION_ID`. It asserts:
 *
 *  1. Each agent's env resolves its OWN session via the env-first resolver
 *     (`resolveSessionIdFromEnv` / `resolveCurrentSessionId`), even when a
 *     different, more-recent active session row exists in the DB.
 *  2. Each agent's `focus_state` (currentTask + sessionNotes) is isolated —
 *     agent A's currentTask never appears under agent B's session key.
 *
 * ## Fail-on-main contract (T11348 AC3)
 *
 * On `main` HEAD (pre-fix), `startTask`/`currentTask` read+write ONE global
 * `focus_state` key regardless of `CLEO_SESSION_ID`, so all three agents share
 * a single currentTask — the "each reads back only its own" assertions FAIL.
 * After T11343-T11347, focus_state is keyed `focus_state:<sessionId>` and
 * identity resolves env-first, so the same assertions PASS.
 *
 * The suite uses the REAL `startTask`/`currentTask`/`resolveCurrentSessionId`
 * code paths (no mocks) so it exercises the actual bleed surface end-to-end.
 *
 * @task T11348
 * @epic T11284
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFocusState, writeFocusState } from '../../sessions/focus-state-store.js';
import { resolveSessionIdFromEnv } from '../../sessions/session-id.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { createSession, resolveCurrentSessionId } from '../../store/session-store.js';
import { currentTask, startTask } from '../../task-work/index.js';

/** Distinct env keys we manage so afterEach can restore process.env cleanly. */
const SESSION_ENV_KEYS = [
  'CLEO_SESSION_ID',
  'CLEO_SESSION',
  'CLAUDE_SESSION_ID',
  'AIDER_SESSION_ID',
];

/** A simulated concurrent agent: its session id and the task it works on. */
interface AgentFixture {
  sessionId: string;
  taskId: string;
}

const AGENTS: readonly AgentFixture[] = [
  { sessionId: 'ses_20260530000001_aaaaaa', taskId: 'T001' },
  { sessionId: 'ses_20260530000002_bbbbbb', taskId: 'T002' },
  { sessionId: 'ses_20260530000003_cccccc', taskId: 'T003' },
];

/**
 * Run `fn` with `CLEO_SESSION_ID` set to the given agent's id, then restore the
 * prior value. Models a short-lived `cleo` call running inside a spawned
 * agent's worktree shell (where spawn injected `CLEO_SESSION_ID`).
 */
async function asAgent<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env['CLEO_SESSION_ID'];
  process.env['CLEO_SESSION_ID'] = sessionId;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env['CLEO_SESSION_ID'];
    else process.env['CLEO_SESSION_ID'] = prev;
  }
}

describe('multi-agent session-identity isolation (T11348 · Epic T11284)', () => {
  let env: TestDbEnv;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of SESSION_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    env = await createTestDb();

    // Seed one task per agent.
    await seedTasks(
      env.accessor,
      AGENTS.map((a) => ({
        id: a.taskId,
        title: `Task for ${a.sessionId}`,
        status: 'pending' as const,
        priority: 'medium' as const,
      })),
    );

    // Create one ACTIVE session row per agent. They are created in order so the
    // LAST one (agent C) is the most-recent active row — this is the trap the
    // pre-fix `getActiveSession()` path falls into.
    for (const agent of AGENTS) {
      await createSession(
        {
          id: agent.sessionId,
          name: `session-${agent.sessionId}`,
          status: 'active',
          scope: { type: 'global' },
          taskWork: { taskId: null, setAt: null },
          startedAt: new Date().toISOString(),
          agentHandle: agent.sessionId,
        },
        env.tempDir,
      );
    }
  });

  afterEach(async () => {
    await env.cleanup();
    for (const key of SESSION_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('resolves each agent to its OWN session env-first, not the most-recent active row', async () => {
    // agent C is the most-recent active row; pre-fix code would resolve every
    // agent to C via getActiveSession(). Env-first must return each agent's own.
    for (const agent of AGENTS) {
      const resolved = await asAgent(agent.sessionId, async () => {
        // sync env reader returns the agent's own id
        expect(resolveSessionIdFromEnv()).toBe(agent.sessionId);
        // DB-backed env-first resolver also returns the agent's own session
        return resolveCurrentSessionId(env.tempDir);
      });
      expect(resolved).toBe(agent.sessionId);
    }
  });

  it('isolates focus_state currentTask per concurrent agent (no cross-contamination)', async () => {
    // Each agent starts work on its own task within its own env.
    for (const agent of AGENTS) {
      await asAgent(agent.sessionId, () => startTask(agent.taskId, env.tempDir, env.accessor));
    }

    // Each agent reads back ONLY its own currentTask.
    for (const agent of AGENTS) {
      const result = await asAgent(agent.sessionId, () => currentTask(env.tempDir, env.accessor));
      expect(result.currentTask).toBe(agent.taskId);
    }

    // Cross-check: no agent's task leaks under another agent's session key.
    for (const reader of AGENTS) {
      const focus = await readFocusState(env.accessor, reader.sessionId);
      for (const other of AGENTS) {
        if (other.sessionId === reader.sessionId) continue;
        expect(focus?.currentTask).not.toBe(other.taskId);
      }
    }
  });

  it('isolates sessionNotes per concurrent agent (no cross-writes)', async () => {
    // startTask appends a "Started work on <task>" note to the per-session blob.
    for (const agent of AGENTS) {
      await asAgent(agent.sessionId, () => startTask(agent.taskId, env.tempDir, env.accessor));
    }

    for (const agent of AGENTS) {
      const focus = await readFocusState(env.accessor, agent.sessionId);
      const notes = focus?.sessionNotes ?? [];
      // Exactly one note, and it mentions THIS agent's task only.
      expect(notes.length).toBe(1);
      expect(notes[0]?.note).toContain(agent.taskId);
      for (const other of AGENTS) {
        if (other.taskId === agent.taskId) continue;
        for (const note of notes) {
          expect(note.note).not.toContain(other.taskId);
        }
      }
    }
  });

  it('keeps a later writer from clobbering an earlier agent (last-writer-wins is per-session)', async () => {
    // Interleave writes: A→B→C→A again. Pre-fix, the global key means the final
    // write wins for everyone; per-session keying preserves each agent's value.
    await asAgent(AGENTS[0]!.sessionId, () =>
      writeFocusState(env.accessor, AGENTS[0]!.sessionId, { currentTask: AGENTS[0]!.taskId }),
    );
    await asAgent(AGENTS[1]!.sessionId, () =>
      writeFocusState(env.accessor, AGENTS[1]!.sessionId, { currentTask: AGENTS[1]!.taskId }),
    );
    await asAgent(AGENTS[2]!.sessionId, () =>
      writeFocusState(env.accessor, AGENTS[2]!.sessionId, { currentTask: AGENTS[2]!.taskId }),
    );

    // Agent A is read LAST but must still see its OWN task, not C's.
    const focusA = await readFocusState(env.accessor, AGENTS[0]!.sessionId);
    expect(focusA?.currentTask).toBe(AGENTS[0]!.taskId);
    const focusB = await readFocusState(env.accessor, AGENTS[1]!.sessionId);
    expect(focusB?.currentTask).toBe(AGENTS[1]!.taskId);
    const focusC = await readFocusState(env.accessor, AGENTS[2]!.sessionId);
    expect(focusC?.currentTask).toBe(AGENTS[2]!.taskId);
  });
});
