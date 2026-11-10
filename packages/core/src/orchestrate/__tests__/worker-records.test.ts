/**
 * Durable worker records and the exit-time SubagentStop (T14359).
 *
 * Behind `orchestrate.leadWorker.v1`, a detached spawn must NOT emit
 * SubagentStop (the worker is still running); it stores a worker record,
 * written before the adapter spawns, instead. The record survives a fresh module graph
 * (a new CLI process), `orchestrateStatus` lists it, and SubagentStop fires
 * exactly once, after the worker's process has exited.
 *
 * Real task store and a real child process; only the provider surface is
 * stubbed, as in spawn-execute-claim.test.ts.
 *
 * @task T14359
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CLEOSpawnAdapter, CLEOSpawnContext, SpawnResult } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';

const { worker, fakeAdapter } = vi.hoisted(() => {
  const state: {
    child: ChildProcess | null;
    /** Report no pid (an adapter with no exit hook and no ownership.pid). */
    noPid: boolean;
    /** Run before spawn returns, e.g. a worker exit hook firing at once. */
    beforeReturn: ((ctx: CLEOSpawnContext) => Promise<void>) | null;
  } = { child: null, noPid: false, beforeReturn: null };
  const adapter: CLEOSpawnAdapter = {
    id: 'fake-adapter',
    providerId: 'fake-provider',
    canSpawn: async () => true,
    spawn: async (ctx: CLEOSpawnContext): Promise<SpawnResult> => {
      const pid = state.child?.pid;
      if (state.beforeReturn) await state.beforeReturn(ctx);
      return {
        instanceId: 'inst-1',
        taskId: ctx.taskId,
        providerId: 'fake-provider',
        status: 'running',
        startTime: new Date().toISOString(),
        ...(state.noPid ? {} : { ownership: { mode: 'pgid', pid, pgid: pid } }),
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

// T14358 — with `orchestrate.leadWorker.v1` on, a failed worktree provision
// refuses the spawn, so provisioning succeeds here: a real temp directory
// stands in for the task's worktree.
const { worktreeDir } = vi.hoisted(() => ({ worktreeDir: { path: '' } }));
vi.mock('../../sentient/worktree-dispatch.js', () => ({
  spawnWorktree: async (_root: string, opts: { taskId: string }) => ({
    path: worktreeDir.path,
    branch: `task/${opts.taskId}`,
    projectHash: 'test-project-hash',
  }),
}));

const SES_A = 'ses_20261109000001_aaaaaa';

/** Turn `orchestrate.leadWorker.v1` on in a test project's config.json. */
function enableWorkerRecords(projectRoot: string): void {
  const file = join(projectRoot, '.cleo', 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  config.orchestrate = { leadWorker: { v1: true } };
  writeFileSync(file, JSON.stringify(config));
}

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
    worker.noPid = false;
    worker.beforeReturn = null;
    worktreeDir.path = mkdtempSync(join(tmpdir(), 'cleo-t14359-wt-'));
  });

  afterEach(async () => {
    worker.child?.kill('SIGKILL');
    rmSync(worktreeDir.path, { recursive: true, force: true });
    await env.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('flag off: no record, SubagentStop at spawn as before', async () => {
    const { hooks } = await import('../../hooks/registry.js');
    const spy = vi.spyOn(hooks, 'dispatch');
    const { orchestrateSpawnExecute } = await import('../spawn-ops.js');
    const result = await orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir, 0, {
      autoComplete: false,
    });
    expect(result).toMatchObject({ success: true });
    expect(stopCalls(spy)).toHaveLength(1);
    const { listWorkerRecords } = await import('../worker-records.js');
    expect(await listWorkerRecords(env.tempDir)).toHaveLength(0);
  });

  it('fails closed: a running worker with no pid and no exit hook stops at spawn', async () => {
    enableWorkerRecords(env.tempDir);
    worker.noPid = true;
    const { hooks } = await import('../../hooks/registry.js');
    const spy = vi.spyOn(hooks, 'dispatch');
    const { orchestrateSpawnExecute } = await import('../spawn-ops.js');
    await orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir, 0, {
      autoComplete: false,
    });
    expect(stopCalls(spy)).toHaveLength(1);
    const { listWorkerRecords, reconcileWorkerExits } = await import('../worker-records.js');
    const records = await listWorkerRecords(env.tempDir);
    expect(records).toHaveLength(1);
    expect(records[0]?.stoppedAt).not.toBeNull();
    expect(await reconcileWorkerExits(env.tempDir)).toHaveLength(0);
    expect(stopCalls(spy)).toHaveLength(1);
  });

  it('an exit hook that fires before spawn returns finds the pre-spawn record', async () => {
    enableWorkerRecords(env.tempDir);
    const { markWorkerExited } = await import('../worker-records.js');
    const exits: Array<{ emitted: boolean }> = [];
    worker.beforeReturn = async (ctx) => {
      const instanceId = ctx.options?.workerInstanceId;
      expect(typeof instanceId).toBe('string');
      exits.push(
        await markWorkerExited({ instanceId: String(instanceId) }, undefined, env.tempDir),
      );
    };
    const { hooks } = await import('../../hooks/registry.js');
    const spy = vi.spyOn(hooks, 'dispatch');
    const { orchestrateSpawnExecute } = await import('../spawn-ops.js');
    await orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir, 0, {
      autoComplete: false,
    });
    expect(exits).toEqual([expect.objectContaining({ emitted: true })]);
    const stops = stopCalls(spy);
    expect(stops).toHaveLength(1);
    // The task is still active, so the exit does not report `complete`.
    expect(stops[0]?.[2]).toMatchObject({ taskId: 'T001', status: 'partial' });
  });

  it('records a detached worker, lists it after a restart, and emits SubagentStop once on exit', async () => {
    enableWorkerRecords(env.tempDir);
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
      worktree: worktreeDir.path,
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

describe('worker exit paths fire SubagentStop exactly once (T14359)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Worker task', status: 'active', priority: 'medium' },
    ]);
  });

  afterEach(async () => {
    await env.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Store one open worker record whose pid the tests declare dead. */
  async function setup() {
    const { hooks } = await import('../../hooks/registry.js');
    const spy = vi.spyOn(hooks, 'dispatch');
    const mod = await import('../worker-records.js');
    await mod.recordWorker(
      {
        taskId: 'T001',
        instanceId: 'inst-9',
        agentId: 'worker-T001',
        provider: 'fake-provider',
        pid: 999_999,
        pgid: 999_999,
        worktree: env.tempDir,
        leadMailbox: null,
        sessionId: 'ses_20261109000002_bbbbbb',
      },
      env.tempDir,
    );
    return { spy, mod, dead: () => false };
  }

  it('hook then sweep: the worker-exit hook emits, the sweep emits nothing', async () => {
    const { spy, mod, dead } = await setup();
    const exit = await mod.markWorkerExited({ instanceId: 'inst-9' }, 'complete', env.tempDir);
    expect(exit.emitted).toBe(true);
    expect(await mod.reconcileWorkerExits(env.tempDir, dead)).toHaveLength(0);
    expect(
      (await mod.markWorkerExited({ instanceId: 'inst-9' }, 'complete', env.tempDir)).emitted,
    ).toBe(false);
    const stops = stopCalls(spy);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.[2]).toMatchObject({ status: 'complete', taskId: 'T001' });
  });

  it('a hook with no --status and the task still active records partial, not complete', async () => {
    const { spy, mod } = await setup();
    expect(
      (await mod.markWorkerExited({ instanceId: 'inst-9' }, undefined, env.tempDir)).emitted,
    ).toBe(true);
    expect(stopCalls(spy)[0]?.[2]).toMatchObject({ status: 'partial', taskId: 'T001' });
  });

  it('a hook with no --status records complete once the task is done', async () => {
    const { spy, mod } = await setup();
    await env.accessor.updateTaskFields('T001', { status: 'done', pipelineStage: 'contribution' });
    await mod.markWorkerExited({ instanceId: 'inst-9' }, undefined, env.tempDir);
    expect(stopCalls(spy)[0]?.[2]).toMatchObject({ status: 'complete', taskId: 'T001' });
  });

  it('sweep then hook: the sweep emits, the late hook emits nothing', async () => {
    const { spy, mod, dead } = await setup();
    expect(await mod.reconcileWorkerExits(env.tempDir, dead)).toHaveLength(1);
    const exit = await mod.markWorkerExited(
      { sessionId: 'ses_20261109000002_bbbbbb' },
      'complete',
      env.tempDir,
    );
    expect(exit.emitted).toBe(false);
    expect(exit.record?.stoppedAt).not.toBeNull();
    const stops = stopCalls(spy);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.[2]).toMatchObject({ status: 'partial', taskId: 'T001' });
  });
});
