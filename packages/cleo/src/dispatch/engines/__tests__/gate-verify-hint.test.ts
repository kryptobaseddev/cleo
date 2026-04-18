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

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteDataAccessor, resetDbState } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedTasks } from '../../../../../core/src/store/__tests__/test-db-helper.js';
import { validateGateVerify } from '../validate-engine.js';

/** Absolute project root for each test — recreated per test. */
let TEST_ROOT: string;

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
    },
  ]);
  await accessor.close();
  resetDbState();
}

describe('validateGateVerify — hint field (GH #94 / T919)', () => {
  beforeEach(async () => {
    resetDbState();
    TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-gate-hint-'));
    await setupTestRoot();
    // Use CLEO_OWNER_OVERRIDE to bypass evidence validation in unit tests.
    process.env['CLEO_OWNER_OVERRIDE'] = '1';
    process.env['CLEO_OWNER_OVERRIDE_REASON'] = 'unit-test';
  });

  afterEach(async () => {
    delete process.env['CLEO_OWNER_OVERRIDE'];
    delete process.env['CLEO_OWNER_OVERRIDE_REASON'];
    resetDbState();
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it('emits hint when setting the final gate drives verification.passed to true', async () => {
    await seedTask('T100');
    // First: set 'implemented'
    await validateGateVerify({ taskId: 'T100', gate: 'implemented', value: true }, TEST_ROOT);
    resetDbState();
    // Second: set 'testsPassed' — this is the final required gate
    const result = await validateGateVerify(
      { taskId: 'T100', gate: 'testsPassed', value: true },
      TEST_ROOT,
    );
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.passed).toBe(true);
    expect(data.missingGates).toHaveLength(0);
    expect(data.hint).toBe('All gates green. Run: cleo complete T100');
  });

  it('does NOT emit hint when setting a gate but others are still missing', async () => {
    await seedTask('T101');
    // Set only 'implemented' — 'testsPassed' still missing
    const result = await validateGateVerify(
      { taskId: 'T101', gate: 'implemented', value: true },
      TEST_ROOT,
    );
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.passed).toBe(false);
    expect(data.hint).toBeUndefined();
  });

  it('does NOT emit hint on view mode (no write)', async () => {
    await seedTask('T102');
    // View mode: no gate/all/reset param
    const result = await validateGateVerify({ taskId: 'T102' }, TEST_ROOT);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('view');
    expect(data.hint).toBeUndefined();
  });

  it('does NOT emit hint on reset mode', async () => {
    await seedTask('T103');
    // First set all gates green
    await validateGateVerify({ taskId: 'T103', gate: 'implemented', value: true }, TEST_ROOT);
    resetDbState();
    await validateGateVerify({ taskId: 'T103', gate: 'testsPassed', value: true }, TEST_ROOT);
    resetDbState();
    // Now reset — should not emit hint even though gates were green before
    const result = await validateGateVerify({ taskId: 'T103', reset: true }, TEST_ROOT);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('reset');
    expect(data.passed).toBe(false);
    expect(data.hint).toBeUndefined();
  });

  it('emits hint when --all is used and all gates become green', async () => {
    await seedTask('T104');
    // Set all required gates at once via all=true
    const result = await validateGateVerify({ taskId: 'T104', all: true }, TEST_ROOT);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.passed).toBe(true);
    expect(data.action).toBe('set_all');
    expect(data.hint).toBe('All gates green. Run: cleo complete T104');
  });
});
