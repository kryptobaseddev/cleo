/**
 * Integration tests for the orchestrate-spawn timeout supervisor + auto-cleanup
 * pipeline (T9545, Saga T10176, Decision D010).
 *
 * Covers:
 * - {@link runTimeoutCleanup} happy path — calls destroyWorktree with the
 *   expected options and returns a normalised result envelope.
 * - {@link runTimeoutCleanup} timeout path — cleanup that exceeds
 *   {@link CLEANUP_BUDGET_MS} resolves with an error and does NOT throw.
 * - {@link runTimeoutCleanup} idempotency — re-running against an absent
 *   worktree reports `worktreeRemoved: true`.
 * - {@link orchestrateSpawn} happy path — completes under
 *   {@link SPAWN_BUDGET_MS} and returns a success envelope.
 * - {@link orchestrateSpawn} timeout path — when an internal step hangs past
 *   the budget, the function returns `E_TIMEOUT` AND invokes the cleanup pass
 *   so no orphan worktree is left behind.
 *
 * @task T9545
 * @saga T10176
 */

import { describe, expect, it, vi } from 'vitest';
import { CLEANUP_BUDGET_MS, runTimeoutCleanup, SPAWN_BUDGET_MS } from '../spawn-ops.js';

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before the import under test loads.
// ---------------------------------------------------------------------------

const destroyWorktreeMock = vi.fn();
const spawnWorktreeMock = vi.fn();
const validateSpawnReadinessMock = vi.fn();
const composeSpawnPayloadMock = vi.fn();
const getTaskAccessorMock = vi.fn();
const getActiveSessionMock = vi.fn();
const execFileSyncMock = vi.fn();
const execFileMock = vi.fn();
const existsSyncMock = vi.fn();
const acquireWorktreeTaskLockMock = vi.fn();
const releaseWorktreeTaskLockMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  // packages/worktree/src/git.ts imports both execFile and execFileSync;
  // mocking only execFileSync caused 'No "execFile" export' errors when
  // the worktree barrel was loaded via spawn-ops imports.
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    // spawn-ops.ts uses existsSync to gate runLintChangesets — the test
    // expects the script to "exist" so execFileSync is called.
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
  };
});

vi.mock('@cleocode/worktree', async () => {
  const actual = await vi.importActual<typeof import('@cleocode/worktree')>('@cleocode/worktree');
  return {
    ...actual,
    destroyWorktree: (...args: unknown[]) => destroyWorktreeMock(...args),
    acquireWorktreeTaskLock: (...args: unknown[]) => acquireWorktreeTaskLockMock(...args),
    releaseWorktreeTaskLock: (...args: unknown[]) => releaseWorktreeTaskLockMock(...args),
  };
});

vi.mock('../../sentient/worktree-dispatch.js', () => ({
  spawnWorktree: (...args: unknown[]) => spawnWorktreeMock(...args),
}));

vi.mock('../../orchestration/validate-spawn.js', () => ({
  validateSpawnReadiness: (...args: unknown[]) => validateSpawnReadinessMock(...args),
}));

vi.mock('../../orchestration/spawn.js', () => ({
  composeSpawnPayload: (...args: unknown[]) => composeSpawnPayloadMock(...args),
}));

vi.mock('../../store/data-accessor.js', () => ({
  getTaskAccessor: (...args: unknown[]) => getTaskAccessorMock(...args),
}));

vi.mock('../../store/session-store.js', () => ({
  getActiveSession: (...args: unknown[]) => getActiveSessionMock(...args),
  resolveCurrentSession: (...args: unknown[]) => getActiveSessionMock(...args),
  // T12502: spawn claims the task for the child session (orchestrator hand-off
  // lookup) and ends a session it created for a refused spawn.
  resolveBoundSession: async () => null,
  endSession: async () => null,
}));

