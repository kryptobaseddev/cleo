/**
 * Tests for the "all gates green" hint in validateGateVerify (GH #94 / T919).
 *
 * Policy (b): cleo verify NEVER auto-completes a task. When the final gate
 * write drives verification.passed to true, the response MUST include a
 * `hint` field directing the user to run `cleo complete <taskId>`.
 *
 * Test matrix:
 * - Setting the last required gate → hint present
 * - Setting a gate when others are still missing → no hint
 * - View mode (no write) → no hint
 * - Reset mode → no hint
 *
 * @task T919
 * @epic T911
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSqliteDataAccessor,
  resetDbState,
  validateGateVerify,
} from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedTasks } from '../../store/__tests__/test-db-helper.js';
import { getDb } from '../../store/sqlite.js';
import * as schema from '../../store/tasks-schema.js';

/** Absolute project root for each test — recreated per test. */
let TEST_ROOT: string;

/**
 * Real commit SHA produced by initGitRepoWithCommit — used as `commit:` evidence
 * so writes to critical gates (implemented/testsPassed) pass content-intersect
 * (T9245) without relying on CLEO_OWNER_OVERRIDE (which T9245 also blocks).
 */
let SEED_COMMIT_SHA: string;

/**
 * Initialise a git repo at TEST_ROOT with a single commit touching the path
 * declared by the task's AC. The commit SHA is captured in SEED_COMMIT_SHA
 * and used as evidence in the verify calls below.
 */
