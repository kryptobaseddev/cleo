/**
 * Tests for the Tier-3 autonomous sandbox auto-merge tick.
 *
 * Covers:
 *   - Happy path: mock task + sandbox spawn + verify pass → merge happens
 *   - Verify-failed: mock verify fail → abort, no merge
 *   - FF-failed: mock gitFfMerge returning merged:false → abort, no rebase
 *   - Kill-switch mid-tick: flip kill flag at step post-pick → halt before merge
 *   - Disabled: tier3Enabled=false → skip entirely
 *   - Cadence guard: lastTickAt within TIER3_CADENCE_MS → skip
 *   - No eligible tasks: picker returns null → no-eligible-tasks outcome
 *
 * Docker interactions are mocked via injectable functions — integration tests
 * against real Docker are T1020 scope.
 *
 * @task T946
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __resetKillSwitchCacheForTest, __setKillSwitchForTest } from '../kill-switch.js';
import { DEFAULT_SENTIENT_STATE, readSentientState, writeSentientState } from '../state.js';
import {
  type PatchRecord,
  runTier3Tick,
  type SandboxSpawnRecord,
  type SignRecord,
  TIER3_CADENCE_MS,
  type Tier3TickOptions,
  type VerifyRecord,
} from '../tick.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Minimal Task fixture for Tier-3 tests. */
const TASK_FIXTURE: Task = {
  id: 'T999',
  title: '[T2-TEST] Fix flaky assertion in suite X',
  status: 'proposed',
  priority: 50,
  size: 'small',
} as Task;

/** A mock spawn record returned by the fake sandbox spawner. */
const SPAWN_RECORD: SandboxSpawnRecord = {
  experimentId: '00000000-0000-0000-0000-000000000001',
  worktree: '/tmp/sentient-exp-test',
  receiptId: 'receipt-spawn-001',
};

/** A mock patch record returned by the fake patch waiter. */
const PATCH_RECORD: PatchRecord = {
  patchFiles: ['packages/core/src/foo.ts'],
  patchSummary: 'Fix flaky assertion',
  patchSha: 'a'.repeat(64),
  receiptId: 'receipt-patch-001',
};

/** A mock verify record: all gates passed. */
const VERIFY_RECORD_PASS: VerifyRecord = {
  passed: true,
  gates: [
    { gate: 'qaPassed', passed: true, evidenceAtoms: ['tool:biome'] },
    { gate: 'testsPassed', passed: true, evidenceAtoms: ['test-run:/tmp/out.json'] },
  ],
  afterMetrics: { biomePassed: 1, testsPassed: 1 },
  receiptId: 'receipt-verify-001',
};

/** A mock verify record: gates failed. */
const VERIFY_RECORD_FAIL: VerifyRecord = {
  passed: false,
  gates: [
    { gate: 'qaPassed', passed: true, evidenceAtoms: ['tool:biome'] },
    { gate: 'testsPassed', passed: false, evidenceAtoms: ['test-run:/tmp/out.json'] },
  ],
  afterMetrics: { biomePassed: 1, testsPassed: 0 },
  receiptId: 'receipt-verify-002',
};

/** A mock sign record. */
const SIGN_RECORD: SignRecord = {
  signature: 'b'.repeat(128),
  receiptId: 'receipt-sign-001',
};

// ---------------------------------------------------------------------------
// Fake injectable implementations
// ---------------------------------------------------------------------------

/** Fake picker that returns a task. */
async function fakePickTask(_projectRoot: string): Promise<Task> {
  return TASK_FIXTURE;
}

/** Fake picker that returns null (no eligible tasks). */
async function fakePickTaskNull(_projectRoot: string): Promise<null> {
  return null;
}

/** Fake sandbox spawner that always succeeds. */
async function fakeSpawnSandbox(): Promise<SandboxSpawnRecord> {
  return SPAWN_RECORD;
}

