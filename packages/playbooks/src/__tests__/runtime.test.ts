/**
 * W4-10 / T930 runtime state machine tests.
 *
 * Every test runs against a real in-memory `node:sqlite` DB with the T889
 * migration applied. `AgentDispatcher` and `DeterministicRunner` are stubbed
 * inline — no `@cleocode/*` modules are mocked.
 *
 * @task T930 — Playbook Runtime State Machine
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type {
  PlaybookAgenticNode,
  PlaybookApprovalNode,
  PlaybookDefinition,
  PlaybookDeterministicNode,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveGate, rejectGate } from '../approval.js';
import {
  type AgentDispatcher,
  type AgentDispatchInput,
  type AgentDispatchResult,
  type DeterministicRunInput,
  type DeterministicRunner,
  type DeterministicRunResult,
  E_PLAYBOOK_RESUME_BLOCKED,
  executePlaybook,
  resumePlaybook,
} from '../runtime.js';
import { getPlaybookRun, listPlaybookApprovals } from '../state.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = resolve(
  __dirname,
  '../../../core/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/migration.sql',
);

function applyMigration(db: DatabaseSync, sql: string): void {
  const statements = sql
    .split(/--> statement-breakpoint/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    const lines = stmt.split('\n');
    const hasSql = lines.some((l) => l.trim().length > 0 && !l.trim().startsWith('--'));
    if (hasSql) db.exec(stmt);
  }
}

// -- Dispatcher stub helpers -------------------------------------------------

interface RecordedCall {
  nodeId: string;
  agentId: string;
  iteration: number;
  contextSnapshot: Record<string, unknown>;
}

function makeRecordingDispatcher(
  handler: (input: AgentDispatchInput) => AgentDispatchResult | Promise<AgentDispatchResult>,
): AgentDispatcher & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const dispatcher: AgentDispatcher & { calls: RecordedCall[] } = {
    calls,
    async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
      calls.push({
        nodeId: input.nodeId,
        agentId: input.agentId,
        iteration: input.iteration,
        contextSnapshot: { ...input.context },
      });
      return handler(input);
    },
  };
  return dispatcher;
}

function makeRecordingRunner(
  handler: (
    input: DeterministicRunInput,
  ) => DeterministicRunResult | Promise<DeterministicRunResult>,
): DeterministicRunner & { calls: DeterministicRunInput[] } {
  const calls: DeterministicRunInput[] = [];
  const runner: DeterministicRunner & { calls: DeterministicRunInput[] } = {
    calls,
    async run(input: DeterministicRunInput): Promise<DeterministicRunResult> {
      calls.push({ ...input, args: [...input.args] });
      return handler(input);
    },
  };
  return runner;
}

// -- Canonical playbook shapes ----------------------------------------------

function agenticNode(
  id: string,
  overrides: Partial<PlaybookAgenticNode> = {},
): PlaybookAgenticNode {
  return {
    id,
    type: 'agentic',
    skill: `skill-${id}`,
    ...overrides,
  };
}

function approvalNode(id: string, prompt = `approve ${id}`): PlaybookApprovalNode {
  return { id, type: 'approval', prompt };
}

function deterministicNode(
  id: string,
  command = 'pnpm',
  args: string[] = ['biome', 'ci', '.'],
  overrides: Partial<PlaybookDeterministicNode> = {},
): PlaybookDeterministicNode {
  return {
    id,
    type: 'deterministic',
    command,
    args,
    ...overrides,
  };
}

function linearPlaybook(name: string, ids: string[]): PlaybookDefinition {
  const nodes: PlaybookDefinition['nodes'] = ids.map((id) => agenticNode(id));
  const edges: PlaybookDefinition['edges'] = [];
  for (let i = 0; i < ids.length - 1; i += 1) {
    const from = ids[i];
    const to = ids[i + 1];
    if (from === undefined || to === undefined) continue;
    edges.push({ from, to });
  }
  return { version: '1.0', name, nodes, edges };
}

// ---------------------------------------------------------------------------

describe('W4-10 / T930: playbook runtime state machine', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigration(db, readFileSync(MIGRATION_SQL, 'utf8'));
  });
  afterEach(() => db.close());

  // 1 ------------------------------------------------------------------------
  it('success path: linear agentic playbook completes with merged context', async () => {
    const playbook = linearPlaybook('linear', ['a', 'b', 'c']);
    const dispatcher = makeRecordingDispatcher((input) => ({
      status: 'success',
      output: { [`${input.nodeId}_done`]: true, lastNode: input.nodeId },
    }));

    const result = await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-1',
      initialContext: { taskId: 'T123' },
      dispatcher,
    });

    expect(result.terminalStatus).toBe('completed');
    expect(result.finalContext).toMatchObject({
      taskId: 'T123',
      a_done: true,
      b_done: true,
      c_done: true,
      lastNode: 'c',
    });
    expect(dispatcher.calls.map((c) => c.nodeId)).toEqual(['a', 'b', 'c']);
    expect(dispatcher.calls.map((c) => c.agentId)).toEqual(['skill-a', 'skill-b', 'skill-c']);
    // Every call saw the accumulated context up to that point
    expect(dispatcher.calls[0]?.contextSnapshot).toMatchObject({ taskId: 'T123' });
    expect(dispatcher.calls[1]?.contextSnapshot).toMatchObject({ taskId: 'T123', a_done: true });
    expect(dispatcher.calls[2]?.contextSnapshot).toMatchObject({
      taskId: 'T123',
      a_done: true,
      b_done: true,
    });

    const run = getPlaybookRun(db, result.runId);
    expect(run?.status).toBe('completed');
    expect(run?.currentNode).toBeNull();
    expect(run?.completedAt).toBeTruthy();
  });

  // 2 ------------------------------------------------------------------------
  it('iteration cap: retries up to cap then terminates with exceeded_iteration_cap', async () => {
    const playbook: PlaybookDefinition = {
      version: '1.0',
      name: 'cap-test',
      nodes: [agenticNode('a', { on_failure: { max_iterations: 2 } }), agenticNode('b')],
      edges: [{ from: 'a', to: 'b' }],
    };
    const dispatcher = makeRecordingDispatcher(() => ({
      status: 'failure',
      output: {},
      error: 'always fails',
    }));

    const result = await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-2',
      initialContext: {},
      dispatcher,
    });

    expect(result.terminalStatus).toBe('exceeded_iteration_cap');
    expect(result.exceededNodeId).toBe('a');
    expect(result.errorContext).toBe('always fails');
    // Node a attempted exactly 2 times (its configured cap), b never executed.
    expect(dispatcher.calls.filter((c) => c.nodeId === 'a')).toHaveLength(2);
    expect(dispatcher.calls.filter((c) => c.nodeId === 'b')).toHaveLength(0);

    const run = getPlaybookRun(db, result.runId);
    expect(run?.status).toBe('failed');
    expect(run?.iterationCounts['a']).toBe(2);
  });

  // 3 ------------------------------------------------------------------------
  it('approval-pending: paused at approval node with persisted resume token', async () => {
    const playbook: PlaybookDefinition = {
      version: '1.0',
      name: 'approval-test',
      nodes: [agenticNode('research'), approvalNode('gate'), agenticNode('ship')],
      edges: [
        { from: 'research', to: 'gate' },
        { from: 'gate', to: 'ship' },
      ],
    };
    const dispatcher = makeRecordingDispatcher(() => ({
      status: 'success',
      output: { step: 'done' },
    }));

    const result = await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-3',
      initialContext: { taskId: 'T500' },
      dispatcher,
      approvalSecret: 'unit-test-secret',
    });

    expect(result.terminalStatus).toBe('pending_approval');
    expect(result.approvalToken).toBeDefined();
    expect(result.approvalToken).toMatch(/^[0-9a-f]{32}$/);
    // Only the research node executed; ship is gated.
    expect(dispatcher.calls.map((c) => c.nodeId)).toEqual(['research']);

    const approvals = listPlaybookApprovals(db, result.runId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe('pending');
    expect(approvals[0]?.token).toBe(result.approvalToken);
    expect(approvals[0]?.nodeId).toBe('gate');

    const run = getPlaybookRun(db, result.runId);
    expect(run?.status).toBe('paused');
  });

  // 4 ------------------------------------------------------------------------
  it('resume: after approval, execution continues past the gate to completion', async () => {
    const playbook: PlaybookDefinition = {
      version: '1.0',
      name: 'resume-test',
      nodes: [agenticNode('plan'), approvalNode('gate'), agenticNode('ship')],
      edges: [
        { from: 'plan', to: 'gate' },
        { from: 'gate', to: 'ship' },
      ],
    };
    const dispatcher = makeRecordingDispatcher((input) => ({
      status: 'success',
      output: { [`${input.nodeId}_ok`]: true },
    }));

    const first = await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-4',
      initialContext: { taskId: 'T777' },
      dispatcher,
      approvalSecret: 'unit-test-secret',
    });
    expect(first.terminalStatus).toBe('pending_approval');
    if (first.approvalToken === undefined) throw new Error('expected approval token');

    // Human approves.
    approveGate(db, first.approvalToken, 'keaton@cleo', 'LGTM');

    const second = await resumePlaybook({
      db,
      playbook,
      approvalToken: first.approvalToken,
      dispatcher,
      approvalSecret: 'unit-test-secret',
    });

    expect(second.terminalStatus).toBe('completed');
    expect(second.finalContext).toMatchObject({
      taskId: 'T777',
      plan_ok: true,
      ship_ok: true,
    });
    // 'ship' executed after resume; 'plan' should not have re-executed.
    const shipCalls = dispatcher.calls.filter((c) => c.nodeId === 'ship');
    const planCalls = dispatcher.calls.filter((c) => c.nodeId === 'plan');
    expect(shipCalls).toHaveLength(1);
    expect(planCalls).toHaveLength(1);

    const run = getPlaybookRun(db, first.runId);
    expect(run?.status).toBe('completed');
  });

  // 5 ------------------------------------------------------------------------
  it('failure propagation: cap=0 terminates on first failure with failedNodeId', async () => {
    const playbook: PlaybookDefinition = {
      version: '1.0',
      name: 'fail-prop',
      nodes: [agenticNode('a', { on_failure: { max_iterations: 0 } }), agenticNode('b')],
      edges: [{ from: 'a', to: 'b' }],
    };
    const dispatcher = makeRecordingDispatcher(() => ({
      status: 'failure',
      output: {},
      error: 'bad news',
    }));

    const result = await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-5',
      initialContext: {},
      dispatcher,
    });

    expect(result.terminalStatus).toBe('exceeded_iteration_cap');
    expect(result.exceededNodeId).toBe('a');
    expect(result.errorContext).toBe('bad news');
    // With cap=0, dispatcher still runs once before the cap trips.
    expect(dispatcher.calls).toHaveLength(1);
  });

  // 6 ------------------------------------------------------------------------
  it('invalid node: multi-successor fan-out throws runtime invariant error', async () => {
    const playbook: PlaybookDefinition = {
      version: '1.0',
      name: 'fanout',
      nodes: [agenticNode('a'), agenticNode('b'), agenticNode('c')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
      ],
    };
    const dispatcher = makeRecordingDispatcher(() => ({ status: 'success', output: {} }));

    await expect(
      executePlaybook({
        db,
        playbook,
        playbookHash: 'hash-6',
        initialContext: {},
        dispatcher,
      }),
    ).rejects.toThrow(/has 2 successors/);
  });

  // 7 ------------------------------------------------------------------------
  it('resume-blocked: pending token is rejected with E_PLAYBOOK_RESUME_BLOCKED', async () => {
    const playbook: PlaybookDefinition = {
      version: '1.0',
      name: 'resume-pending',
      nodes: [agenticNode('a'), approvalNode('gate'), agenticNode('b')],
      edges: [
        { from: 'a', to: 'gate' },
        { from: 'gate', to: 'b' },
      ],
    };
    const dispatcher = makeRecordingDispatcher(() => ({ status: 'success', output: {} }));

    const first = await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-7',
      initialContext: {},
      dispatcher,
      approvalSecret: 'unit-test-secret',
    });
    if (first.approvalToken === undefined) throw new Error('expected token');

    // Do NOT approve the gate — resume should fail.
    await expect(
      resumePlaybook({
        db,
        playbook,
        approvalToken: first.approvalToken,
        dispatcher,
        approvalSecret: 'unit-test-secret',
      }),
    ).rejects.toThrow(new RegExp(E_PLAYBOOK_RESUME_BLOCKED));
  });

  // 8 ------------------------------------------------------------------------
  it('resume-blocked: rejected gate raises and marks run failed', async () => {
    const playbook: PlaybookDefinition = {
      version: '1.0',
      name: 'resume-rejected',
      nodes: [agenticNode('a'), approvalNode('gate'), agenticNode('b')],
      edges: [
        { from: 'a', to: 'gate' },
        { from: 'gate', to: 'b' },
      ],
    };
    const dispatcher = makeRecordingDispatcher(() => ({ status: 'success', output: {} }));

    const first = await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-8',
      initialContext: {},
      dispatcher,
      approvalSecret: 'unit-test-secret',
    });
    if (first.approvalToken === undefined) throw new Error('expected token');

    rejectGate(db, first.approvalToken, 'auditor', 'not yet');

    await expect(
      resumePlaybook({
        db,
        playbook,
        approvalToken: first.approvalToken,
        dispatcher,
        approvalSecret: 'unit-test-secret',
      }),
    ).rejects.toThrow(/was rejected/);

    const run = getPlaybookRun(db, first.runId);
    expect(run?.status).toBe('failed');
    expect(run?.errorContext).toBe('not yet');
  });

  // 9 ------------------------------------------------------------------------
  it('context propagation: each node sees prior outputs; dispatcher receives iteration=1 on success', async () => {
    const playbook = linearPlaybook('ctx', ['a', 'b', 'c']);
    const dispatcher = makeRecordingDispatcher((input) => {
      if (input.nodeId === 'a') return { status: 'success', output: { alpha: 1 } };
      if (input.nodeId === 'b') return { status: 'success', output: { beta: 2 } };
      return { status: 'success', output: { gamma: 3 } };
    });

    const result = await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-9',
      initialContext: { taskId: 'T42', seed: 'keaton' },
      dispatcher,
    });

    expect(result.terminalStatus).toBe('completed');
    expect(result.finalContext).toMatchObject({
      taskId: 'T42',
      seed: 'keaton',
      alpha: 1,
      beta: 2,
      gamma: 3,
    });
    expect(dispatcher.calls.map((c) => c.iteration)).toEqual([1, 1, 1]);
    // Node 'c' observes alpha + beta from prior nodes.
    expect(dispatcher.calls[2]?.contextSnapshot).toMatchObject({ alpha: 1, beta: 2 });
    // Context passed to dispatcher is a defensive copy — mutating it cannot
    // leak back into the runtime's bookkeeping.
    expect(dispatcher.calls[0]?.contextSnapshot).toMatchObject({ taskId: 'T42' });
  });

  // 10 -----------------------------------------------------------------------
  it('parallel-safe: two runs on the same DB produce independent iterations', async () => {
    const playbook = linearPlaybook('parallel', ['a', 'b']);
    const dispatcher = makeRecordingDispatcher((input) => ({
      status: 'success',
      output: { who: input.runId, where: input.nodeId },
    }));

    const [r1, r2] = await Promise.all([
      executePlaybook({
        db,
        playbook,
        playbookHash: 'hash-10-a',
        initialContext: { taskId: 'T1' },
        dispatcher,
      }),
      executePlaybook({
        db,
        playbook,
        playbookHash: 'hash-10-b',
        initialContext: { taskId: 'T2' },
        dispatcher,
      }),
    ]);

    expect(r1.runId).not.toBe(r2.runId);
    expect(r1.terminalStatus).toBe('completed');
    expect(r2.terminalStatus).toBe('completed');
    expect(r1.finalContext['taskId']).toBe('T1');
    expect(r2.finalContext['taskId']).toBe('T2');

    // Both runs persisted independently.
    const run1 = getPlaybookRun(db, r1.runId);
    const run2 = getPlaybookRun(db, r2.runId);
    expect(run1?.status).toBe('completed');
    expect(run2?.status).toBe('completed');
    expect(run1?.bindings['taskId']).toBe('T1');
    expect(run2?.bindings['taskId']).toBe('T2');
  });

  // 11 -----------------------------------------------------------------------
  it('policy eval: deterministic node is executed via injected runner with full args', async () => {
    const playbook: PlaybookDefinition = {
      version: '1.0',
      name: 'deterministic',
      nodes: [
        agenticNode('plan'),
        deterministicNode('lint', 'pnpm', ['biome', 'ci', '.'], {
          timeout_ms: 60000,
          cwd: '/mnt/projects/cleocode',
          env: { CI: 'true' },
        }),
      ],
      edges: [{ from: 'plan', to: 'lint' }],
    };
    const dispatcher = makeRecordingDispatcher(() => ({ status: 'success', output: {} }));
    const runner = makeRecordingRunner(() => ({
      status: 'success',
      output: { lintExitCode: 0, lintPassed: true },
    }));

    const result = await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-11',
      initialContext: { taskId: 'T930' },
      dispatcher,
      deterministicRunner: runner,
    });

    expect(result.terminalStatus).toBe('completed');
    expect(result.finalContext).toMatchObject({ lintExitCode: 0, lintPassed: true });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      nodeId: 'lint',
      command: 'pnpm',
      args: ['biome', 'ci', '.'],
      cwd: '/mnt/projects/cleocode',
      env: { CI: 'true' },
      timeout_ms: 60000,
      iteration: 1,
    });
  });

  // 12 -----------------------------------------------------------------------
  it('inject_into: node retries via another node when on_failure.inject_into is set', async () => {
    const playbook: PlaybookDefinition = {
      version: '1.0',
      name: 'inject',
      nodes: [
        agenticNode('hint'),
        agenticNode('worker', {
          on_failure: { max_iterations: 2, inject_into: 'hint' },
        }),
        agenticNode('finalize'),
      ],
      edges: [
        { from: 'hint', to: 'worker' },
        { from: 'worker', to: 'finalize' },
      ],
    };

    // First worker call fails once; after reinjection, succeeds.
    let workerCalls = 0;
    const dispatcher = makeRecordingDispatcher((input) => {
      if (input.nodeId === 'worker') {
        workerCalls += 1;
        if (workerCalls === 1) return { status: 'failure', output: {}, error: 'worker bust' };
        return { status: 'success', output: { workerDone: true } };
      }
      return { status: 'success', output: { [input.nodeId]: 'ok' } };
    });

    const result = await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-12',
      initialContext: {},
      dispatcher,
    });

    expect(result.terminalStatus).toBe('completed');
    expect(result.finalContext).toMatchObject({
      workerDone: true,
      __lastError: 'worker bust',
      __lastFailedNode: 'worker',
    });
    // hint executed twice (initial + re-inject), worker twice (fail + success),
    // finalize once.
    const byNode = dispatcher.calls.reduce<Record<string, number>>((acc, c) => {
      acc[c.nodeId] = (acc[c.nodeId] ?? 0) + 1;
      return acc;
    }, {});
    expect(byNode).toMatchObject({ hint: 2, worker: 2, finalize: 1 });
  });

  // 13 -----------------------------------------------------------------------
  it('unknown nextNode via inject_into target: terminates as failed (not exceeded)', async () => {
    const playbook: PlaybookDefinition = {
      version: '1.0',
      name: 'bad-inject',
      nodes: [agenticNode('w', { on_failure: { max_iterations: 1, inject_into: 'ghost' } })],
      edges: [],
    };
    const dispatcher = makeRecordingDispatcher(() => ({
      status: 'failure',
      output: {},
      error: 'nope',
    }));

    const result = await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-13',
      initialContext: {},
      dispatcher,
    });
    expect(result.terminalStatus).toBe('failed');
    expect(result.failedNodeId).toBe('w');
    const run = getPlaybookRun(db, result.runId);
    expect(run?.status).toBe('failed');
  });

  // 14 -----------------------------------------------------------------------
  it('injectable clock: completedAt uses supplied now()', async () => {
    const playbook = linearPlaybook('clock', ['a']);
    const dispatcher = makeRecordingDispatcher(() => ({ status: 'success', output: {} }));
    const fixed = new Date('2026-04-17T22:30:00.000Z');

    await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-14',
      initialContext: {},
      dispatcher,
      now: () => fixed,
    });

    // The SQLite migration stamps completedAt via JS, and updatePlaybookRun
    // writes our supplied timestamp.
    const runs = db
      .prepare("SELECT completed_at FROM playbook_runs WHERE playbook_name = 'clock'")
      .all() as Array<{ completed_at: string }>;
    expect(runs[0]?.completed_at).toBe('2026-04-17T22:30:00.000Z');
  });
});
