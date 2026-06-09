/**
 * Tests for the TUI dispatch path + Conductor role-lane builder (T11935).
 *
 * `dispatchWorker` is exercised against a MOCKED gateway SDK client so the spawn
 * path (SDK → gateway) is covered with no daemon: success, daemon-unreachable
 * (no `response`), a rejected spawn envelope, and a thrown transport error all
 * resolve to a typed {@link import('../dispatch.js').DispatchResult} — never a
 * throw (AC3: errors surface inline, never crash). The Conductor lane builder is
 * a pure function tested directly.
 *
 * The mock asserts the SPAWN goes through `client.orchestrate.spawn` with the
 * `{ taskId, tier }` body — i.e. through the SDK, with NO `child_process` /
 * CLI shell-out (AC3).
 *
 * @task T11935
 * @epic T11916
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/** Captured spawn invocations, asserted per-test. */
const spawnCalls: Array<{ body: { taskId: string; tier?: number } }> = [];
/** The next spawn result the mock returns (set per-test). */
let nextSpawnResult: unknown;
/** When set, the mock spawn throws this instead of resolving. */
let spawnThrows: Error | null = null;

vi.mock('@cleocode/core/gateway-client', () => ({
  createCleoClient: () => ({
    orchestrate: {
      spawn: (opts: { body: { taskId: string; tier?: number } }) => {
        spawnCalls.push(opts);
        if (spawnThrows !== null) throw spawnThrows;
        return Promise.resolve(nextSpawnResult);
      },
    },
  }),
}));

// Import AFTER the mock is registered.
const { dispatchWorker, clampTier, buildConductorLane, renderConductorLane } = await import(
  '../dispatch.js'
);

afterEach(() => {
  spawnCalls.length = 0;
  nextSpawnResult = undefined;
  spawnThrows = null;
  vi.clearAllMocks();
});

describe('dispatchWorker — SDK spawn path (T11935 · AC1/AC3)', () => {
  it('calls orchestrate.spawn through the SDK with the taskId + tier body', async () => {
    nextSpawnResult = { response: {}, data: { success: true, data: { worktree: '/wt/T1' } } };
    const result = await dispatchWorker('http://127.0.0.1:7777', 'T1', 2);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.body).toEqual({ taskId: 'T1', tier: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.taskId).toBe('T1');
      expect(result.tier).toBe(2);
      expect(result.data).toEqual({ worktree: '/wt/T1' });
    }
  });

  it('maps a missing `response` (connection refused) to E_GATEWAY_UNREACHABLE', async () => {
    // hey-api yields a result with NO `response` when the daemon is not serving.
    nextSpawnResult = { data: undefined };
    const result = await dispatchWorker('http://127.0.0.1:7777', 'T2');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('E_GATEWAY_UNREACHABLE');
      expect(result.message).toContain('cleo daemon serve');
    }
  });

  it('surfaces a rejected spawn envelope as E_SPAWN_REJECTED with the message', async () => {
    nextSpawnResult = {
      response: {},
      data: { success: false, error: { message: 'task not ready to spawn' } },
    };
    const result = await dispatchWorker('http://127.0.0.1:7777', 'T3');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('E_SPAWN_REJECTED');
      expect(result.message).toBe('task not ready to spawn');
    }
  });

  it('never throws — a transport error resolves to E_SPAWN_ERROR', async () => {
    spawnThrows = new Error('socket hang up');
    const result = await dispatchWorker('http://127.0.0.1:7777', 'T4');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('E_SPAWN_ERROR');
      expect(result.message).toBe('socket hang up');
    }
  });

  it('defaults the tier to 1 when omitted', async () => {
    nextSpawnResult = { response: {}, data: { success: true, data: {} } };
    await dispatchWorker('http://127.0.0.1:7777', 'T5');
    expect(spawnCalls[0]?.body.tier).toBe(1);
  });
});

describe('clampTier (T11935)', () => {
  it('passes through 0 and 2', () => {
    expect(clampTier(0)).toBe(0);
    expect(clampTier(2)).toBe(2);
  });
  it('clamps anything else to 1', () => {
    expect(clampTier(1)).toBe(1);
    expect(clampTier(3)).toBe(1);
    expect(clampTier(-1)).toBe(1);
  });
});

describe('buildConductorLane / renderConductorLane (T11935 · AC2)', () => {
  it('builds the orchestrator → Lead → worker chain', () => {
    const roles = buildConductorLane('T9', null);
    expect(roles.map((r) => r.label)).toEqual(['Orchestrator', 'Lead', 'Worker']);
    expect(roles[2]?.value).toBe('worktree');
    expect(roles[2]?.hint).toContain('T9');
  });

  it('uses a claimed assignee as the worker value when present', () => {
    const roles = buildConductorLane('T9', 'agent-7');
    expect(roles[2]?.value).toBe('agent-7');
  });

  it('renders the chain as a single compact line', () => {
    const line = renderConductorLane(buildConductorLane('T9', null));
    expect(line).toBe('Conductor: Orchestrator(you) → Lead(orchestrate) → Worker(worktree)');
  });
});
