/**
 * Fail-closed worker isolation (T14358): `orchestrateSpawnExecute` with a
 * worktree provision that fails.
 *
 * - `orchestrate.leadWorker.v1` on: the spawn is refused, the adapter never
 *   runs, and the claim returns to the orchestrator (AC2).
 * - flag off: the agent runs in the project root without isolation, as
 *   before (AC3).
 * - a refusal removes a worktree the failing call freshly created, and a
 *   `--base` spawn refuses even with the flag off (T14396).
 *
 * Real task store; only the provider surface (adapter registry, CAAMP
 * capability lookup, composer, worktree provisioning) is stubbed.
 *
 * @task T14358
 * @task T14396
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CLEOSpawnAdapter, CLEOSpawnContext, SpawnResult } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { startTask } from '../../task-work/index.js';
import { resolveIsolation } from '../isolation-policy.js';

const { adapterSpawn, fakeAdapter, spawnWorktreeMock, destroyWorktreeMock } = vi.hoisted(() => {
  const spawn = vi.fn(
    async (ctx: CLEOSpawnContext): Promise<SpawnResult> => ({
      instanceId: 'inst-1',
      taskId: ctx.taskId,
      providerId: 'fake-provider',
      status: 'failed',
      exitCode: 1,
      error: 'stub adapter',
      startTime: new Date().toISOString(),
    }),
  );
  const adapter: CLEOSpawnAdapter = {
    id: 'fake-adapter',
    providerId: 'fake-provider',
    canSpawn: async () => true,
    spawn: (ctx) => spawn(ctx),
    listRunning: async () => [],
    terminate: async () => undefined,
  };
  return {
    adapterSpawn: spawn,
    fakeAdapter: adapter,
    spawnWorktreeMock: vi.fn(async (): Promise<never> => {
      throw new Error('git worktree add failed');
    }),
    destroyWorktreeMock: vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true })),
  };
});

vi.mock('@cleocode/worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/worktree')>()),
  destroyWorktree: destroyWorktreeMock,
}));

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
  spawnWorktree: spawnWorktreeMock,
}));

const SES_A = 'ses_20261110000001_aaaaaa';

/** Set `orchestrate.leadWorker.v1` in the test project's config. */
function setLeadWorkerV1(root: string, on: boolean): void {
  const path = join(root, '.cleo', 'config.json');
  const config = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, object>;
  writeFileSync(path, JSON.stringify({ ...config, orchestrate: { leadWorker: { v1: on } } }));
}

describe('orchestrateSpawnExecute — fail-closed isolation (T14358)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    adapterSpawn.mockClear();
    spawnWorktreeMock.mockClear();
    destroyWorktreeMock.mockClear();
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
    await startTask('T001', env.tempDir, env.accessor);
  });

  afterEach(async () => {
    await env.cleanup();
    vi.unstubAllEnvs();
  });

  it('flag on: a failed provision refuses the spawn and no agent runs (AC2)', async () => {
    setLeadWorkerV1(env.tempDir, true);
    const { orchestrateSpawnExecute } = await import('../spawn-ops.js');
    const result = await orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir, 0, {
      autoComplete: false,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_WORKTREE_PROVISION_FAILED');
    expect(adapterSpawn).not.toHaveBeenCalled();
    expect((await env.accessor.loadSingleTask('T001'))?.claim?.sessionId).toBe(SES_A);
    // A plain failure created no worktree, so nothing is removed.
    expect(destroyWorktreeMock).not.toHaveBeenCalled();
  });

  it('flag on: a refusal removes the worktree the failing call freshly created (T14396 AC1)', async () => {
    setLeadWorkerV1(env.tempDir, true);
    spawnWorktreeMock.mockRejectedValueOnce(
      Object.assign(new Error('hook failed after git worktree add'), {
        freshWorktreeCreated: true,
      }),
    );
    const { orchestrateSpawnExecute } = await import('../spawn-ops.js');
    const result = await orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir, 0, {
      autoComplete: false,
    });

    expect(result.success).toBe(false);
    expect(adapterSpawn).not.toHaveBeenCalled();
    expect(destroyWorktreeMock).toHaveBeenCalledTimes(1);
    expect(destroyWorktreeMock.mock.calls[0]).toEqual([
      env.tempDir,
      expect.objectContaining({ taskId: 'T001', deleteBranch: true, force: true }),
    ]);
    expect(result.error?.details).toMatchObject({
      isolation: 'refused',
      cleanup: { attempted: true, worktreeRemoved: true },
    });
  });

  it('flag off: a spawn with a baseRef refuses a failed provision (T14396 AC2)', async () => {
    setLeadWorkerV1(env.tempDir, false);
    const { orchestrateSpawnExecute } = await import('../spawn-ops.js');
    const result = await orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir, 0, {
      autoComplete: false,
      baseRef: 'origin/no-such-branch',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_WORKTREE_PROVISION_FAILED');
    expect(result.error?.details).toMatchObject({
      taskId: 'T001',
      baseRef: 'origin/no-such-branch',
    });
    expect(adapterSpawn).not.toHaveBeenCalled();
    expect(destroyWorktreeMock).not.toHaveBeenCalled();
    expect((await env.accessor.loadSingleTask('T001'))?.claim?.sessionId).toBe(SES_A);
  });

  it('flag off: a failed provision runs the agent in the project root, as before (AC3)', async () => {
    setLeadWorkerV1(env.tempDir, false);
    const { orchestrateSpawnExecute } = await import('../spawn-ops.js');
    const result = await orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir, 0, {
      autoComplete: false,
    });

    expect(result.success).toBe(true);
    expect(adapterSpawn).toHaveBeenCalledTimes(1);
    expect(adapterSpawn.mock.calls[0]?.[0].workingDirectory).toBe(env.tempDir);
  });
});

describe('resolveIsolation (T14358)', () => {
  const fail = async (): Promise<string> => {
    throw new Error('provision failed');
  };

  it('returns the provision result when provisioning succeeds', async () => {
    const res = await resolveIsolation(async () => 'wt', { failClosed: true });
    expect(res).toEqual({ kind: 'isolated', result: 'wt' });
  });

  it('refuses a failed provision when fail-closed', async () => {
    expect((await resolveIsolation(fail, { failClosed: true })).kind).toBe('refused');
  });

  it('falls back to the project root when not fail-closed', async () => {
    expect((await resolveIsolation(fail, { failClosed: false })).kind).toBe('project-root');
  });

  it('always refuses a worktree held by a live holder (T12506)', async () => {
    const locked = Object.assign(new Error('held'), { code: 'E_WORKTREE_LOCKED' });
    const res = await resolveIsolation(
      async () => {
        throw locked;
      },
      { failClosed: false },
    );
    expect(res).toEqual({ kind: 'refused', error: locked });
  });
});
