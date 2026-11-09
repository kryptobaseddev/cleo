/**
 * Durable worker records and the exit-time SubagentStop (T14359).
 *
 * A detached spawn must NOT emit SubagentStop (the worker is still running);
 * it stores a worker record instead. The record survives a fresh module graph
 * (a new CLI process), `orchestrateStatus` lists it, and SubagentStop fires
 * exactly once, after the worker's process has exited.
 *
 * Real task store and a real child process; only the provider surface is
 * stubbed, as in spawn-execute-claim.test.ts.
 *
 * @task T14359
 */

import { type ChildProcess, spawn } from 'node:child_process';
import type { CLEOSpawnAdapter, CLEOSpawnContext, SpawnResult } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';

const { worker, fakeAdapter } = vi.hoisted(() => {
  const state: { child: ChildProcess | null } = { child: null };
  const adapter: CLEOSpawnAdapter = {
    id: 'fake-adapter',
    providerId: 'fake-provider',
    canSpawn: async () => true,
    spawn: async (ctx: CLEOSpawnContext): Promise<SpawnResult> => {
      const pid = state.child?.pid;
      return {
        instanceId: 'inst-1',
        taskId: ctx.taskId,
        providerId: 'fake-provider',
        status: 'running',
        startTime: new Date().toISOString(),
        ownership: { mode: 'pgid', pid, pgid: pid },
      };
    },
    listRunning: async () => [],
    terminate: async () => undefined,
  };
  return { worker: state, fakeAdapter: adapter };
});

vi.mock('../../spawn/adapter-registry.js', () => ({
  initializeDefaultAdapters: async () => undefined,
  spawnRegistry: {
    get: () => fakeAdapter,
    listSpawnCapable: async () => [fakeAdapter],
  },
}));

vi.mock('@cleocode/caamp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/caamp')>()),
  providerSupportsById: () => true,
  getSpawnCapableProviders: () => [{ id: 'fake-provider' }],
}));

vi.mock('../plan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plan.js')>()),
  openAgentRegistryDbForComposer: async () => ({ close: () => undefined }),
}));

vi.mock('../../orchestration/spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../orchestration/spawn.js')>()),
  composeSpawnPayload: async (_db: object, task: { id: string }) => ({
    taskId: task.id,
    prompt: 'do the work',
    agentId: 'agent-test',
    role: 'worker',
    harnessHint: 'generic',
    atomicity: { allowed: true },
    meta: { protocol: 'implementation' },
  }),
}));

vi.mock('../../sentient/worktree-dispatch.js', () => ({
  spawnWorktree: async () => {
    throw new Error('no worktree in this test');
  },
}));

const SES_A = 'ses_20261109000001_aaaaaa';

/** Count SubagentStop dispatches recorded by a `hooks.dispatch` spy. */
function stopCalls(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter((call) => call[0] === 'SubagentStop');
}

describe('durable worker records (T14359)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Spawned', status: 'pending', priority: 'medium' },
    ]);
    await env.accessor.upsertSingleSession({
      id: SES_A,
      name: 'orchestrator',
      status: 'active',
      scope: { type: 'global' },
      taskWork: { taskId: null, setAt: null },
      startedAt: new Date().toISOString(),
    });
    vi.stubEnv('CLEO_SESSION_ID', SES_A);
    worker.child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
  });

  afterEach(async () => {
    worker.child?.kill('SIGKILL');
    await env.cleanup();
    vi.unstubAllEnvs();
  });

  it('records a detached worker, lists it after a restart, and emits SubagentStop once on exit', async () => {
    const { hooks } = await import('../../hooks/registry.js');
    const spawnSpy = vi.spyOn(hooks, 'dispatch');
    const { orchestrateSpawnExecute } = await import('../spawn-ops.js');
    const result = await orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir, 0, {
      autoComplete: false,
      leadMailbox: 'lead@test',
    });
    expect(result).toMatchObject({ success: true });
    // AC1: the worker is still running, so spawn emits no SubagentStop.
    expect(spawnSpy.mock.calls.some((c) => c[0] === 'SubagentStart')).toBe(true);
    expect(stopCalls(spawnSpy)).toHaveLength(0);

    // AC2: a fresh module graph (a new CLI process) still sees the record.
    vi.resetModules();
    const { orchestrateStatus } = await import('../query-ops.js');
    const status = await orchestrateStatus(undefined, env.tempDir);
    expect(status.success).toBe(true);
    const workers = (status.data as { workers: Array<Record<string, unknown>> }).workers;
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({
      taskId: 'T001',
      instanceId: 'inst-1',
      provider: 'fake-provider',
      pid: worker.child?.pid,
      pgid: worker.child?.pid,
      worktree: env.tempDir,
      leadMailbox: 'lead@test',
      stoppedAt: null,
    });

    // AC1: once the process exits, the next reconcile emits SubagentStop once.
    const { hooks: freshHooks } = await import('../../hooks/registry.js');
    const stopSpy = vi.spyOn(freshHooks, 'dispatch');
    const { reconcileWorkerExits } = await import('../worker-records.js');
    expect(await reconcileWorkerExits(env.tempDir)).toHaveLength(0);
    expect(stopCalls(stopSpy)).toHaveLength(0);

    const exited = new Promise((resolve) => worker.child?.once('exit', resolve));
    worker.child?.kill('SIGKILL');
    await exited;

    const closed = await reconcileWorkerExits(env.tempDir);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.stoppedAt).not.toBeNull();
    expect(await reconcileWorkerExits(env.tempDir)).toHaveLength(0);
    const stops = stopCalls(stopSpy);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.[2]).toMatchObject({ taskId: 'T001', metadata: { instanceId: 'inst-1' } });
  });
});
