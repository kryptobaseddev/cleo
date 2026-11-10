/**
 * `cleo orchestrate lead <epic>` (T14363): with `orchestrate.leadWorker.v1`
 * on, the lead reaches its provider through the real spawn bridge with Bash,
 * Edit and Write denied, a pre-assigned session id, and the lead mailbox
 * claimed for that session. Flag off, a non-epic id, or a provider that
 * cannot strip tools refuse before any lead runs.
 *
 * Real task store, real `orchestrateSpawnExecute` and real
 * `bridgeSpawnAdapter`; only the provider delegate and the composer are stubbed,
 * as in worker-records.test.ts.
 *
 * @task T14363
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { AgentMbxClient, MbxSession } from '../agentmbx.js';

const { provider } = vi.hoisted(() => {
  const state: {
    strip: 'enforced' | 'unsupported';
    seen: SpawnContext[];
    leadMcp: SpawnResult['leadMcp'];
  } = {
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

vi.mock('../plan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plan.js')>()),
  openAgentRegistryDbForComposer: async () => ({ close: () => undefined }),
}));

vi.mock('../../orchestration/spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../orchestration/spawn.js')>()),
  composeSpawnPayload: async (_db: object, task: { id: string }) => ({
    taskId: task.id,
    prompt: 'lead the epic',
    agentId: 'agent-lead',
    role: 'lead',
    harnessHint: 'generic',
    atomicity: { allowed: true },
    meta: { protocol: 'implementation' },
  }),
}));

// A lead never provisions a worktree; a worker here would be refused (fail closed).
vi.mock('../../sentient/worktree-dispatch.js', () => ({
  spawnWorktree: async () => {
    throw new Error('no worktree in this test');
  },
}));

const SES = 'ses_20261110000001_aaaaaa';
const MAILBOX = 'cleo-lead@test';

/** Write `orchestrate` settings into a test project's config.json. */
function setOrchestrate(projectRoot: string, orchestrate: Record<string, unknown>): void {
  const file = join(projectRoot, '.cleo', 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  config.orchestrate = orchestrate;
  writeFileSync(file, JSON.stringify(config));
}

/** An AgentMBX client that records claims and grants (or refuses) them. */
function fakeMbx(grant: boolean): {
  client: AgentMbxClient;
  claims: Array<{ name: string; session: MbxSession }>;
} {
  const claims: Array<{ name: string; session: MbxSession }> = [];
  const refused = { ok: false as const, warning: 'agentmbx refused' };
  const client: AgentMbxClient = {
    available: async () => true,
    send: async () => refused,
    inbox: async () => refused,
    status: async () => refused,
    claim: async (name, session) => {
      claims.push({ name, session });
      return grant ? { ok: true, value: { name, state: 'bound', unread: 0 } } : refused;
    },
  };
  return { client, claims };
}

describe('orchestrateLead (T14363)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: 'T100', title: 'Epic', type: 'epic', status: 'pending', priority: 'high' },
      { id: 'T101', title: 'Task', type: 'task', status: 'pending', priority: 'medium' },
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
    provider.state.strip = 'enforced';
    provider.state.seen = [];
    provider.state.leadMcp = { servers: ['cleo-lead', 'mbx'], mailbox: 'loaded' };
  });

  afterEach(async () => {
    await env.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('flag off: refuses with E_LEAD_WORKER_DISABLED and spawns nothing', async () => {
    const { orchestrateLead } = await import('../lead.js');
    const mbx = fakeMbx(true);
    const result = await orchestrateLead('T100', {
      projectRoot: env.tempDir,
      mbxClient: mbx.client,
    });
    expect(result).toMatchObject({ success: false, error: { code: 'E_LEAD_WORKER_DISABLED' } });
    expect(provider.state.seen).toHaveLength(0);
    expect(mbx.claims).toHaveLength(0);
  });

  it('refuses a task that is not an epic', async () => {
    setOrchestrate(env.tempDir, { leadWorker: { v1: true } });
    const { orchestrateLead } = await import('../lead.js');
    const result = await orchestrateLead('T101', { projectRoot: env.tempDir });
    expect(result).toMatchObject({ success: false, error: { code: 'E_VALIDATION' } });
    expect(provider.state.seen).toHaveLength(0);
  });

  it('flag on: the lead reaches the provider without Bash, Edit or Write, mailbox claimed for its session', async () => {
    setOrchestrate(env.tempDir, {
      leadWorker: { v1: true },
      leadMailbox: { name: MAILBOX, projectId: 'p1', cli: 'claude' },
    });
    const { orchestrateLead } = await import('../lead.js');
    const { LEAD_DENIED_TOOLS, LEAD_RUNNER_TOOL } = await import('@cleocode/contracts');
    const mbx = fakeMbx(true);
    const result = await orchestrateLead('T100', {
      projectRoot: env.tempDir,
      mbxClient: mbx.client,
    });

    expect(result.success).toBe(true);
    expect(provider.state.seen).toHaveLength(1);
    const ctx = provider.state.seen[0];
    expect(ctx?.leadDeniedTools).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']));
    expect(ctx?.leadDeniedTools).toEqual([...LEAD_DENIED_TOOLS]);
    // The lead runs in the project root: no worktree was provisioned (that would refuse).
    expect(ctx?.workingDirectory).toBe(env.tempDir);
    // No worker record for the lead.
    expect(ctx?.options?.['workerInstanceId']).toBeUndefined();

    const data = result.success ? (result.data as { lead: Record<string, unknown> }) : null;
    const sessionId = data?.lead['sessionId'];
    expect(ctx?.options?.['leadSessionId']).toBe(sessionId);
    expect(data?.lead).toMatchObject({
      runnerTool: LEAD_RUNNER_TOOL,
      mailbox: { claimed: true, name: MAILBOX },
      // T14423: the provider's MCP report reaches data.lead through the bridge.
      mcp: { servers: ['cleo-lead', 'mbx'], mailbox: 'loaded' },
    });
    expect(data?.lead['mcpWarning']).toBeUndefined();
    expect(mbx.claims).toEqual([{ name: MAILBOX, session: { cli: 'claude', session: sessionId } }]);
    const { listWorkerRecords } = await import('../worker-records.js');
    expect(await listWorkerRecords(env.tempDir)).toHaveLength(0);
  });

  it('a failed mailbox claim is reported, not fatal', async () => {
    setOrchestrate(env.tempDir, {
      leadWorker: { v1: true },
      leadMailbox: { name: MAILBOX, projectId: 'p1', cli: 'claude' },
    });
    const { orchestrateLead } = await import('../lead.js');
    const result = await orchestrateLead('T100', {
      projectRoot: env.tempDir,
      mbxClient: fakeMbx(false).client,
    });
    expect(result).toMatchObject({
      success: true,
      data: { lead: { mailbox: { claimed: false, warning: 'agentmbx refused' } } },
    });
  });

  it('no mbx server configured: data.lead says the lead runs with the runner alone (T14423)', async () => {
    setOrchestrate(env.tempDir, { leadWorker: { v1: true } });
    provider.state.leadMcp = { servers: ['cleo-lead'], mailbox: 'not-configured' };
    const { orchestrateLead } = await import('../lead.js');
    const result = await orchestrateLead('T100', {
      projectRoot: env.tempDir,
      mbxClient: fakeMbx(true).client,
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        lead: {
          mcp: { servers: ['cleo-lead'], mailbox: 'not-configured' },
          mcpWarning: expect.stringContaining('No mbx MCP server'),
        },
      },
    });
  });

  it('a provider that cannot strip tools refuses the lead with E_LEAD_TOOLS_UNSTRIPPED', async () => {
    setOrchestrate(env.tempDir, { leadWorker: { v1: true } });
    provider.state.strip = 'unsupported';
    const { orchestrateLead } = await import('../lead.js');
    const result = await orchestrateLead('T100', {
      projectRoot: env.tempDir,
      mbxClient: fakeMbx(true).client,
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'E_LEAD_TOOLS_UNSTRIPPED', exitCode: 63 },
    });
    expect(provider.state.seen).toHaveLength(0);
  });
});
