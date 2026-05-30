/**
 * Cross-agent attention leakage-impossibility integration tests
 * (T11375 · Epic T11288 · Saga T11283).
 *
 * THE capstone capture test for the structural guarantee this Epic exists to
 * provide: an attention jot written by one agent is visible to another agent
 * ONLY when they share the jot's scope. Because visibility is the scope key
 * itself — resolved env-first per agent (E0) and filtered in SQL by exact
 * `(scope_kind, scope_id)` membership — an agent/task-scoped jot is NEVER even
 * SELECTed for an agent outside that scope. Leakage is impossible
 * by-construction, not by a filter applied after loading every row.
 *
 * Two distinct agents are simulated, each with its own
 * `CLEO_SESSION_ID` / `CLEO_AGENT_ID` and its own task, sharing a common epic
 * and saga. The suite drives the REAL resolver path (`listAttention` /
 * `buildAttentionDigest` — env-first identity, NOT a hand-passed scope) so the
 * proof is the production code, not a mock.
 *
 *   Asserts:
 *     1. Agent A's TASK-scoped jot never reaches agent B (focus list + digest).
 *     2. Agent A's SESSION-scoped jot never reaches agent B (no cross-session bleed).
 *     3. Agent A's AGENT-scoped jot never reaches agent B.
 *     4. A shared EPIC-scoped jot IS visible to BOTH (hierarchy includes correctly).
 *     5. A shared SAGA-scoped jot IS visible to BOTH.
 *
 * @task T11375
 * @epic T11288
 * @saga T11283
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFocusState } from '../../sessions/focus-state-store.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { addAttention, buildAttentionDigest, listAttention } from '../attention.js';

const ENV_KEYS = ['CLEO_SESSION_ID', 'CLEO_SESSION', 'CLEO_AGENT_ID'];

/** Two concurrent agents under one shared epic (T100) and saga (T900). */
const AGENT_A = { sessionId: 'ses_20260530000040_aaaaaa', agentId: 'agent-A', taskId: 'T001' };
const AGENT_B = { sessionId: 'ses_20260530000041_bbbbbb', agentId: 'agent-B', taskId: 'T002' };