/** Fake sandbox spawner that always throws. */
async function fakeSpawnSandboxThrow(): Promise<SandboxSpawnRecord> {
  throw new Error('docker compose up failed');
}

/** Fake patch waiter that resolves immediately. */
async function fakeWaitForPatch(): Promise<PatchRecord> {
  return PATCH_RECORD;
}

/** Fake verify that passes. */
async function fakeVerifyPass(): Promise<VerifyRecord> {
  return VERIFY_RECORD_PASS;
}

/** Fake verify that fails. */
async function fakeVerifyFail(): Promise<VerifyRecord> {
  return VERIFY_RECORD_FAIL;
}

/** Fake sign that succeeds. */
async function fakeSign(): Promise<SignRecord> {
  return SIGN_RECORD;
}

/** Fake mark-task helper (no-op for tests). */
async function fakeMarkTask(
  _projectRoot: string,
  _taskId: string,
  _mergedSha: string,
): Promise<void> {
  return;
}

/** Fake baseline capture (no KMS / git required). */
async function fakeCaptureBaseline(
  _projectRoot: string,
  _commitSha: string,
): Promise<{ receiptId: string }> {
  return { receiptId: 'receipt-baseline-test' };
}

/** Fake HEAD SHA resolver. */
async function fakeGetHeadSha(_projectRoot: string): Promise<string> {
  return 'aabbccdd00112233aabbccdd00112233aabbccdd';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestContext {
  tmpDir: string;
  statePath: string;
}

async function makeContext(): Promise<TestContext> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'cleo-tier3-'));
  const statePath = join(tmpDir, 'sentient-state.json');
  await writeSentientState(statePath, {
    ...DEFAULT_SENTIENT_STATE,
    tier3Enabled: true,
    tier3LastTickAt: null,
  });
  return { tmpDir, statePath };
}

/**
 * Build baseline Tier3TickOptions with all injectable functions mocked.
 *
 * All injectable functions are provided so no real git, Docker, KMS, or
 * SQLite operations are triggered. Tests can override specific functions
 * via the `overrides` parameter.
 */
