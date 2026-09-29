/**
 * `orchestrateSpawnExecute` claim rollback (T12502): an adapter that REPORTS
 * a failed spawn (status `failed`, no throw) never started the child, so the
 * task claim the spawn took must return to the orchestrator and the child
 * session must be ended — exactly as for a spawn that throws.
 *
 * Real task store; only the provider surface (adapter registry, CAAMP
 * capability lookup, composer, worktree provisioning) is stubbed.
 *
 * @task T12502
 */

import type { CLEOSpawnAdapter, CLEOSpawnContext, SpawnResult } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { startTask } from '../../task-work/index.js';

const { adapterSpawn, fakeAdapter } = vi.hoisted(() => {
  const spawn = vi.fn(
    async (ctx: CLEOSpawnContext): Promise<SpawnResult> => ({
      instanceId: 'inst-1',
      taskId: ctx.taskId,
      providerId: 'fake-provider',
      status: 'failed',
      exitCode: 1,
      error: 'provider refused to start the agent',
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
  return { adapterSpawn: spawn, fakeAdapter: adapter };
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

const SES_A = 'ses_20260929000001_aaaaaa';

describe('orchestrateSpawnExecute — claim rollback on a reported failure (T12502)', () => {
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
  });

  afterEach(async () => {
    await env.cleanup();
    vi.unstubAllEnvs();
  });

  it('an adapter returning status `failed` hands the claim back to the orchestrator', async () => {
    await startTask('T001', env.tempDir, env.accessor);
    expect((await env.accessor.loadSingleTask('T001'))?.claim?.sessionId).toBe(SES_A);

    const { orchestrateSpawnExecute } = await import('../spawn-ops.js');
    const result = await orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir, 0, {
      autoComplete: false,
    });
    expect(adapterSpawn).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);

    expect((await env.accessor.loadSingleTask('T001'))?.claim?.sessionId).toBe(SES_A);
    const children = (await env.accessor.loadSessions()).filter((s) => s.id !== SES_A);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) expect(child.status).toBe('ended');
  });
});