/** Run `fn` under a specific agent's env identity, restoring env afterward. */
async function asAgent<T>(
  agent: { sessionId: string; agentId: string },
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env['CLEO_SESSION_ID'] = agent.sessionId;
  process.env['CLEO_AGENT_ID'] = agent.agentId;
  delete process.env['CLEO_SESSION'];
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('cross-agent attention leakage impossibility (T11375 · Epic T11288)', () => {
  let env: TestDbEnv;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    env = await createTestDb();
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();

    // saga T900 -> epic T100 -> tasks T001 (agent A) and T002 (agent B).
    await seedTasks(env.accessor, [
      { id: 'T900', title: 'Shared saga', type: 'saga' },
      { id: 'T100', title: 'Shared epic', type: 'epic', parentId: 'T900' },
      { id: 'T001', title: 'Task A', type: 'task', parentId: 'T100' },
      { id: 'T002', title: 'Task B', type: 'task', parentId: 'T100' },
    ]);

    // Each agent's per-session focus_state points at its own task.
    await writeFocusState(env.accessor, AGENT_A.sessionId, { currentTask: AGENT_A.taskId });
    await writeFocusState(env.accessor, AGENT_B.sessionId, { currentTask: AGENT_B.taskId });
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();
    await env.cleanup();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  /** Collect every attention content string visible to an agent (real resolver). */
  async function contentsVisibleTo(agent: {
    sessionId: string;
    agentId: string;
  }): Promise<string[]> {
    return asAgent(agent, async () => {
      const { items } = await listAttention(env.tempDir, {});
      return items.map((i) => i.content);
    });
  }

  it("agent A's TASK-scoped jot NEVER appears in agent B's context", async () => {
    // Agent A writes a task-scoped jot (narrowest given no agent override would
    // be agent; force task scope to make the assertion about task isolation).
    await asAgent(AGENT_A, () =>
      addAttention(env.tempDir, { content: 'A-task-secret', scope: 'task' }),
    );

    const aVisible = await contentsVisibleTo(AGENT_A);
    const bVisible = await contentsVisibleTo(AGENT_B);

    expect(aVisible).toContain('A-task-secret');
    expect(bVisible).not.toContain('A-task-secret');
  });

  it("agent A's AGENT-scoped jot NEVER appears in agent B's context", async () => {
    await asAgent(AGENT_A, () =>
      addAttention(env.tempDir, { content: 'A-agent-secret', scope: 'agent' }),
    );

    expect(await contentsVisibleTo(AGENT_A)).toContain('A-agent-secret');
    expect(await contentsVisibleTo(AGENT_B)).not.toContain('A-agent-secret');
  });

  it("agent A's SESSION-scoped jot NEVER appears in agent B's context (no cross-session bleed)", async () => {
    await asAgent(AGENT_A, () =>
      addAttention(env.tempDir, { content: 'A-session-secret', scope: 'session' }),
    );

    expect(await contentsVisibleTo(AGENT_A)).toContain('A-session-secret');
    expect(await contentsVisibleTo(AGENT_B)).not.toContain('A-session-secret');
  });

  it('a shared EPIC-scoped jot IS visible to BOTH agents (hierarchy includes correctly)', async () => {
    await asAgent(AGENT_A, () =>
      addAttention(env.tempDir, { content: 'epic-shared', scope: 'epic' }),
    );

    expect(await contentsVisibleTo(AGENT_A)).toContain('epic-shared');
    expect(await contentsVisibleTo(AGENT_B)).toContain('epic-shared');
  });

  it('a shared SAGA-scoped jot IS visible to BOTH agents', async () => {
    await asAgent(AGENT_A, () =>
      addAttention(env.tempDir, { content: 'saga-shared', scope: 'saga' }),
    );

    expect(await contentsVisibleTo(AGENT_A)).toContain('saga-shared');
    expect(await contentsVisibleTo(AGENT_B)).toContain('saga-shared');
  });

  it("the injected DIGEST for agent B excludes agent A's narrow jots but includes shared scope", async () => {
    // Agent A writes a private task jot AND a shared epic jot.
    await asAgent(AGENT_A, async () => {
      await addAttention(env.tempDir, { content: 'A-private-task', scope: 'task' });
      await addAttention(env.tempDir, { content: 'epic-broadcast', scope: 'epic' });
    });

    // Agent B's REAL injected digest (env-first identity, not a hand-passed scope).
    const bDigest = await asAgent(AGENT_B, () => buildAttentionDigest(env.tempDir));
    expect(bDigest).not.toBeNull();
    const bPreviewContents = (bDigest?.preview ?? []).map((p) => p.content);

    // Shared epic jot reaches B; A's private task jot does NOT.
    expect(bPreviewContents.some((c) => c.includes('epic-broadcast'))).toBe(true);
    expect(bPreviewContents.some((c) => c.includes('A-private-task'))).toBe(false);
    // The digest count reflects ONLY what B can see (the one shared item).
    expect(bDigest?.count).toBe(1);
  });

  it('spawn-scoped digest for B excludes A-private items via the explicit-task resolver path', async () => {
    // Agent A writes a private task jot under T001 and a shared saga jot.
    await asAgent(AGENT_A, async () => {
      await addAttention(env.tempDir, { content: 'A-only', scope: 'task' });
      await addAttention(env.tempDir, { content: 'saga-everyone', scope: 'saga' });
    });

    // Simulate the spawn path scoping the digest to B's task T002 (explicit
    // taskId override — the orchestrator env may differ from the worker's).
    const spawnDigest = await asAgent(AGENT_B, () =>
      buildAttentionDigest(env.tempDir, { taskId: AGENT_B.taskId }),
    );
    const contents = (spawnDigest?.preview ?? []).map((p) => p.content);
    expect(contents.some((c) => c.includes('saga-everyone'))).toBe(true);
    expect(contents.some((c) => c.includes('A-only'))).toBe(false);
  });
});