vi.mock('../../paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
  return {
    ...actual,
    getProjectRoot: (root?: string) => root ?? '/tmp/cleo-spawn-test-root',
  };
});

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Avoid expensive composer/agents subsystem imports — they perform DB I/O
// that is irrelevant to the supervisor tests. The stub satisfies the
// `.close()` contract on the finally block in `composeSpawnForTask`.
vi.mock('../plan.js', () => ({
  openAgentRegistryDbForComposer: vi.fn(async () => ({ close: () => undefined })),
}));

// Imported AFTER the mocks so the orchestrate spawn binding uses them.
const { orchestrateSpawn, runLintChangesets, shouldCleanUpFailedProvision } = await import(
  '../spawn-ops.js'
);

// ---------------------------------------------------------------------------
// runLintChangesets — T10448 pre-spawn hygiene gate
// ---------------------------------------------------------------------------

describe('runLintChangesets — changeset hygiene gate (T10448)', () => {
  it('returns ok=true when the linter exits 0', () => {
    execFileSyncMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValueOnce(true);
    execFileSyncMock.mockReturnValueOnce(
      'lint-changesets: 2 entry/entries validated successfully.\n',
    );

    const result = runLintChangesets('/tmp/cleo-spawn-test-root');
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(execFileSyncMock).toHaveBeenCalledWith(
      process.execPath,
      ['/tmp/cleo-spawn-test-root/scripts/lint-changesets.mjs'],
      {
        cwd: '/tmp/cleo-spawn-test-root',
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  });

  it('returns ok=false with stderr when the linter exits non-zero', () => {
    execFileSyncMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValueOnce(true);
    const err = new Error('Command failed: node scripts/lint-changesets.mjs') as Error & {
      stderr?: string;
      stdout?: string;
      status?: number;
    };
    err.stderr = 'lint-changesets: FAIL — 1 of 3 entries rejected.\n';
    err.stdout = '';
    err.status = 1;
    execFileSyncMock.mockImplementationOnce(() => {
      throw err;
    });

    const result = runLintChangesets('/tmp/cleo-spawn-test-root');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('FAIL');
    expect(result.error).toContain('entries rejected');
  });

  it('returns ok=true when the script is absent (non-monorepo graceful degradation)', () => {
    execFileSyncMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValueOnce(false);
    // The function checks existsSync before calling execFileSync.
    // In the test environment the script path does not exist, so
    // execFileSync should NOT be called.
    const result = runLintChangesets('/nonexistent-project-root');
    expect(result.ok).toBe(true);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runTimeoutCleanup
// ---------------------------------------------------------------------------

describe('runTimeoutCleanup — bounded auto-cleanup helper (T9545)', () => {
  it('returns a normalised result when destroyWorktree succeeds', async () => {
    destroyWorktreeMock.mockReset();
    destroyWorktreeMock.mockResolvedValueOnce({
      taskId: 'T9999',
      worktreeRemoved: true,
      branchDeleted: true,
      dirty: false,
      force: true,
      hookResults: [],
    });

    const result = await runTimeoutCleanup('/tmp/cleo-spawn-test-root', 'T9999');

    expect(result.attempted).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(destroyWorktreeMock).toHaveBeenCalledWith('/tmp/cleo-spawn-test-root', {
      taskId: 'T9999',
      deleteBranch: true,
      force: true,
      reason: 'spawn-timeout-cleanup',
    });
  });

  it('reports its own budget overrun without throwing', async () => {
    destroyWorktreeMock.mockReset();
    // Stall destroyWorktree beyond CLEANUP_BUDGET_MS so the inner race wins.
    destroyWorktreeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                taskId: 'T9999',
                worktreeRemoved: true,
                branchDeleted: true,
                dirty: false,
                force: true,
                hookResults: [],
              }),
            CLEANUP_BUDGET_MS + 250,
          );
        }),
    );

    const result = await runTimeoutCleanup('/tmp/cleo-spawn-test-root', 'T9999');

    expect(result.attempted).toBe(true);
    expect(result.worktreeRemoved).toBe(false);
    expect(result.branchDeleted).toBe(false);
    expect(result.error).toMatch(/Cleanup exceeded/);
  }, 15_000);

  it('returns worktreeRemoved=true when destroyWorktree reports the path is already absent (idempotency)', async () => {
    destroyWorktreeMock.mockReset();
    destroyWorktreeMock.mockResolvedValueOnce({
      taskId: 'T9999',
      worktreeRemoved: true, // destroyWorktree contract: absent path => removed=true
      branchDeleted: true,
      dirty: false,
      force: true,
      hookResults: [],
    });

    const result = await runTimeoutCleanup('/tmp/cleo-spawn-test-root', 'T9999');

    expect(result.worktreeRemoved).toBe(true);
    expect(result.attempted).toBe(true);
  });

  it('captures destroyWorktree errors in result.error without throwing', async () => {
    destroyWorktreeMock.mockReset();
    destroyWorktreeMock.mockResolvedValueOnce({
      taskId: 'T9999',
      worktreeRemoved: false,
      branchDeleted: false,
      error: 'simulated git failure',
      dirty: false,
      force: true,
      hookResults: [],
    });

    const result = await runTimeoutCleanup('/tmp/cleo-spawn-test-root', 'T9999');

    expect(result.attempted).toBe(true);
    expect(result.worktreeRemoved).toBe(false);
    expect(result.error).toBe('simulated git failure');
  });
});

