/**
 * The lead's prompt is composed for a LEAD (T14363): `cleo orchestrate lead`
 * passes role `lead` explicitly, so the real composer embeds the tier-1 lead
 * skill excerpts (ct-cleo + ct-lead) and dispatch rules. Nothing in the
 * composer is mocked here; only the provider delegate is.
 *
 * @task T14363
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';

const { provider } = vi.hoisted(() => {
  const state: {
    strip: 'enforced' | 'unsupported';
    seen: SpawnContext[];
    leadMcp: SpawnResult['leadMcp'];
    events: string[];
  } = {
    events: [],
    strip: 'enforced',
    seen: [],
    leadMcp: { servers: ['cleo-lead', 'mbx'], mailbox: 'loaded' },
  };
  const delegate: AdapterSpawnProvider = {
    get leadToolStrip() {
      return state.strip;
    },
    canSpawn: async () => true,
    spawn: async (ctx: SpawnContext): Promise<SpawnResult> => {
      state.seen.push(ctx);
      state.events.push('spawn');
      return {
        instanceId: 'lead-1',
        taskId: ctx.taskId,
        providerId: 'fake-provider',
        status: 'running',
        startTime: new Date().toISOString(),
        ...(state.leadMcp ? { leadMcp: state.leadMcp } : {}),
      };
    },
    listRunning: async () => [],
    terminate: async () => undefined,
  };
  return { provider: { state, delegate } };
});

vi.mock('../../spawn/adapter-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../spawn/adapter-registry.js')>();
  const adapter = () => actual.bridgeSpawnAdapter('fake-provider', provider.delegate);
  return {
    ...actual,
    initializeDefaultAdapters: async () => undefined,
    spawnRegistry: { get: adapter, listSpawnCapable: async () => [adapter()] },
  };
});

vi.mock('@cleocode/caamp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/caamp')>()),
  providerSupportsById: () => true,
  getSpawnCapableProviders: () => [{ id: 'fake-provider' }],
}));

// A lead never provisions a worktree; a worker here would be refused (fail closed).
vi.mock('../../sentient/worktree-dispatch.js', () => ({
  spawnWorktree: async () => {
    throw new Error('no worktree in this test');
  },
}));

const SES = 'ses_20261110000002_bbbbbb';

describe('lead prompt (T14363)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: 'T200', title: 'Lead epic', type: 'epic', status: 'pending', priority: 'high' },
    ]);
    await env.accessor.upsertSingleSession({
      id: SES,
      name: 'orchestrator',
      status: 'active',
      scope: { type: 'global' },
      taskWork: { taskId: null, setAt: null },
      startedAt: new Date().toISOString(),
    });
    vi.stubEnv('CLEO_SESSION_ID', SES);
    const file = join(env.tempDir, '.cleo', 'config.json');
    const config = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    config.orchestrate = { leadWorker: { v1: true } };
    writeFileSync(file, JSON.stringify(config));
    provider.state.seen = [];
  });

  afterEach(async () => {
    await env.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('the composed lead prompt carries the tier-1 lead excerpts (ct-lead) and the lead role', async () => {
    const { orchestrateLead } = await import('../lead.js');
    const result = await orchestrateLead('T200', { projectRoot: env.tempDir });
    expect(result.success).toBe(true);
    const prompt = provider.state.seen[0]?.prompt ?? '';
    expect(prompt).toContain('## Skill Excerpts (tier 1 — lead)');
    expect(prompt).toContain('### ct-lead (phase lead orchestration)');
    expect(result.success ? (result.data as { role?: string }).role : null).toBe('lead');
  });
});