function initGitRepoWithCommit(taskFile: string): void {
  const git = (args: string[]): string => execFileSync('git', args, { cwd: TEST_ROOT }).toString();
  git(['init', '-q']);
  git(['config', 'user.name', 'gate-verify-hint test']);
  git(['config', 'user.email', 'hint@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(TEST_ROOT, taskFile), 'seed\n');
  git(['add', taskFile]);
  git(['commit', '-q', '-m', 'seed']);
  SEED_COMMIT_SHA = git(['rev-parse', 'HEAD']).trim();
}

/**
 * Minimal config that:
 * - limits required gates to just two (implemented + testsPassed) so tests
 *   can drive passed=true without running the full 5-gate gauntlet.
 * - disables session enforcement so tests don't need active sessions.
 */
const MINIMAL_CONFIG = {
  enforcement: {
    session: { requiredForMutate: false },
    acceptance: { mode: 'off' },
  },
  verification: {
    enabled: true,
    requiredGates: ['implemented', 'testsPassed'],
  },
  lifecycle: { mode: 'off' },
};

async function setupTestRoot(): Promise<void> {
  const cleoDir = join(TEST_ROOT, '.cleo');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cleoDir, { recursive: true });
  await writeFile(join(cleoDir, 'config.json'), JSON.stringify(MINIMAL_CONFIG));
}

async function seedTask(taskId: string): Promise<void> {
  const accessor = await createSqliteDataAccessor(TEST_ROOT);
  await seedTasks(accessor, [
    {
      id: taskId,
      title: `Test task ${taskId}`,
      type: 'task',
      status: 'active',
      priority: 'medium',
      acceptance: ['AC1'],
      // T9245: declare an AC file so commit content-intersect can validate.
      files: ['seed.ts'],
    },
  ]);
  await accessor.close();
  resetDbState();
}

async function insertAcRow(taskId: string, ordinal: number): Promise<string> {
  const acId = randomUUID();
  const db = await getDb(TEST_ROOT);
  await db
    .insert(schema.taskAcceptanceCriteria)
    .values({ id: acId, taskId, ordinal, text: `AC body ${ordinal}` })
    .run();
  return acId;
}

async function getBindingsForAc(acId: string) {
  const accessor = await createSqliteDataAccessor(TEST_ROOT);
  const bindings = await accessor.getAcBindings([acId]);
  await accessor.close();
  return bindings;
}

/**
 * Path to a synthetic vitest-format test-run JSON written under TEST_ROOT.
 * Provides hard evidence for the `testsPassed` gate without invoking a real
 * toolchain.
 */
let TEST_RUN_JSON_PATH: string;

/**
 * Write a synthetic vitest-format JSON file representing a passing test run.
 * Captured in TEST_RUN_JSON_PATH for use as `test-run:` evidence.
 */
function writeTestRunJson(): void {
  TEST_RUN_JSON_PATH = join(TEST_ROOT, 'test-run.json');
  writeFileSync(
    TEST_RUN_JSON_PATH,
    JSON.stringify({
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [{ status: 'passed', name: 'seed' }],
    }),
  );
}

/**
 * Returns the evidence string suitable for the requested critical gate.
 * - implemented: commit + files (intersects task.files = ['seed.ts'])
 * - testsPassed: test-run JSON anchored under TEST_ROOT
 *
 * Returns undefined for non-critical gates — caller can omit evidence safely.
 */
function evidenceFor(gate: string): string | undefined {
  if (gate === 'implemented') return `commit:${SEED_COMMIT_SHA};files:seed.ts`;
  if (gate === 'testsPassed') return `test-run:${TEST_RUN_JSON_PATH}`;
  return undefined;
}

/**
 * Build an evidence string for `all:true` (sets every required gate at once).
 * Combines all hard atoms for implemented + testsPassed in a single payload.
 */
function evidenceForAll(): string {
  return `commit:${SEED_COMMIT_SHA};files:seed.ts;test-run:${TEST_RUN_JSON_PATH}`;
}

describe('validateGateVerify — hint field (GH #94 / T919)', () => {
  beforeEach(async () => {
    resetDbState();
    TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-gate-hint-'));
    await setupTestRoot();
    // T9245: real evidence is required for critical gates (implemented/
    // testsPassed). Initialise a tiny git repo + synthetic test-run JSON so
    // the verify calls below can supply hard atoms without override.
    initGitRepoWithCommit('seed.ts');
    writeTestRunJson();
  });

  afterEach(async () => {
    resetDbState();
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it('emits hint when setting the final gate drives verification.passed to true', async () => {
    await seedTask('T100');
    // First: set 'implemented'
    await validateGateVerify(TEST_ROOT, {
      taskId: 'T100',
      gate: 'implemented',
      value: true,
      evidence: evidenceFor('implemented'),
    });
    resetDbState();
    // Second: set 'testsPassed' — this is the final required gate
    const result = await validateGateVerify(TEST_ROOT, {
      taskId: 'T100',
      gate: 'testsPassed',
      value: true,
      evidence: evidenceFor('testsPassed'),
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.passed).toBe(true);
    expect(data.missingGates).toHaveLength(0);
    expect(data.hint).toBe('All gates green. Run: cleo complete T100');
  });

  it('does NOT emit hint when setting a gate but others are still missing', async () => {
    await seedTask('T101');
    // Set only 'implemented' — 'testsPassed' still missing
    const result = await validateGateVerify(TEST_ROOT, {
      taskId: 'T101',
      gate: 'implemented',
      value: true,
      evidence: evidenceFor('implemented'),
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.passed).toBe(false);
    expect(data.hint).toBeUndefined();
  });

  it('does NOT emit hint on view mode (no write)', async () => {
    await seedTask('T102');
    // View mode: no gate/all/reset param
    const result = await validateGateVerify(TEST_ROOT, { taskId: 'T102' });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('view');
    expect(data.hint).toBeUndefined();
  });

  it('does NOT emit hint on reset mode', async () => {
    await seedTask('T103');
    // First set all gates green
    await validateGateVerify(TEST_ROOT, {
      taskId: 'T103',
      gate: 'implemented',
      value: true,
      evidence: evidenceFor('implemented'),
    });
    resetDbState();
    await validateGateVerify(TEST_ROOT, {
      taskId: 'T103',
      gate: 'testsPassed',
      value: true,
      evidence: evidenceFor('testsPassed'),
    });
    resetDbState();
    // Now reset — should not emit hint even though gates were green before
    const result = await validateGateVerify(TEST_ROOT, { taskId: 'T103', reset: true });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('reset');
    expect(data.passed).toBe(false);
    expect(data.hint).toBeUndefined();
  });

  it('emits hint when --all is used and all gates become green', async () => {
    await seedTask('T104');
    // Set all required gates at once via all=true. T9245 requires hard atoms
    // for implemented + testsPassed; provide both in a single evidence string.
    const result = await validateGateVerify(TEST_ROOT, {
      taskId: 'T104',
      all: true,
      evidence: evidenceForAll(),
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.passed).toBe(true);
    expect(data.action).toBe('set_all');
    expect(data.hint).toBe('All gates green. Run: cleo complete T104');
  });

  /**
   * GH #94 / T9900 — Reproduction test for the original bug report.
   *
   * Per the canonical contract (ADR-051 Pre-Complete Gate Ritual + policy (b)
   * in validateGateVerify): `cleo verify` is a write to `task.verification`
   * ONLY. It MUST NOT mutate `task.status`. Even when the final gate write
   * drives `verification.passed = true`, the task lifecycle stays put until
   * an explicit `cleo complete <id>` runs and re-validates evidence
   * (E_EVIDENCE_STALE protection).
   *
   * This test seeds a task with `status: 'pending'` (the exact shape the
   * GH #94 reporter observed) and asserts:
   *   1. The engine's response carries `status: 'pending'` after gates green
   *   2. The hint field directs the user to run `cleo complete`
   *   3. The task in the data store still has `status: 'pending'`
   *      (verified by reloading via the accessor)
   *
   * @task T9900
   * @gh 94
   */
  it('keeps task.status as pending after all gates green (GH #94 reproduction)', async () => {
    const taskId = 'T9094';
    // Seed task with status 'pending' — the exact scenario GH #94 reported
    // for T448 / T466 (docs tasks shipped at commit d70129a).
    const accessor = await createSqliteDataAccessor(TEST_ROOT);
    await seedTasks(accessor, [
      {
        id: taskId,
        title: `GH #94 reproduction task`,
        type: 'task',
        status: 'pending',
        priority: 'medium',
        acceptance: ['AC1'],
        files: ['seed.ts'],
      },
    ]);
    await accessor.close();
    resetDbState();

    // Drive both required gates green via separate verify calls (the path
    // that GH #94 reported was the one to misbehave).
    await validateGateVerify(TEST_ROOT, {
      taskId,
      gate: 'implemented',
      value: true,
      evidence: evidenceFor('implemented'),
    });
    resetDbState();
    const result = await validateGateVerify(TEST_ROOT, {
      taskId,
      gate: 'testsPassed',
      value: true,
      evidence: evidenceFor('testsPassed'),
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;

    // Contract assertion 1 — engine result reports verification.passed=true
    // but task.status STAYS pending (never auto-transitions to 'done').
    expect(data.passed).toBe(true);
    expect(data.missingGates).toHaveLength(0);
    expect(data.status).toBe('pending');

    // Contract assertion 2 — hint instructs the user to call cleo complete.
    expect(data.hint).toBe(`All gates green. Run: cleo complete ${taskId}`);

    // Contract assertion 3 — re-read from the store confirms persistence:
    // verification is set, but the lifecycle status is untouched.
    resetDbState();
    const verifyAccessor = await createSqliteDataAccessor(TEST_ROOT);
    const reloaded = await verifyAccessor.loadSingleTask(taskId);
    await verifyAccessor.close();
    expect(reloaded).toBeDefined();
    expect(reloaded?.status).toBe('pending');
    expect(reloaded?.verification?.passed).toBe(true);
  });

  it('persists satisfies evidence as an AC binding against the canonical AC UUID', async () => {
    const taskId = 'T10593';
    await seedTask(taskId);
    const acId = await insertAcRow(taskId, 1);
    resetDbState();

    const result = await validateGateVerify(TEST_ROOT, {
      taskId,
      gate: 'implemented',
      value: true,
      evidence: `${evidenceFor('implemented')};satisfies:${taskId}#AC1`,
    });

    expect(result.success).toBe(true);
    const bindings = await getBindingsForAc(acId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      acId,
      bindingType: 'satisfies',
      evidenceAtomId: `satisfies:${taskId}->${taskId}#AC1`,
    });
  });

  it('collapses duplicate satisfies bindings for the same atom/ac/type triple', async () => {
    const taskId = 'T10594';
    await seedTask(taskId);
    const acId = await insertAcRow(taskId, 1);
    const evidence = `${evidenceFor('implemented')};satisfies:${taskId}#AC1`;
    resetDbState();

    const first = await validateGateVerify(TEST_ROOT, {
      taskId,
      gate: 'implemented',
      value: true,
      evidence,
    });
    expect(first.success).toBe(true);
    resetDbState();
    const second = await validateGateVerify(TEST_ROOT, {
      taskId,
      gate: 'implemented',
      value: true,
      evidence,
    });
    expect(second.success).toBe(true);

    const bindings = await getBindingsForAc(acId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.acId).toBe(acId);
    expect(bindings[0]?.bindingType).toBe('satisfies');
  });
});

// ---------------------------------------------------------------------------
// gh#1105 / T12015 — override + soft evidence is rejected AT VERIFY, matching
// the complete-side T9245 hard-atom check (no accept-then-reject divergence).
// ---------------------------------------------------------------------------

describe('validateGateVerify — critical-gate override parity (gh#1105 / T12015)', () => {
  let savedOverride: string | undefined;
  let savedReason: string | undefined;
  let savedRole: string | undefined;

  beforeEach(async () => {
    resetDbState();
    TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-gate-1105-'));
    await setupTestRoot();
    initGitRepoWithCommit('seed.ts');
    writeTestRunJson();
    // Owner-override context. CLEO_AGENT_ROLE must be cleared — readOverrideState
    // downgrades the override for worker/lead/subagent roles.
    savedOverride = process.env.CLEO_OWNER_OVERRIDE;
    savedReason = process.env.CLEO_OWNER_OVERRIDE_REASON;
    savedRole = process.env.CLEO_AGENT_ROLE;
    process.env.CLEO_OWNER_OVERRIDE = '1';
    process.env.CLEO_OWNER_OVERRIDE_REASON = 'gh#1105 parity test';
    delete process.env.CLEO_AGENT_ROLE;
  });

  afterEach(async () => {
    if (savedOverride === undefined) delete process.env.CLEO_OWNER_OVERRIDE;
    else process.env.CLEO_OWNER_OVERRIDE = savedOverride;
    if (savedReason === undefined) delete process.env.CLEO_OWNER_OVERRIDE_REASON;
    else process.env.CLEO_OWNER_OVERRIDE_REASON = savedReason;
    if (savedRole === undefined) delete process.env.CLEO_AGENT_ROLE;
    else process.env.CLEO_AGENT_ROLE = savedRole;
    resetDbState();
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it('REJECTS testsPassed at verify when override is combined with note-only evidence', async () => {
    await seedTask('T200');
    const result = await validateGateVerify(TEST_ROOT, {
      taskId: 'T200',
      gate: 'testsPassed',
      value: true,
      evidence: 'note:owner-says-ok',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_CRITICAL_GATE_OVERRIDE_REJECTED');
    expect(result.error?.message).toMatch(/T9245/);
  });

  it('REJECTS implemented at verify when override is combined with url-only evidence', async () => {
    await seedTask('T201');
    const result = await validateGateVerify(TEST_ROOT, {
      taskId: 'T201',
      gate: 'implemented',
      value: true,
      evidence: 'url:https://example.com/proof',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_CRITICAL_GATE_OVERRIDE_REJECTED');
    expect(result.error?.message).toMatch(/T9245/);
  });

  it('REJECTS under --all when override is combined with note-only evidence', async () => {
    await seedTask('T202');
    const result = await validateGateVerify(TEST_ROOT, {
      taskId: 'T202',
      all: true,
      evidence: 'note:owner-says-ok',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_CRITICAL_GATE_OVERRIDE_REJECTED');
  });

  it('ACCEPTS qaPassed with override + note (non-critical gate unchanged)', async () => {
    await seedTask('T203');
    const result = await validateGateVerify(TEST_ROOT, {
      taskId: 'T203',
      gate: 'qaPassed',
      value: true,
      evidence: 'note:owner-says-ok',
    });
    expect(result.success).toBe(true);
  });

  it('ACCEPTS implemented with override PLUS a real commit atom (hard atom is preserved)', async () => {
    await seedTask('T204');
    const result = await validateGateVerify(TEST_ROOT, {
      taskId: 'T204',
      gate: 'implemented',
      value: true,
      evidence: `commit:${SEED_COMMIT_SHA};files:seed.ts`,
    });
    expect(result.success).toBe(true);
  });
});