// ---------------------------------------------------------------------------
// SPAWN_BUDGET_MS — T9823 regression lock
// ---------------------------------------------------------------------------

describe('SPAWN_BUDGET_MS (T9823 regression lock)', () => {
  it('is pinned at 180_000ms so large-repo `git worktree add` can complete', () => {
    // The legacy 60s budget caused E_WORKTREE_PROVISION_FAILED on every spawn
    // against the cleocode monorepo (10k+ files). T9823 bumped to 180s.
    expect(SPAWN_BUDGET_MS).toBe(180_000);
  });

  it('is strictly larger than the legacy 60s budget that caused T9823', () => {
    expect(SPAWN_BUDGET_MS).toBeGreaterThan(60_000);
  });

  it('mirrors DEFAULT_GIT_TIMEOUT_MS so per-subprocess + overall budgets stay aligned', async () => {
    const { DEFAULT_GIT_TIMEOUT_MS } = await import('@cleocode/worktree');
    expect(SPAWN_BUDGET_MS).toBe(DEFAULT_GIT_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// orchestrateSpawn — happy path and timeout-with-cleanup
// ---------------------------------------------------------------------------

describe('orchestrateSpawn — supervisor end-to-end (T9545 / Saga T10176)', () => {
  /** Build a no-op task-accessor stub for the validate step. */
  const stubAccessor = (): unknown => ({
    loadSingleTask: vi.fn(async () => ({ id: 'T9999', parentId: null })),
    appendLog: vi.fn(async () => undefined),
    // T12500: spawn allocates the child's OWN session (no orchestrator
    // fallback), so the stub must support the allocation round-trip.
    loadSessions: vi.fn(async () => []),
    upsertSingleSession: vi.fn(async () => undefined),
    // T12502: spawn takes the child session's claim lease.
    claimTask: vi.fn(async () => null),
  });

  it('completes under the spawn budget and returns a success envelope (happy path)', async () => {
    destroyWorktreeMock.mockReset();
    spawnWorktreeMock.mockReset();
    validateSpawnReadinessMock.mockReset();
    composeSpawnPayloadMock.mockReset();
    getTaskAccessorMock.mockReset();
    getActiveSessionMock.mockReset();

    getTaskAccessorMock.mockResolvedValue(stubAccessor());
    getActiveSessionMock.mockResolvedValue({ id: 'sess-1' });
    validateSpawnReadinessMock.mockResolvedValue({ ready: true, issues: [] });
    spawnWorktreeMock.mockResolvedValue({
      path: '/tmp/wt/T9999',
      branch: 'task/T9999',
      taskId: 'T9999',
      baseRef: 'main',
      projectHash: 'deadbeef',
      createdAt: new Date().toISOString(),
      locked: false,
      envVars: {},
      preamble: '',
      appliedExcludePatterns: [],
    });
    composeSpawnPayloadMock.mockResolvedValue({
      atomicity: { allowed: true },
      prompt: '# spawn prompt for T9999',
      agentId: 'cleo-worker',
      role: 'worker',
      tier: 0,
      harnessHint: null,
      meta: { protocol: 'rcasd', composerVersion: '3.0.0' },
      taskId: 'T9999',
    });

    const startedAt = Date.now();
    const result = await orchestrateSpawn('T9999');
    const elapsed = Date.now() - startedAt;

    expect(result.success).toBe(true);
    expect(elapsed).toBeLessThan(SPAWN_BUDGET_MS);
    // Cleanup must NOT have run on the happy path.
    expect(destroyWorktreeMock).not.toHaveBeenCalled();
  });

  it('returns E_TIMEOUT AND runs auto-cleanup when a pipeline step hangs past the budget', async () => {
    // We can't wait the real 60s — override SPAWN_BUDGET_MS via a short-circuited
    // spawnWorktree that rejects with the supervisor's E_TIMEOUT shape. This
    // proves the catch handler triggers auto-cleanup with the captured partial.
    destroyWorktreeMock.mockReset();
    spawnWorktreeMock.mockReset();
    validateSpawnReadinessMock.mockReset();
    composeSpawnPayloadMock.mockReset();
    getTaskAccessorMock.mockReset();
    getActiveSessionMock.mockReset();

    getTaskAccessorMock.mockResolvedValue(stubAccessor());
    getActiveSessionMock.mockResolvedValue({ id: 'sess-1' });
    validateSpawnReadinessMock.mockResolvedValue({ ready: true, issues: [] });

    // First spawnWorktree call: succeed and populate partial state, then
    // composeSpawnPayload throws the supervisor's E_TIMEOUT-shaped error so
    // the catch block runs cleanup against the captured worktree path.
    spawnWorktreeMock.mockResolvedValue({
      path: '/tmp/wt/T9999',
      branch: 'task/T9999',
      taskId: 'T9999',
      baseRef: 'main',
      projectHash: 'deadbeef',
      createdAt: new Date().toISOString(),
      locked: false,
      envVars: {},
      preamble: '',
      appliedExcludePatterns: [],
    });

    composeSpawnPayloadMock.mockImplementationOnce(() => {
      const err = new Error(
        `E_TIMEOUT: spawn pipeline step 'compose-prompt' aborted (budget ${SPAWN_BUDGET_MS}ms exceeded)`,
      );
      (err as Error & { code?: string }).code = 'E_TIMEOUT';
      throw err;
    });

    destroyWorktreeMock.mockResolvedValueOnce({
      taskId: 'T9999',
      worktreeRemoved: true,
      branchDeleted: true,
      dirty: false,
      force: true,
      hookResults: [],
    });

    const result = await orchestrateSpawn('T9999');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_TIMEOUT');
    expect(result.error?.details).toBeDefined();
    const details = result.error?.details as {
      taskId: string;
      step: string;
      partial: { worktreePath?: string };
      cleanup?: { attempted: boolean; worktreeRemoved: boolean };
    };
    expect(details.taskId).toBe('T9999');
    expect(details.step).toBe('compose-prompt');
    expect(details.partial.worktreePath).toBe('/tmp/wt/T9999');
    // Saga T10176 / D010 — cleanup MUST have run automatically.
    expect(details.cleanup).toBeDefined();
    expect(details.cleanup?.attempted).toBe(true);
    expect(details.cleanup?.worktreeRemoved).toBe(true);
    expect(destroyWorktreeMock).toHaveBeenCalledTimes(1);
    expect(destroyWorktreeMock).toHaveBeenCalledWith('/tmp/cleo-spawn-test-root', {
      taskId: 'T9999',
      deleteBranch: true,
      force: true,
      reason: 'spawn-timeout-cleanup',
    });
  });
});

describe('orchestrateSpawn — worktree lock safety (T12506 review)', () => {
  const stubAccessor = (): unknown => ({
    loadSingleTask: vi.fn(async () => ({ id: 'T9999', parentId: null })),
    appendLog: vi.fn(async () => undefined),
    loadSessions: vi.fn(async () => []),
    upsertSingleSession: vi.fn(async () => undefined),
    // T12502: spawn takes the child session's claim lease.
    claimTask: vi.fn(async () => null),
  });
  const lockRecord = { token: 'tok-1' };
  const wtResult = (over: Record<string, unknown> = {}) => ({
    path: '/tmp/wt/T9999',
    branch: 'task/T9999',
    taskId: 'T9999',
    baseRef: 'main',
    projectHash: 'deadbeef',
    createdAt: new Date().toISOString(),
    locked: false,
    reused: false,
    envVars: {},
    preamble: '',
    appliedExcludePatterns: [],
    lock: { status: 'acquired', lockPath: '/x.lock', record: lockRecord },
    ...over,
  });
  const reset = (): void => {
    for (const m of [
      destroyWorktreeMock,
      spawnWorktreeMock,
      validateSpawnReadinessMock,
      composeSpawnPayloadMock,
      getTaskAccessorMock,
      getActiveSessionMock,
      acquireWorktreeTaskLockMock,
      releaseWorktreeTaskLockMock,
      execFileSyncMock,
      existsSyncMock,
    ]) {
      m.mockReset();
    }
    getTaskAccessorMock.mockResolvedValue(stubAccessor());
    getActiveSessionMock.mockResolvedValue({ id: 'sess-1' });
    validateSpawnReadinessMock.mockResolvedValue({ ready: true, issues: [] });
  };
  const atomicityRefusal = {
    atomicity: { allowed: false, code: 'E_ATOMICITY_NO_SCOPE', message: 'no scope' },
    prompt: '',
    agentId: 'cleo-worker',
    role: 'worker',
    tier: 0,
    harnessHint: null,
    meta: { protocol: 'rcasd', composerVersion: '3.0.0' },
    taskId: 'T9999',
  };

  it('shouldCleanUpFailedProvision: only a worktree this call freshly created', () => {
    expect(
      shouldCleanUpFailedProvision(Object.assign(new Error('x'), { freshWorktreeCreated: true })),
    ).toBe(true);
    expect(
      shouldCleanUpFailedProvision(Object.assign(new Error('x'), { freshWorktreeCreated: false })),
    ).toBe(false);
    expect(shouldCleanUpFailedProvision(new Error('EACCES: link failed'))).toBe(false);
    expect(
      shouldCleanUpFailedProvision(
        Object.assign(new Error('E_WORKTREE_LOCKED'), {
          code: 'E_WORKTREE_LOCKED',
          freshWorktreeCreated: true,
        }),
      ),
    ).toBe(false);
  });

  it('a lock I/O failure (e.g. link ENOTSUP/EACCES) never triggers destroyWorktree (item 1)', async () => {
    reset();
    spawnWorktreeMock.mockRejectedValue(
      Object.assign(new Error('E_WORKTREE_LOCKED: could not take the worktree lock (EACCES)'), {
        code: 'E_WORKTREE_LOCKED',
        exitCode: 25,
        holder: null,
        reason: 'lock-unavailable',
        lockPath: '/x.lock',
        fix: 'fix',
      }),
    );
    const result = await orchestrateSpawn('T9999');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_WORKTREE_LOCKED');
    expect(result.error?.exitCode).toBe(25);
    expect(destroyWorktreeMock).not.toHaveBeenCalled();
  });

  it('a generic provisioning error on a pre-existing worktree never triggers destroyWorktree (item 1)', async () => {
    reset();
    spawnWorktreeMock.mockRejectedValue(new Error('ENOTSUP: operation not supported, link'));
    const result = await orchestrateSpawn('T9999');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_WORKTREE_PROVISION_FAILED');
    expect(destroyWorktreeMock).not.toHaveBeenCalled();
  });

  it('cleanup still runs for a worktree this call freshly created', async () => {
    reset();
    spawnWorktreeMock.mockRejectedValue(
      Object.assign(new Error('post-create hook failed'), { freshWorktreeCreated: true }),
    );
    destroyWorktreeMock.mockResolvedValue({
      taskId: 'T9999',
      worktreeRemoved: true,
      branchDeleted: true,
      dirty: false,
      force: true,
      hookResults: [],
    });
    const result = await orchestrateSpawn('T9999');
    expect(result.error?.code).toBe('E_WORKTREE_PROVISION_FAILED');
    expect(destroyWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it('releases the lock when the spawn fails after provisioning, so a retry is not exit 25 (item 2a)', async () => {
    reset();
    spawnWorktreeMock.mockResolvedValue(wtResult());
    composeSpawnPayloadMock.mockResolvedValue(atomicityRefusal);
    const result = await orchestrateSpawn('T9999');
    expect(result.error?.code).toBe('E_ATOMICITY_NO_SCOPE');
    expect(releaseWorktreeTaskLockMock).toHaveBeenCalledWith('deadbeef', 'T9999', 'tok-1');
    expect(destroyWorktreeMock).not.toHaveBeenCalled();
  });

  it('keeps the lock with the agent on success', async () => {
    reset();
    spawnWorktreeMock.mockResolvedValue(wtResult());
    composeSpawnPayloadMock.mockResolvedValue({
      ...atomicityRefusal,
      atomicity: { allowed: true },
    });
    const result = await orchestrateSpawn('T9999');
    expect(result.success).toBe(true);
    expect(releaseWorktreeTaskLockMock).not.toHaveBeenCalled();
  });

  it('--resume takes the lock, never unlocks git, never destroys on timeout (item 2c)', async () => {
    reset();
    existsSyncMock.mockReturnValue(true);
    acquireWorktreeTaskLockMock.mockReturnValue({
      status: 'reentered',
      lockPath: '/x.lock',
      record: { token: 'tok-resume' },
    });
    composeSpawnPayloadMock.mockImplementationOnce(() => {
      throw Object.assign(new Error(`E_TIMEOUT: step 'compose-prompt' aborted`), {
        code: 'E_TIMEOUT',
      });
    });
    const result = await orchestrateSpawn(
      'T9999',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      true,
    );
    expect(result.error?.code).toBe('E_TIMEOUT');
    expect(acquireWorktreeTaskLockMock).toHaveBeenCalledTimes(1);
    expect(destroyWorktreeMock).not.toHaveBeenCalled();
    const unlockCalls = execFileSyncMock.mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('unlock'),
    );
    expect(unlockCalls).toHaveLength(0);
    expect(releaseWorktreeTaskLockMock).toHaveBeenCalledWith(
      expect.any(String),
      'T9999',
      'tok-resume',
    );
  });

  it('--resume against a live foreign holder is refused with exit 25', async () => {
    reset();
    existsSyncMock.mockReturnValue(true);
    acquireWorktreeTaskLockMock.mockImplementation(() => {
      throw Object.assign(new Error('E_WORKTREE_LOCKED: held'), {
        code: 'E_WORKTREE_LOCKED',
        exitCode: 25,
        holder: { sessionId: 'ses_other' },
        reason: 'held',
        lockPath: '/x.lock',
        fix: 'wait',
      });
    });
    const result = await orchestrateSpawn(
      'T9999',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      true,
    );
    expect(result.error?.code).toBe('E_WORKTREE_LOCKED');
    expect(result.error?.exitCode).toBe(25);
    expect(destroyWorktreeMock).not.toHaveBeenCalled();
  });
});