function buildOptions(
  statePath: string,
  projectRoot: string,
  overrides: Partial<Tier3TickOptions> = {},
): Tier3TickOptions {
  return {
    projectRoot,
    statePath,
    enabled: true,
    lastTickAt: null,
    pickTask: fakePickTask,
    captureBaseline: fakeCaptureBaseline,
    getHeadSha: fakeGetHeadSha,
    spawnSandbox: fakeSpawnSandbox,
    waitForPatch: fakeWaitForPatch,
    verifyInWorktree: fakeVerifyPass,
    signExperiment: fakeSign,
    markTaskAutoMerged: fakeMarkTask,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Disabled / cadence tests
// ---------------------------------------------------------------------------

// TODO(T1074): unskip once state-pause subsystem ships.
describe('runTier3Tick — disabled', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await makeContext();
    __resetKillSwitchCacheForTest();
    __setKillSwitchForTest(false);
  });

  afterEach(async () => {
    __resetKillSwitchCacheForTest();
    await rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it('returns skipped:disabled when enabled=false', async () => {
    const result = await runTier3Tick(buildOptions(ctx.statePath, ctx.tmpDir, { enabled: false }));
    expect(result.kind).toBe('skipped');
    expect(result.detail).toBe('disabled');
  });

  it('returns skipped:cadence-not-elapsed when lastTickAt is recent', async () => {
    const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    const result = await runTier3Tick(
      buildOptions(ctx.statePath, ctx.tmpDir, {
        lastTickAt: recentTs,
      }),
    );
    expect(result.kind).toBe('skipped');
    expect(result.detail).toBe('cadence-not-elapsed');
  });

  it('does NOT skip when lastTickAt is older than TIER3_CADENCE_MS', async () => {
    // lastTickAt = 20 minutes ago (exceeds 15-min cadence)
    const oldTs = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const result = await runTier3Tick(
      buildOptions(ctx.statePath, ctx.tmpDir, {
        lastTickAt: oldTs,
        // Use null-picker to get a deterministic outcome
        pickTask: fakePickTaskNull,
      }),
    );
    expect(result.kind).toBe('no-eligible-tasks');
  });

  it('TIER3_CADENCE_MS is 15 minutes', () => {
    expect(TIER3_CADENCE_MS).toBe(15 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// No eligible tasks
// ---------------------------------------------------------------------------

// TODO(T1074): unskip once state-pause subsystem ships.
describe('runTier3Tick — no eligible tasks', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await makeContext();
    __resetKillSwitchCacheForTest();
    __setKillSwitchForTest(false);
  });

  afterEach(async () => {
    __resetKillSwitchCacheForTest();
    await rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it('returns no-eligible-tasks when picker returns null', async () => {
    const result = await runTier3Tick(
      buildOptions(ctx.statePath, ctx.tmpDir, {
        pickTask: fakePickTaskNull,
      }),
    );
    expect(result.kind).toBe('no-eligible-tasks');
    expect(result.detail).toMatch(/no tier3-eligible/i);
  });

  it('updates tier3LastTickAt even when no task found', async () => {
    await runTier3Tick(
      buildOptions(ctx.statePath, ctx.tmpDir, {
        pickTask: fakePickTaskNull,
      }),
    );
    const state = await readSentientState(ctx.statePath);
    expect(state.tier3LastTickAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Kill-switch — pre-pick
// ---------------------------------------------------------------------------

// TODO(T1074): unskip once state-pause subsystem ships.
describe('runTier3Tick — kill switch at pre-pick', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await makeContext();
    __resetKillSwitchCacheForTest();
    __setKillSwitchForTest(true); // kill active from the start
  });

  afterEach(async () => {
    __resetKillSwitchCacheForTest();
    await rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it('returns killed when kill switch fires at pre-pick', async () => {
    const result = await runTier3Tick(buildOptions(ctx.statePath, ctx.tmpDir));
    expect(result.kind).toBe('killed');
    expect(result.detail).toMatch(/pre-pick/);
  });

  it('increments ticksKilled in state', async () => {
    await runTier3Tick(buildOptions(ctx.statePath, ctx.tmpDir));
    const state = await readSentientState(ctx.statePath);
    expect(state.tier3Stats.ticksKilled).toBe(1);
  });

  it('does not pick a task when kill fires at pre-pick', async () => {
    let pickerCalled = false;
    await runTier3Tick(
      buildOptions(ctx.statePath, ctx.tmpDir, {
        pickTask: async () => {
          pickerCalled = true;
          return TASK_FIXTURE;
        },
      }),
    );
    expect(pickerCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Kill-switch — post-pick (mid-tick kill)
// ---------------------------------------------------------------------------

// TODO(T1074): unskip once state-pause subsystem ships.
describe('runTier3Tick — kill switch fires mid-tick at post-pick', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await makeContext();
    __resetKillSwitchCacheForTest();
    __setKillSwitchForTest(false);
  });

  afterEach(async () => {
    __resetKillSwitchCacheForTest();
    await rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it('returns killed when kill is activated after pick but before spawn', async () => {
    let pickerCallCount = 0;
    const result = await runTier3Tick(
      buildOptions(ctx.statePath, ctx.tmpDir, {
        pickTask: async () => {
          pickerCallCount++;
          // Activate kill switch after the task is picked.
          __setKillSwitchForTest(true);
          return TASK_FIXTURE;
        },
        spawnSandbox: fakeSpawnSandboxThrow, // should never be reached
      }),
    );
    expect(pickerCallCount).toBe(1);
    expect(result.kind).toBe('killed');
    expect(result.detail).toMatch(/post-pick|pre-spawn/);
  });
});

// ---------------------------------------------------------------------------
// Verify-failed path
// ---------------------------------------------------------------------------

// TODO(T1074): unskip once state-pause subsystem ships.
describe('runTier3Tick — verify failed', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await makeContext();
    __resetKillSwitchCacheForTest();
    __setKillSwitchForTest(false);
  });

  afterEach(async () => {
    __resetKillSwitchCacheForTest();
    await rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it('returns aborted when verify fails', async () => {
    const result = await runTier3Tick(
      buildOptions(ctx.statePath, ctx.tmpDir, {
        // Sandbox spawner that returns a temp dir so cleanup doesn't crash.
        spawnSandbox: async () => ({
          ...SPAWN_RECORD,
          worktree: ctx.tmpDir, // use tmp dir so rm is harmless
        }),
        verifyInWorktree: fakeVerifyFail,
      }),
    );
    expect(result.kind).toBe('aborted');
    expect(result.detail).toMatch(/verify failed/i);
  });

  it('does NOT sign or merge when verify fails', async () => {
    let signCalled = false;
    let markCalled = false;
    await runTier3Tick(
      buildOptions(ctx.statePath, ctx.tmpDir, {
        spawnSandbox: async () => ({ ...SPAWN_RECORD, worktree: ctx.tmpDir }),
        verifyInWorktree: fakeVerifyFail,
        signExperiment: async () => {
          signCalled = true;
          return SIGN_RECORD;
        },
        markTaskAutoMerged: async () => {
          markCalled = true;
        },
      }),
    );
    expect(signCalled).toBe(false);
    expect(markCalled).toBe(false);
  });

  it('increments abortsTotal in state', async () => {
    await runTier3Tick(
      buildOptions(ctx.statePath, ctx.tmpDir, {
        spawnSandbox: async () => ({ ...SPAWN_RECORD, worktree: ctx.tmpDir }),
        verifyInWorktree: fakeVerifyFail,
      }),
    );
    const state = await readSentientState(ctx.statePath);
    expect(state.tier3Stats.abortsTotal).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// FF-failed path
// ---------------------------------------------------------------------------

// TODO(T1074): unskip once state-pause subsystem ships.
describe('runTier3Tick — FF merge failed', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await makeContext();
    __resetKillSwitchCacheForTest();
    __setKillSwitchForTest(false);
  });

  afterEach(async () => {
    __resetKillSwitchCacheForTest();
    await rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it('returns aborted when gitFfMerge returns merged:false (ff-failed-abort)', async () => {
    // We simulate an FF failure by pointing the worktree at a directory that
    // is not a valid git worktree. gitFfMerge will fail to resolve its HEAD,
    // returning { merged: false, reason: 'verify-failed' }.
    const notARepo = join(ctx.tmpDir, 'not-a-repo');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(notARepo, { recursive: true });

    const result = await runTier3Tick(
      buildOptions(ctx.statePath, ctx.tmpDir, {
        spawnSandbox: async () => ({ ...SPAWN_RECORD, worktree: notARepo }),
        verifyInWorktree: fakeVerifyPass,
      }),
    );

    expect(result.kind).toBe('aborted');
    // The detail should mention the merge abort reason.
    expect(result.detail).toMatch(/merge aborted/i);
  });

  it('does NOT call markTaskAutoMerged when FF fails', async () => {
    let markCalled = false;
    const notARepo = join(ctx.tmpDir, 'not-a-repo2');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(notARepo, { recursive: true });

    await runTier3Tick(
      buildOptions(ctx.statePath, ctx.tmpDir, {
        spawnSandbox: async () => ({ ...SPAWN_RECORD, worktree: notARepo }),
        verifyInWorktree: fakeVerifyPass,
        markTaskAutoMerged: async () => {
          markCalled = true;
        },
      }),
    );

    expect(markCalled).toBe(false);
  });

  it('NEVER auto-rebases — only FF merge is attempted', async () => {
    // This is a structural test: the entire Tier-3 tick flow calls gitFfMerge
    // which enforces FF-only. There is no rebase code path in runTier3Tick.
    // We verify that on FF failure the tick aborts rather than rebasing.
    const notARepo = join(ctx.tmpDir, 'not-a-repo3');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(notARepo, { recursive: true });

    const result = await runTier3Tick(
      buildOptions(ctx.statePath, ctx.tmpDir, {
        spawnSandbox: async () => ({ ...SPAWN_RECORD, worktree: notARepo }),
        verifyInWorktree: fakeVerifyPass,
      }),
    );

    // Assert aborted, not some rebase outcome.
    expect(result.kind).toBe('aborted');
    // The detail must mention the abort, not a rebase.
    expect(result.detail).not.toMatch(/rebase/i);
  });
});

// ---------------------------------------------------------------------------
// Happy path (full merge with mocked sandbox + git)
// ---------------------------------------------------------------------------

// TODO(T1074): unskip once state-pause subsystem ships.
describe('runTier3Tick — happy path (mocked FF merge via real git)', () => {
  let ctx: TestContext;
  let repoDir: string;
  let expWorktree: string;

  /**
   * Build a real FF-mergeable git repo so gitFfMerge can succeed.
   * Returns the base repo dir and the experiment worktree path.
   */
  async function buildFFRepo(root: string): Promise<{ baseDir: string; expDir: string }> {
    const { spawn } = await import('node:child_process');
    const baseDir = join(root, 'repo');
    const expDir = join(root, 'exp-wt');
    const GIT_ENV = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@cleo.test',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@cleo.test',
    };

    function git(args: string[], cwd: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const child = spawn('git', args, {
          cwd,
          stdio: 'ignore',
          env: GIT_ENV,
        });
        child.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`git ${args[0]} failed: ${code}`)),
        );
        child.on('error', reject);
      });
    }

    const { mkdir } = await import('node:fs/promises');
    await mkdir(baseDir, { recursive: true });
    await git(['init', '-b', 'main'], baseDir);
    await git(['config', 'user.email', 'test@cleo.test'], baseDir);
    await git(['config', 'user.name', 'Test'], baseDir);
    await writeFile(join(baseDir, 'seed.txt'), 'seed\n');
    await git(['add', 'seed.txt'], baseDir);
    await git(['commit', '-m', 'seed'], baseDir);

    // Create experiment branch and worktree.
    await git(['branch', 'experiment'], baseDir);
    await git(['worktree', 'add', expDir, 'experiment'], baseDir);
    await git(['config', 'user.email', 'test@cleo.test'], expDir);
    await git(['config', 'user.name', 'Test'], expDir);

    // Advance experiment branch.
    await writeFile(join(expDir, 'patch.txt'), 'patch\n');
    await git(['add', 'patch.txt'], expDir);
    await git(['commit', '-m', 'experiment patch'], expDir);

    return { baseDir, expDir };
  }

  beforeEach(async () => {
    ctx = await makeContext();
    const dirs = await buildFFRepo(ctx.tmpDir);
    repoDir = dirs.baseDir;
    expWorktree = dirs.expDir;
    __resetKillSwitchCacheForTest();
    __setKillSwitchForTest(false);
  });

  afterEach(async () => {
    __resetKillSwitchCacheForTest();
    await rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it('returns kind:merged with mergedSha on successful FF merge', async () => {
    const result = await runTier3Tick(
      buildOptions(ctx.statePath, repoDir, {
        pickTask: fakePickTask,
        spawnSandbox: async () => ({ ...SPAWN_RECORD, worktree: expWorktree }),
        waitForPatch: fakeWaitForPatch,
        verifyInWorktree: fakeVerifyPass,
        signExperiment: fakeSign,
        markTaskAutoMerged: fakeMarkTask,
      }),
    );

    expect(result.kind).toBe('merged');
    expect(typeof result.mergedSha).toBe('string');
    expect(result.mergedSha?.length).toBeGreaterThan(0);
    expect(result.taskId).toBe(TASK_FIXTURE.id);
  });

  it('increments mergesCompleted in state on happy path', async () => {
    await runTier3Tick(
      buildOptions(ctx.statePath, repoDir, {
        spawnSandbox: async () => ({ ...SPAWN_RECORD, worktree: expWorktree }),
        verifyInWorktree: fakeVerifyPass,
        signExperiment: fakeSign,
        markTaskAutoMerged: fakeMarkTask,
      }),
    );
    const state = await readSentientState(ctx.statePath);
    expect(state.tier3Stats.mergesCompleted).toBe(1);
    expect(state.tier3Stats.abortsTotal).toBe(0);
  });

  it('calls markTaskAutoMerged on successful merge', async () => {
    let markedTaskId = '';
    let markedSha = '';
    await runTier3Tick(
      buildOptions(ctx.statePath, repoDir, {
        spawnSandbox: async () => ({ ...SPAWN_RECORD, worktree: expWorktree }),
        verifyInWorktree: fakeVerifyPass,
        signExperiment: fakeSign,
        markTaskAutoMerged: async (_root, taskId, sha) => {
          markedTaskId = taskId;
          markedSha = sha;
        },
      }),
    );
    expect(markedTaskId).toBe(TASK_FIXTURE.id);
    expect(markedSha.length).toBeGreaterThan(0);
  });

  it('updates tier3LastTickAt on completion', async () => {
    const before = Date.now();
    await runTier3Tick(
      buildOptions(ctx.statePath, repoDir, {
        spawnSandbox: async () => ({ ...SPAWN_RECORD, worktree: expWorktree }),
        verifyInWorktree: fakeVerifyPass,
        signExperiment: fakeSign,
        markTaskAutoMerged: fakeMarkTask,
      }),
    );
    const state = await readSentientState(ctx.statePath);
    expect(state.tier3LastTickAt).not.toBeNull();
    const ts = new Date(state.tier3LastTickAt!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Kill-switch fires at pre-verify (step 4/5 boundary — mid-tick)
// ---------------------------------------------------------------------------

// TODO(T1074): unskip once state-pause subsystem ships.
describe('runTier3Tick — kill switch fires at pre-verify (halt before merge)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await makeContext();
    __resetKillSwitchCacheForTest();
    __setKillSwitchForTest(false);
  });

  afterEach(async () => {
    __resetKillSwitchCacheForTest();
    await rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it('returns killed when kill switch fires just before verify (post-spawn)', async () => {
    const result = await runTier3Tick(
      buildOptions(ctx.statePath, ctx.tmpDir, {
        spawnSandbox: async () => {
          // Activate kill switch AFTER spawn completes but BEFORE verify.
          __setKillSwitchForTest(true);
          return { ...SPAWN_RECORD, worktree: ctx.tmpDir };
        },
        waitForPatch: fakeWaitForPatch,
        verifyInWorktree: async () => {
          throw new Error('verify should not be called after kill');
        },
      }),
    );
    // The kill fires at the post-spawn OR pre-verify checkpoint.
    expect(result.kind).toBe('killed');
    expect(result.detail).toMatch(/post-spawn|pre-verify/);
  });

  it('does not attempt merge when kill fires before verify', async () => {
    let signCalled = false;
    let markCalled = false;
    await runTier3Tick(
      buildOptions(ctx.statePath, ctx.tmpDir, {
        spawnSandbox: async () => {
          __setKillSwitchForTest(true);
          return { ...SPAWN_RECORD, worktree: ctx.tmpDir };
        },
        waitForPatch: fakeWaitForPatch,
        verifyInWorktree: async () => {
          throw new Error('should not reach verify');
        },
        signExperiment: async () => {
          signCalled = true;
          return SIGN_RECORD;
        },
        markTaskAutoMerged: async () => {
          markCalled = true;
        },
      }),
    );
    expect(signCalled).toBe(false);
    expect(markCalled).toBe(false);
  });
});
