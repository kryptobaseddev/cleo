/**
 * `orchestrateSpawnExecute`: `--base` reaches worktree provisioning and a
 * failure under it refuses the spawn (T14046); `CLEO_NO_AUTO_WORKTREE_COMPLETE`
 * skips the post-spawn auto-complete with an audited `complete-skip` row
 * (T14057, worktree-lifecycle MUST-19).
 *
 * Real task store; only the provider surface (adapter registry, CAAMP
 * capability lookup, composer, worktree provisioning, the merge itself) is
 * stubbed.
 *
 * @task T14046
 * @task T14057
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CLEOSpawnAdapter, CLEOSpawnContext, SpawnResult } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';

const { adapterSpawn, fakeAdapter, spawnWorktree, completeWorktreeForTask } = vi.hoisted(() => {
  const spawn = vi.fn(
    async (ctx: CLEOSpawnContext): Promise<SpawnResult> => ({
      instanceId: 'inst-1',
      taskId: ctx.taskId,
      providerId: 'fake-provider',
      status: 'completed',
      exitCode: 0,
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
    spawnWorktree: vi.fn(),
    completeWorktreeForTask: vi.fn(() => ({
      taskId: 'T001',
      outcome: 'merged',
      integration: null,
      reason: 'merged',
    })),
  };
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

vi.mock('../../sentient/worktree-dispatch.js', () => ({ spawnWorktree }));

vi.mock('../worktree-complete.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../worktree-complete.js')>()),
  completeWorktreeForTask,
}));

describe('orchestrateSpawnExecute --base and env-skipped auto-complete', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    vi.stubEnv('CLEO_NO_AUTO_WORKTREE_COMPLETE', undefined);
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Spawned', status: 'pending', priority: 'medium' },
    ]);
    spawnWorktree.mockReset();
    spawnWorktree.mockImplementation(async () => ({
      path: join(env.tempDir, 'wt', 'T001'),
      branch: 'task/T001',
      projectHash: 'abc123',
      reused: false,
    }));
    adapterSpawn.mockClear();
    completeWorktreeForTask.mockClear();
  });

  afterEach(async () => {
    await env.cleanup();
    vi.unstubAllEnvs();
  });

  it('T14046: --base reaches spawnWorktree as baseRef', async () => {
    const { orchestrateSpawnExecute } = await import('../spawn-ops.js');
    const result = await orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir, 0, {
      autoComplete: false,
      baseRef: 'origin/release',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(spawnWorktree).toHaveBeenCalledWith(
      env.tempDir,
      expect.objectContaining({ taskId: 'T001', baseRef: 'origin/release' }),
    );
    expect(adapterSpawn.mock.calls[0]?.[0].workingDirectory).toBe(join(env.tempDir, 'wt', 'T001'));
  });

  it('T14046: a provisioning failure under --base refuses instead of spawning in the project root', async () => {
    spawnWorktree.mockImplementation(async () => {
      throw Object.assign(new Error("base ref 'nope' does not resolve to a commit"), {
        code: 'E_WORKTREE_BASE_INVALID',
      });
    });
    const { orchestrateSpawnExecute } = await import('../spawn-ops.js');
    const result = await orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir, 0, {
      autoComplete: false,
      baseRef: 'nope',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_WORKTREE_BASE_INVALID');
    expect(adapterSpawn).not.toHaveBeenCalled();
  });

  it('T14057: CLEO_NO_AUTO_WORKTREE_COMPLETE skips the merge and writes a complete-skip env-override row', async () => {
    vi.stubEnv('CLEO_NO_AUTO_WORKTREE_COMPLETE', '1');
    const { orchestrateSpawnExecute } = await import('../spawn-ops.js');
    const result = await orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir, 0);
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(adapterSpawn).toHaveBeenCalledTimes(1);
    // No merge, so the worktree and branch are preserved.
    expect(completeWorktreeForTask).not.toHaveBeenCalled();
    const rows = readFileSync(
      join(env.tempDir, '.cleo', 'audit', 'worktree-lifecycle.jsonl'),
      'utf-8',
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, string>);
    expect(rows).toContainEqual(
      expect.objectContaining({ action: 'complete-skip', taskId: 'T001', reason: 'env-override' }),
    );
  });

  it('T14057: without the variable the successful spawn still auto-completes', async () => {
    const { orchestrateSpawnExecute } = await import('../spawn-ops.js');
    const result = await orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir, 0);
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(completeWorktreeForTask).toHaveBeenCalledWith('T001', env.tempDir);
  });
});
