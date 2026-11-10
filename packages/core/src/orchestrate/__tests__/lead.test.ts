/**
 * `cleo orchestrate lead <epic>` (T14363): with `orchestrate.leadWorker.v1`
 * on, the lead reaches its provider through the real spawn bridge with Bash,
 * Edit and Write denied, a pre-assigned session id, and the lead mailbox
 * claimed for that session. Flag off, a non-epic id, or a provider that
 * cannot strip tools refuse before any lead runs.
 *
 * Covers both modes (interactive default, `detached`), the lead record (one
 * live lead per epic for as long as its pid lives, not a lease) and the reaper.
 *
 * Real task store, real `orchestrateSpawnExecute` and real
 * `bridgeSpawnAdapter`; only the provider delegate and the composer are stubbed,
 * as in worker-records.test.ts.
 *
 * @task T14363
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    events: string[];
    /** Status the fake lead returns: `completed` = an interactive session that ended. */
    status: SpawnResult['status'];
    /** Pid a detached lead reports, or none. */
    pid: number | undefined;
  } = {
    events: [],
    status: 'running',
    pid: undefined,
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
        status: state.status,
        startTime: new Date().toISOString(),
        ...(state.leadMcp ? { leadMcp: state.leadMcp } : {}),
        ...(state.pid !== undefined
          ? { ownership: { mode: 'pgid' as const, pid: state.pid, pgid: state.pid } }
          : {}),
        ...(ctx.options?.['leadMode'] === 'detached' ? { leadTempDir: '/tmp/none' } : {}),
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

/** An AgentMBX client that records claims and releases, granting (or refusing) claims. */
function fakeMbx(grant: boolean): {
  client: AgentMbxClient;
  claims: Array<{ name: string; session: MbxSession }>;
  releases: MbxSession[];
} {
  const claims: Array<{ name: string; session: MbxSession }> = [];
  const releases: MbxSession[] = [];
  const refused = { ok: false as const, warning: 'agentmbx refused' };
  const client: AgentMbxClient = {
    available: async () => true,
    send: async () => refused,
    inbox: async () => refused,
    status: async () => refused,
    claim: async (name, session) => {
      claims.push({ name, session });
      provider.state.events.push('claim');
      return grant ? { ok: true, value: { name, state: 'bound', unread: 0 } } : refused;
    },
    release: async (session) => {
      releases.push(session);
      provider.state.events.push('release');
      return { ok: true, value: { name: null, state: 'unbound', unread: 0 } };
    },
  };
  return { client, claims, releases };
}

type LeadData = { lead: Record<string, unknown>; agentId?: string };

describe('orchestrateLead (T14363)', () => {
  let env: TestDbEnv;
  const withMailbox = () =>
    setOrchestrate(env.tempDir, {
      leadWorker: { v1: true },
      leadMailbox: { name: MAILBOX, projectId: 'p1', cli: 'claude' },
    });

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
    provider.state.events = [];
    provider.state.status = 'running';
    provider.state.pid = undefined;
    provider.state.leadMcp = { servers: ['cleo-lead', 'mbx'], mailbox: 'loaded' };
  });

  afterEach(async () => {
    vi.useRealTimers();
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

  it('interactive (default): tool-stripped, own session, mailbox claimed on admission and released when the session ends', async () => {
    withMailbox();
    provider.state.status = 'completed'; // the owner ended the interactive session
    const { orchestrateLead } = await import('../lead.js');
    const { LEAD_DENIED_TOOLS, LEAD_RUNNER_TOOL } = await import('@cleocode/contracts');
    const mbx = fakeMbx(true);
    const result = await orchestrateLead('T100', {
      projectRoot: env.tempDir,
      mbxClient: mbx.client,
    });

    expect(result.success).toBe(true);
    const ctx = provider.state.seen[0];
    expect(ctx?.leadDeniedTools).toEqual([...LEAD_DENIED_TOOLS]);
    expect(ctx?.options?.['leadMode']).toBe('interactive');
    expect(ctx?.workingDirectory).toBe(env.tempDir);
    expect(ctx?.options?.['workerInstanceId']).toBeUndefined();
    // The interactive prompt tells the lead to ask with AskUserQuestion.
    expect(ctx?.prompt).toContain('AskUserQuestion');
    expect(ctx?.prompt).not.toContain('hitl.request');
    // Own CLEO session, not the caller's.
    const leadEnv = ctx?.options?.['env'] as Record<string, string> | undefined;
    expect(leadEnv?.['CLEO_SESSION_ID']).toMatch(/^ses_/);
    expect(leadEnv?.['CLEO_SESSION_ID']).not.toBe(SES);
    expect(leadEnv?.['CLEO_AGENT_ROLE']).toBe('lead');

    const data = result.success ? (result.data as LeadData) : null;
    const sessionId = data?.lead['sessionId'];
    expect(data?.agentId).toBe(leadEnv?.['CLEO_AGENT_ID']);
    expect(ctx?.options?.['leadSessionId']).toBe(sessionId);
    expect(data?.lead).toMatchObject({
      mode: 'interactive',
      runnerTool: LEAD_RUNNER_TOOL,
      mailbox: { claimed: true, name: MAILBOX },
      mcp: { servers: ['cleo-lead', 'mbx'], mailbox: 'loaded' },
    });
    // Claimed once admitted (before the lead starts), released when it ended.
    expect(provider.state.events).toEqual(['claim', 'spawn', 'release']);
    expect(mbx.claims).toEqual([{ name: MAILBOX, session: { cli: 'claude', session: sessionId } }]);
    expect(mbx.releases).toEqual([{ cli: 'claude', session: sessionId }]);
    const { readLeadRecord } = await import('../lead-records.js');
    expect(readLeadRecord(env.tempDir, 'T100')).toBeNull();
  });

  it('detached: the prompt names the owner mailbox and the hitl.request shape; the record holds the lead pid', async () => {
    withMailbox();
    provider.state.pid = process.pid;
    const { orchestrateLead } = await import('../lead.js');
    const mbx = fakeMbx(true);
    const result = await orchestrateLead('T100', {
      projectRoot: env.tempDir,
      mbxClient: mbx.client,
      mode: 'detached',
    });
    expect(result).toMatchObject({ success: true, data: { lead: { mode: 'detached' } } });
    const prompt = provider.state.seen[0]?.prompt ?? '';
    expect(provider.state.seen[0]?.options?.['leadMode']).toBe('detached');
    expect(prompt).toContain("owner's mailbox `owner`");
    expect(prompt).toContain('"type":"hitl.request"');
    expect(prompt).toContain('"question"');
    expect(prompt).toContain('"options":[{"label"');
    expect(prompt).toContain('"description"');
    expect(prompt).toContain('"recommended"');
    expect(prompt).toContain('have no `AskUserQuestion`');
    // Still running: mailbox kept, record names the lead's own pid and temp dir.
    expect(mbx.releases).toHaveLength(0);
    const { readLeadRecord } = await import('../lead-records.js');
    expect(readLeadRecord(env.tempDir, 'T100')).toMatchObject({
      pid: process.pid,
      mode: 'detached',
      mailbox: MAILBOX,
      tempDir: '/tmp/none',
    });
  });

  it('one lead per epic holds while the lead lives, past the 30-minute claim lease', async () => {
    withMailbox();
    provider.state.pid = process.pid; // alive for the whole test
    const { orchestrateLead } = await import('../lead.js');
    const mbx = fakeMbx(true);
    const first = await orchestrateLead('T100', {
      projectRoot: env.tempDir,
      mbxClient: mbx.client,
      mode: 'detached',
    });
    expect(first.success).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000); // the claim lease has long lapsed
    const second = await orchestrateLead('T100', {
      projectRoot: env.tempDir,
      mbxClient: mbx.client,
      mode: 'detached',
    });
    expect(second).toMatchObject({ success: false, error: { code: 'E_LEAD_RUNNING' } });
    expect(provider.state.seen).toHaveLength(1);
    expect(mbx.claims).toHaveLength(1);
    expect(mbx.releases).toHaveLength(0);
  });

  it('a dead lead (SIGKILL/OOM) is reaped by the next orchestrate lead: mailbox, session, temp dir, record', async () => {
    withMailbox();
    const { writeLeadRecord, readLeadRecord } = await import('../lead-records.js');
    const tempDir = join(tmpdir(), `cleo-claude-spawn-reap-${process.pid}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'lead-mcp.json'), '{"env":"secret"}');
    writeLeadRecord(env.tempDir, {
      epicId: 'T100',
      pid: 999_999,
      mode: 'detached',
      cleoSessionId: SES,
      providerSessionId: '0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      providerCli: 'claude',
      mailbox: MAILBOX,
      tempDir,
      startedAt: new Date().toISOString(),
    });
    provider.state.status = 'completed';
    const { orchestrateLead } = await import('../lead.js');
    const mbx = fakeMbx(true);
    const result = await orchestrateLead('T100', {
      projectRoot: env.tempDir,
      mbxClient: mbx.client,
      isAlive: (pid) => pid !== 999_999,
    });
    expect(result.success).toBe(true);
    expect(mbx.releases[0]).toEqual({
      cli: 'claude',
      session: '0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
    });
    expect(existsSync(tempDir)).toBe(false);
    expect(readLeadRecord(env.tempDir, 'T100')).toBeNull();
    // The new lead ran.
    expect(provider.state.seen).toHaveLength(1);
  });

  it('orchestrate status reaps a dead lead too', async () => {
    const { writeLeadRecord, readLeadRecord } = await import('../lead-records.js');
    writeLeadRecord(env.tempDir, {
      epicId: 'T100',
      pid: 2_147_483_000, // no such process
      mode: 'detached',
      cleoSessionId: SES,
      providerSessionId: '0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      providerCli: 'claude',
      mailbox: null,
      tempDir: null,
      startedAt: new Date().toISOString(),
    });
    const { orchestrateStatus } = await import('../query-ops.js');
    await orchestrateStatus(undefined, env.tempDir);
    expect(readLeadRecord(env.tempDir, 'T100')).toBeNull();
  });

  it('a lead refused after admission gives the mailbox straight back; one refused before admission never claims', async () => {
    withMailbox();
    provider.state.strip = 'unsupported';
    const { orchestrateLead } = await import('../lead.js');
    const mbx = fakeMbx(true);
    const result = await orchestrateLead('T100', {
      projectRoot: env.tempDir,
      mbxClient: mbx.client,
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'E_LEAD_TOOLS_UNSTRIPPED', exitCode: 63 },
    });
    expect(provider.state.seen).toHaveLength(0);
    expect(mbx.claims).toHaveLength(1);
    expect(mbx.releases).toHaveLength(1);
    const { readLeadRecord } = await import('../lead-records.js');
    expect(readLeadRecord(env.tempDir, 'T100')).toBeNull();
    // Before admission (non-epic): nothing claimed.
    const before = fakeMbx(true);
    await orchestrateLead('T101', { projectRoot: env.tempDir, mbxClient: before.client });
    expect(before.claims).toHaveLength(0);
  });

  it('a failed mailbox claim is reported, not fatal', async () => {
    withMailbox();
    provider.state.status = 'completed';
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
    provider.state.status = 'completed';
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
          mcpWarning: expect.stringContaining('mbx MCP server is configured'),
        },
      },
    });
  });
});
