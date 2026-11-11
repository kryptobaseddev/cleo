/** Product dispatch and real custody stores with an injected, offline Orca process boundary. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { OrcaExecutionBackend } from '@cleocode/adapters/orca-execution';
import type { CLEOSpawnAdapter, CLEOSpawnContext } from '@cleocode/contracts';
import type { OrcaAgent, OrcaAttempt } from '@cleocode/contracts/orca-execution.js';
import { orcaAgentSchema } from '@cleocode/contracts/orca-execution.js';
import { computeProjectHash, resolveTaskWorktreePath } from '@cleocode/paths';
import { acquireWorktreeTaskLock, readWorktreeTaskLock } from '@cleocode/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fixtureContext,
  fixtureReply,
  fixtureRunner,
  orcaFixture,
  runOrcaFixture,
} from '../../../../../adapters/src/__tests__/orca-execution-fixture.js';
import { getConfigValue } from '../../../../../core/src/config/registry.js';
import { hooks } from '../../../../../core/src/hooks/registry.js';
import * as spawnOps from '../../../../../core/src/orchestrate/spawn-ops.js';
import { orchestrateSpawnExecute } from '../../../../../core/src/orchestrate/spawn-ops.js';
import { listWorkerRecords } from '../../../../../core/src/orchestrate/worker-records.js';
import { buildSpawnPrompt } from '../../../../../core/src/orchestration/spawn-prompt.js';
import { governor } from '../../../../../core/src/resources/governor.js';
import {
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../../../../core/src/store/__tests__/test-db-helper.js';

const { project, nativeSpawn, nativeAdapter, provision } = vi.hoisted(() => {
  const spawn = vi.fn(async (context: CLEOSpawnContext) => ({
    instanceId: 'native-fixture',
    taskId: context.taskId,
    providerId: 'codex',
    status: 'running' as const,
    exitCode: 1,
    output: '',
    timing: { startTime: new Date().toISOString() },
  }));
  const adapter: CLEOSpawnAdapter = {
    id: 'codex',
    providerId: 'codex',
    canSpawn: async () => true,
    spawn,
    listRunning: async () => [],
    terminate: async () => undefined,
  };
  return {
    project: { root: '' },
    nativeSpawn: spawn,
    nativeAdapter: adapter,
    provision:
      vi.fn<typeof import('../../../../../core/src/sentient/worktree-dispatch.js').spawnWorktree>(),
  };
});

vi.mock('@cleocode/core/project-scope', async (original) => ({
  ...(await original<typeof import('@cleocode/core/project-scope')>()),
  getProjectRoot: () => project.root,
}));
vi.mock('@cleocode/adapters/orca-execution', async (original) => {
  const actual = await original<typeof import('@cleocode/adapters/orca-execution')>();
  const { fixtureRunner } = await import(
    '../../../../../adapters/src/__tests__/orca-execution-fixture.js'
  );
  return {
    ...actual,
    OrcaExecutionBackend: class extends actual.OrcaExecutionBackend {
      constructor() {
        super(fixtureRunner, 'orca-fixture');
      }
    },
  };
});
vi.mock('../../../../../core/src/spawn/adapter-registry.js', () => ({
  initializeDefaultAdapters: async () => undefined,
  spawnRegistry: { get: () => nativeAdapter, listSpawnCapable: async () => [nativeAdapter] },
}));
vi.mock('@cleocode/caamp', async (original) => ({
  ...(await original<typeof import('@cleocode/caamp')>()),
  providerSupportsById: () => true,
  getSpawnCapableProviders: () => [{ id: 'codex' }],
}));
// The public subpath maps to pipeline/, not the generic test resolver's src/ root.
vi.mock(
  '@cleocode/nexus/reference-spool',
  () => import('../../../../../nexus/src/pipeline/reference-spool.js'),
);
vi.mock('../../../dispatch/domains/playbook.js', () => ({
  acquirePlaybookDb: vi.fn(),
  listPendingApprovalsForDispatch: vi.fn(),
  lookupApprovalByTokenForDispatch: vi.fn(),
}));
vi.mock('../../../../../core/src/orchestrate/plan.js', async (original) => ({
  ...(await original<typeof import('../../../../../core/src/orchestrate/plan.js')>()),
  openAgentRegistryDbForComposer: async () => ({ close: () => undefined }),
}));
vi.mock('../../../../../core/src/orchestration/spawn.js', async (original) => ({
  ...(await original<typeof import('../../../../../core/src/orchestration/spawn.js')>()),
  composeSpawnPayload: async (
    ...[_db, task, options]: Parameters<
      typeof import('../../../../../core/src/orchestration/spawn.js').composeSpawnPayload
    >
  ) => ({
    taskId: task.id,
    agentId: 'fixture-persona',
    role: 'worker',
    harnessHint: options?.harnessHint ?? 'codex',
    prompt: buildSpawnPrompt({
      ...options,
      task,
      protocol: options?.protocol ?? 'implementation',
      projectRoot: options?.projectRoot ?? project.root,
      leadWorkerV1:
        (await getConfigValue('orchestrate.leadWorker.v1', { projectRoot: project.root })) === true,
    }).prompt,
    atomicity: { allowed: true },
    meta: { protocol: options?.protocol ?? 'implementation' },
  }),
}));
vi.mock('../../../../../core/src/sentient/worktree-dispatch.js', () => ({
  spawnWorktree: provision,
}));

import { OrchestrateHandler } from '../../../dispatch/domains/orchestrate.js';

describe('Orca AC1 routing across product worker entry points', () => {
  let env: TestDbEnv;
  let state: OrcaAttempt['state'];
  let currentRun: string | null;
  const disabled = new Set<OrcaAgent>();

  function configure(orchestrate: object): void {
    const path = join(env.cleoDir, 'config.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), orchestrate }));
  }

  function starts() {
    return fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start');
  }
  function selectedAgents() {
    return starts().map(([, args]) => args[args.indexOf('--agent') + 1]);
  }
  function spawn(taskId = 'T001') {
    return new OrchestrateHandler().mutate('spawn.execute', { taskId });
  }

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    vi.stubEnv('CLEO_AGENT_ID', 'fixture-lead');
    env = await createTestDb();
    project.root = env.tempDir;
    vi.stubEnv('CLEO_HOME', realpathSync(join(env.tempDir, '.cleo-home')));
    await seedTasks(
      env.accessor,
      ['T001', 'T002', 'T003', 'T004', 'T005'].map((id) => ({
        id,
        title: `Worker ${id}`,
        status: 'pending',
        priority: 'medium',
      })),
    );
    await env.accessor.upsertSingleSession({
      id: 'ses_fixture_lead',
      name: 'fixture lead',
      status: 'active',
      scope: { type: 'global' },
      taskWork: { taskId: null, setAt: null },
      startedAt: new Date().toISOString(),
    });
    vi.stubEnv('CLEO_SESSION_ID', 'ses_fixture_lead');
    vi.stubEnv('ORCA_TERMINAL_HANDLE', fixtureContext.coordinatorHandle);
    state = 'ready';
    currentRun = 'run_fixture';
    disabled.clear();
    nativeSpawn.mockClear();
    // Routing fixtures have no agents; admission must not depend on the CI host's CPU count.
    const acquire = governor.tryAcquire.bind(governor);
    vi.spyOn(governor, 'tryAcquire').mockImplementation(async (resourceClass, options) =>
      resourceClass === 'agent-session'
        ? {
            deferred: false,
            class: resourceClass,
            slot: -1,
            acquiredAtMs: Date.now(),
            release: async () => undefined,
          }
        : acquire(resourceClass, options),
    );
    provision.mockReset().mockImplementation(async (root, options) => {
      if (!options.holder) throw new Error('Missing allocated worker lock holder');
      const projectHash = computeProjectHash(root);
      const path = resolveTaskWorktreePath(projectHash, options.taskId);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'dirty.txt'), 'owner work');
      const lock = acquireWorktreeTaskLock({
        projectHash,
        taskId: options.taskId,
        holder: options.holder,
      });
      return {
        path,
        branch: `task/${options.taskId}`,
        baseRef: options.baseRef ?? 'HEAD',
        taskId: options.taskId,
        projectHash,
        createdAt: new Date().toISOString(),
        locked: true,
        reused: false,
        lock,
        envVars: {},
        preamble: '',
        hookResults: [],
        appliedPatterns: [],
      };
    });
    orcaFixture.caller = fixtureReply({
      terminal: {
        handle: fixtureContext.coordinatorHandle,
        executionHostId: 'local',
        connected: true,
        writable: true,
      },
    });
    orcaFixture.accounts = fixtureReply({
      codex: { accounts: [], activeAccountId: 'system' },
      opencode: { accounts: [], activeAccountId: 'system' },
      claude: { accounts: [], activeAccountId: 'system' },
    });
    fixtureRunner.mockReset().mockImplementation(async (executable, args, cwd, input) => {
      if (args[1] === 'run-current')
        return fixtureReply({ run: currentRun === null ? null : { id: currentRun } });
      if (args[0] === 'worktree') {
        const path = args[args.indexOf('--worktree') + 1]?.replace(/^path:/, '') ?? '';
        return fixtureReply({
          worktree: {
            id: `workspace-${basename(path)}`,
            path,
            branch: `refs/heads/task/${basename(path)}`,
            hostId: 'local',
            address: { worktree: `identity:${basename(path)}` },
          },
        });
      }
      if (args[1] === 'worker-start') {
        const agent = args[args.indexOf('--agent') + 1];
        const pending = (await listWorkerRecords(cwd)).find(
          (record) =>
            record.instanceId === args[args.indexOf('--task-title') + 1]?.split(':').at(-1),
        );
        expect(pending).toMatchObject({
          pid: null,
          pgid: null,
          execution: { state: 'launching', context: fixtureContext, launch: { prompt: input } },
        });
        if (disabled.has(orcaAgentSchema.parse(agent)))
          return {
            stdout: JSON.stringify({
              ok: false,
              error: { code: 'agent_unconfigured', message: 'Disabled agent' },
              _meta: { runtimeId: fixtureContext.runtimeId },
            }),
            stderr: '',
            exitCode: 1,
          };
        if (state === 'outcome_unknown')
          return { stdout: '', stderr: 'lost receipt', exitCode: null };
        const taskId = args[args.indexOf('--task-title') + 1]?.split(':').at(-2);
        const boundRun = args.includes('--run')
          ? args[args.indexOf('--run') + 1]
          : (currentRun ?? 'run_fixture');
        if (!boundRun) throw new Error('Missing fixture Run');
        currentRun = boundRun;
        return fixtureReply(
          {
            state: state === 'turn_unobserved' ? 'outcome_unknown' : state,
            stage: state === 'turn_unobserved' ? 'turn_start_unobserved' : 'input_accepted',
            dispatchId: `ctx_${taskId}`,
            runId: boundRun,
            taskId: `task_${taskId}`,
            effects: [{ kind: 'worktree', action: 'reused', id: `workspace-${taskId}` }],
            residualResources: [],
            launch: { effective: { agent } },
          },
          state === 'ready' ? 0 : 1,
        );
      }
      return runOrcaFixture(executable, args, cwd, input);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await env.cleanup();
    vi.unstubAllEnvs();
  });

  it('routes spawn-execute and lead-dispatched workers through one canonical preparation and persists before admitting', async () => {
    configure({ leadWorker: { v1: true }, leadMailbox: { name: 'fixture-lead', cli: 'codex' } });
    const stop = vi.spyOn(hooks, 'dispatch');
    const result = await spawn();
    expect(result).toMatchObject({
      success: true,
      data: { backend: 'orca', status: 'running', providerId: 'codex' },
    });
    expect(provision).toHaveBeenCalledTimes(1);
    const [record] = await listWorkerRecords(env.tempDir);
    expect(record).toMatchObject({
      provider: 'codex',
      agentId: 'agent-t001',
      pid: null,
      sessionId: expect.not.stringContaining('lead'),
      leadMailbox: 'fixture-lead',
      execution: { state: 'ready', dispatchId: 'ctx_T001', context: fixtureContext },
    });
    const call = starts()[0];
    expect(call?.[1]).toContain('identity:T001');
    expect(call?.[3]).toContain(record?.worktree);
    expect(call?.[3]).toContain(`CLEO_SESSION_ID='${record?.sessionId}'`);
    expect(call?.[3]).toContain('fixture-lead');
    expect(readWorktreeTaskLock(computeProjectHash(env.tempDir), 'T001')?.agentId).toBe(
      'agent-t001',
    );
    expect(nativeSpawn).not.toHaveBeenCalled();
    expect(stop.mock.calls.some(([name]) => name === 'SubagentStop')).toBe(false);
    expect((await env.accessor.loadSingleTask('T001'))?.status).not.toBe('done');
  });

  it('rotates parallel fanout workers and resumes the project rotation in a new dispatch instance', async () => {
    const result = await new OrchestrateHandler().mutate('fanout', {
      items: ['T001', 'T002', 'T003'].map((taskId) => ({ taskId, team: 'engineering' })),
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      success: true,
      data: { spawned: 3, failed: 0 },
    });
    expect(selectedAgents().sort()).toEqual(['claude', 'codex', 'opencode2']);
    expect(await spawn('T004')).toMatchObject({ success: true, data: { providerId: 'codex' } });
    expect(starts().at(-1)?.[1]).toContain('run_fixture');
    expect(await env.accessor.getMetaValue('orchestrate.orca.lastAgent')).toBe('codex');
    expect(nativeSpawn).not.toHaveBeenCalled();
  });

  it('skips accounts without an active selection and honors configured order and explicit harness restrictions', async () => {
    orcaFixture.accounts = fixtureReply({
      codex: { accounts: [{}], activeAccountId: null },
      opencode: { accounts: [], activeAccountId: null },
      claude: { accounts: [], activeAccountId: 'system' },
    });
    expect(await spawn()).toMatchObject({ success: true, data: { providerId: 'claude-code' } });
    configure({ orca: { agents: ['grok', 'claude'] } });
    expect(await spawn('T002')).toMatchObject({ success: true, data: { providerId: 'grok' } });
    const constrained = await new OrchestrateHandler().mutate('spawn.execute', {
      taskId: 'T003',
      adapterId: 'codex',
    });
    expect(constrained).toMatchObject({
      success: false,
      error: { fix: expect.stringContaining('explicit codex harness') },
    });
    expect(selectedAgents()).toEqual(['claude', 'grok']);
  });

  it('records a disabled id before moving on and never resends that id for the same persisted Run', async () => {
    disabled.add('codex');
    expect(await spawn()).toMatchObject({ success: true, data: { providerId: 'opencode' } });
    const records = await listWorkerRecords(env.tempDir);
    const refused = records.find((record) => record.execution?.startRefusal);
    const active = records.find((record) => record.stoppedAt === null);
    expect(refused).toMatchObject({
      stoppedAt: expect.any(String),
      execution: {
        state: 'failed',
        dispatchId: null,
        resourceState: 'stopped',
        startRefusal: 'agent_unconfigured',
      },
    });
    expect(active?.sessionId).toBe(refused?.sessionId);
    expect(active?.execution?.launch.prompt).toBe(refused?.execution?.launch.prompt);
    expect(await spawn('T002')).toMatchObject({
      success: true,
      data: { providerId: 'claude-code' },
    });
    expect(await spawn('T003')).toMatchObject({ success: true, data: { providerId: 'opencode' } });
    expect(selectedAgents()).toEqual(['codex', 'opencode2', 'claude', 'opencode2']);
  });

  it('retains a lost receipt across another CLI dispatch without falling through to another harness or native worker', async () => {
    state = 'outcome_unknown';
    expect(await spawn()).toMatchObject({
      success: false,
      error: {
        code: 'E_ORCA_ATTEMPT_FENCED',
        fix: expect.stringContaining('original issued request'),
      },
    });
    expect(await spawn()).toMatchObject({
      success: false,
      error: { code: 'E_ORCA_ATTEMPT_FENCED' },
    });
    expect(starts()).toHaveLength(1);
    const [record] = await listWorkerRecords(env.tempDir);
    expect(record?.execution?.state).toBe('outcome_unknown');
    expect((await env.accessor.loadSingleTask('T001'))?.claim?.sessionId).toBe(record?.sessionId);
    expect(readWorktreeTaskLock(computeProjectHash(env.tempDir), 'T001')).not.toBeNull();
    expect(readFileSync(join(record?.worktree ?? '', 'dirty.txt'), 'utf8')).toBe('owner work');
    expect(nativeSpawn).not.toHaveBeenCalled();
  });

  it('admits an unobserved turn as pending custody without completing or releasing the canonical worktree', async () => {
    state = 'turn_unobserved';
    expect(await spawn()).toMatchObject({
      success: true,
      data: { backend: 'orca', status: 'pending', meta: { autoComplete: { ran: false } } },
    });
    expect(readWorktreeTaskLock(computeProjectHash(env.tempDir), 'T001')).not.toBeNull();
    expect(await spawn()).toMatchObject({
      success: false,
      error: { code: 'E_ORCA_ATTEMPT_FENCED' },
    });
    expect(starts()).toHaveLength(1);
  });

  it('refuses exhausted configured routes with a fix and releases only confirmed unsent claims', async () => {
    disabled.add('codex').add('opencode2').add('claude');
    expect(await spawn()).toMatchObject({
      success: false,
      error: { fix: expect.stringContaining('orca account list --json') },
    });
    expect(starts()).toHaveLength(3);
    expect(
      (await listWorkerRecords(env.tempDir)).every((record) => record.stoppedAt !== null),
    ).toBe(true);
    expect((await env.accessor.loadSingleTask('T001'))?.claim).toBeUndefined();
    expect(readWorktreeTaskLock(computeProjectHash(env.tempDir), 'T001')).toBeNull();
    expect(
      readFileSync(
        join(resolveTaskWorktreePath(computeProjectHash(env.tempDir), 'T001'), 'dirty.txt'),
        'utf8',
      ),
    ).toBe('owner work');
    expect(await spawn('T002')).toMatchObject({ success: false });
    expect(starts()).toHaveLength(3);
  });

  it('requires canonical isolation with leadWorker.v1 off and refuses exact account placement', async () => {
    provision.mockRejectedValueOnce(new Error('provision unavailable'));
    expect(await spawn()).toMatchObject({
      success: false,
      error: { fix: expect.stringContaining('canonical worktree') },
    });
    expect(
      await orchestrateSpawnExecute('T002', undefined, undefined, env.tempDir, undefined, {
        orca: new OrcaExecutionBackend(),
        accountId: 'exact-account',
      }),
    ).toMatchObject({
      success: false,
      error: { code: 'E_ORCA_ACCOUNT_UNSUPPORTED', fix: expect.any(String) },
    });
    expect(starts()).toHaveLength(0);
    expect(nativeSpawn).not.toHaveBeenCalled();
  });

  it('returns actionable context and malformed-config refusals without a native fallback', async () => {
    vi.stubEnv('ORCA_TERMINAL_HANDLE', undefined);
    vi.stubEnv('ORCA_WORKTREE_ID', 'context-without-caller');
    expect(await spawn()).toMatchObject({
      success: false,
      error: { code: 'E_ORCA_CONTEXT', fix: expect.stringContaining('ORCA_TERMINAL_HANDLE') },
    });
    vi.stubEnv('ORCA_TERMINAL_HANDLE', fixtureContext.coordinatorHandle);
    configure({ orca: { agents: ['opencode'] } });
    expect(await spawn('T002')).toMatchObject({
      success: false,
      error: { fix: expect.stringContaining('orchestrate.orca.agents') },
    });
    expect(starts()).toHaveLength(0);
    expect(nativeSpawn).not.toHaveBeenCalled();
  });

  it('keeps native execution unchanged outside Orca even when TERM_PROGRAM names Orca', async () => {
    for (const key of [
      'ORCA_TERMINAL_HANDLE',
      'ORCA_WORKTREE_ID',
      'ORCA_WORKSPACE_ID',
      'ORCA_RUNTIME_SOURCE_ID',
      'ORCA_APP_VERSION',
    ])
      vi.stubEnv(key, undefined);
    vi.stubEnv('TERM_PROGRAM', 'Orca');
    expect(await spawn()).toMatchObject({
      success: true,
      data: { providerId: 'codex', instanceId: 'native-fixture' },
    });
    expect(nativeSpawn).toHaveBeenCalledTimes(1);
    expect(fixtureRunner).not.toHaveBeenCalled();
  });

  it('refuses missing active accounts and corrupt durable rotation instead of choosing an unproven route', async () => {
    orcaFixture.accounts = fixtureReply({
      codex: { accounts: [{}], activeAccountId: null },
      opencode: { accounts: [], activeAccountId: null },
      claude: { accounts: [], activeAccountId: null },
    });
    expect(await spawn()).toMatchObject({
      success: false,
      error: { fix: expect.stringContaining('orca account list --json') },
    });
    await env.accessor.setMetaValue('orchestrate.orca.lastAgent', 'unsupported-agent');
    expect(await spawn('T002')).toMatchObject({
      success: false,
      error: { fix: expect.stringContaining('saved project rotation') },
    });
    expect(starts()).toHaveLength(0);
    expect(nativeSpawn).not.toHaveBeenCalled();
  });

  it('preserves an agent-session deferral in fanout before any Orca preparation or process call', async () => {
    vi.mocked(governor.tryAcquire).mockResolvedValueOnce({
      deferred: true,
      class: 'agent-session',
      retryAfterMs: 800,
      reason: 'fixture agent-session budget exhausted',
    });
    const result = await new OrchestrateHandler().mutate('fanout', {
      items: [{ taskId: 'T001', team: 'engineering' }],
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        spawned: 0,
        failed: 1,
        results: [
          {
            taskId: 'T001',
            status: 'failed',
            refusal: { code: 'E_RESOURCE_DEFERRED', exitCode: 75, details: { retryAfterMs: 800 } },
          },
        ],
      },
    });
    expect(provision).not.toHaveBeenCalled();
    expect(fixtureRunner).not.toHaveBeenCalled();
    expect((await env.accessor.loadSingleTask('T001'))?.claim).toBeUndefined();
  });

  it('expires disabled routes when this same coordinator binds a different Run', async () => {
    configure({ orca: { agents: ['codex'] } });
    currentRun = 'run_old';
    disabled.add('codex');
    const refusal = await spawn();
    expect(refusal).toMatchObject({ success: false });
    currentRun = 'run_new';
    disabled.clear();
    expect(await spawn('T002')).toMatchObject({
      success: true,
      data: { providerId: 'codex', execution: { runId: 'run_new' } },
    });
    expect(refusal).toMatchObject({
      error: { fix: expect.stringContaining('orca orchestration run-create') },
    });
    expect(starts().at(-1)?.[1]).toContain('run_new');
  });

  it('does not persist an unbound agent refusal beyond the dispatch invocation', async () => {
    configure({ orca: { agents: ['codex'] } });
    currentRun = null;
    disabled.add('codex');
    expect(await spawn()).toMatchObject({ success: false });
    disabled.clear();
    expect(await spawn('T002')).toMatchObject({ success: true, data: { providerId: 'codex' } });
    expect(selectedAgents()).toEqual(['codex', 'codex']);
  });

  it('fences other tasks until an unknown first launch has a proven Run', async () => {
    currentRun = null;
    state = 'outcome_unknown';
    const first = await spawn();
    const [record] = await listWorkerRecords(env.tempDir);
    expect(first).toMatchObject({
      success: false,
      error: { details: { recordId: record?.recordId } },
    });
    expect(await spawn('T002')).toMatchObject({
      success: false,
      error: {
        details: { recordId: record?.recordId },
        fix: expect.stringContaining(record?.recordId ?? 'missing'),
      },
    });
    expect(starts()).toHaveLength(1);
    expect((await env.accessor.loadSingleTask('T001'))?.claim?.sessionId).toBe(record?.sessionId);
    expect((await env.accessor.loadSingleTask('T002'))?.claim).toBeUndefined();
  });

  it.each([
    'preflight',
    'outcome_unknown',
  ] as const)('keeps last confirmed rotation after %s', async (failure) => {
    expect(await spawn()).toMatchObject({ success: true, data: { providerId: 'codex' } });
    const invoke = fixtureRunner.getMockImplementation();
    if (!invoke) throw new Error('Missing fixture process runner');
    if (failure === 'preflight')
      fixtureRunner.mockImplementation(async (...args) =>
        args[1][0] === 'worktree'
          ? { stdout: '', stderr: 'preflight unavailable', exitCode: null }
          : invoke(...args),
      );
    else state = 'outcome_unknown';
    expect(await spawn('T002')).toMatchObject({ success: false });
    expect(await env.accessor.getMetaValue('orchestrate.orca.lastAgent')).toBe('codex');
    fixtureRunner.mockImplementation(invoke);
    state = 'ready';
    expect(await spawn('T003')).toMatchObject({ success: true, data: { providerId: 'opencode' } });
  });

  it.each([
    true,
    false,
  ])('orders fanout admission only with Orca context hints: %s', async (insideOrca) => {
    if (!insideOrca) vi.stubEnv('ORCA_TERMINAL_HANDLE', undefined);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let bound: string | null = null;
    const usedRuns: string[] = [];
    const execute = vi
      .spyOn(spawnOps, 'orchestrateSpawnExecute')
      .mockImplementation(async (taskId) => {
        const known = bound;
        entered.resolve();
        await release.promise;
        const runId = known ?? `run_${taskId}`;
        bound = runId;
        usedRuns.push(runId);
        return { success: true, data: { instanceId: `worker-${taskId}` } };
      });
    const pending = new OrchestrateHandler().mutate('fanout', {
      items: ['T001', 'T002', 'T003'].map((taskId) => ({ taskId, team: 'engineering' })),
    });
    await entered.promise;
    const startedBeforeReceipt = execute.mock.calls.length;
    release.resolve();
    expect(await pending).toMatchObject({ success: true, data: { spawned: 3, failed: 0 } });
    expect(startedBeforeReceipt).toBe(insideOrca ? 1 : 3);
    expect(usedRuns).toEqual(
      insideOrca ? ['run_T001', 'run_T001', 'run_T001'] : ['run_T001', 'run_T002', 'run_T003'],
    );
  });

  it('returns the retained record id if the Run binding changes after a worker starts', async () => {
    expect(await spawn()).toMatchObject({ success: true });
    const invoke = fixtureRunner.getMockImplementation();
    if (!invoke) throw new Error('Missing fixture process runner');
    fixtureRunner.mockImplementation(async (...args) => {
      const result = await invoke(...args);
      if (args[1][1] === 'worker-start') {
        const key = `orchestrate.orca.run:${createHash('sha256').update(JSON.stringify(fixtureContext)).digest('hex')}`;
        await env.accessor.setMetaValue(key, {
          runId: 'run_changed_concurrently',
          unconfiguredAgents: [],
        });
      }
      return result;
    });
    const result = await spawn('T002');
    const record = (await listWorkerRecords(env.tempDir)).find(
      (worker) => worker.taskId === 'T002',
    );
    expect(record).toMatchObject({
      stoppedAt: null,
      execution: { runId: 'run_fixture', dispatchId: 'ctx_T002' },
    });
    expect(result).toMatchObject({
      success: false,
      error: {
        details: { recordId: record?.recordId },
        fix: expect.stringContaining(record?.recordId ?? 'missing'),
      },
    });
    expect(readWorktreeTaskLock(computeProjectHash(env.tempDir), 'T002')).not.toBeNull();
  });
});
