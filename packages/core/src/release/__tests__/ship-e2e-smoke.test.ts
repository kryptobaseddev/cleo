/**
 * Tests for `runShipE2eSmoke` (T10103).
 *
 * Verifies:
 *   1. Dry-run mode short-circuits every step to `skipped` and never
 *      touches the injected environment.
 *   2. Execute mode walks all five steps in order on the happy path,
 *      advancing finalState after each success.
 *   3. A failed step halts the walker but the envelope still reports
 *      every prior step and the highest reached lifecycle state.
 *   4. Version normalisation: bare `2026.6.0` becomes `v2026.6.0` in
 *      every step detail.
 *
 * @task T10103
 */

import { describe, expect, it, vi } from 'vitest';
import type { SmokeEnvironment } from '../ship-e2e-smoke.js';
import { runShipE2eSmoke } from '../ship-e2e-smoke.js';

/**
 * Build a happy-path fake environment. Every method resolves with a
 * canned successful value. Spies are returned so tests can assert call
 * order + argument shape.
 */
function makeHappyEnv(): {
  env: SmokeEnvironment;
  spies: {
    runPlan: ReturnType<typeof vi.fn>;
    runOpen: ReturnType<typeof vi.fn>;
    waitForPr: ReturnType<typeof vi.fn>;
    waitForTag: ReturnType<typeof vi.fn>;
    verifyNpmPublished: ReturnType<typeof vi.fn>;
    now: ReturnType<typeof vi.fn>;
  };
} {
  let clock = 1_000;
  const now = vi.fn(() => {
    clock += 10;
    return clock;
  });
  const runPlan = vi.fn(async () => ({ planPath: '.cleo/release/v2026.6.0.plan.json' }));
  const runOpen = vi.fn(async () => ({ workflowRunId: 'run-7' }));
  const waitForPr = vi.fn(async () => ({ prNumber: 524 }));
  const waitForTag = vi.fn(async () => ({ tagSha: 'deadbeef00112233' }));
  const verifyNpmPublished = vi.fn(async () => ({
    tarballUrl: 'https://registry.npmjs.org/@cleocode/cleo/-/cleo-2026.6.0.tgz',
  }));
  return {
    env: { runPlan, runOpen, waitForPr, waitForTag, verifyNpmPublished, now },
    spies: { runPlan, runOpen, waitForPr, waitForTag, verifyNpmPublished, now },
  };
}

describe('runShipE2eSmoke — dry-run mode (T10103)', () => {
  it('skips every step and never touches the environment beyond now()', async () => {
    const { env, spies } = makeHappyEnv();
    const result = await runShipE2eSmoke(
      { version: '2026.6.0', epicId: 'T10099', execute: false },
      env,
    );

    expect(result.success).toBe(true);
    expect(result.executed).toBe(false);
    expect(result.version).toBe('v2026.6.0');
    expect(result.steps.map((s) => s.name)).toEqual([
      'plan',
      'open',
      'wait-for-pr',
      'wait-for-tag',
      'verify-npm-published',
    ]);
    expect(result.steps.every((s) => s.status === 'skipped')).toBe(true);
    expect(result.finalState).toBe('planned');

    expect(spies.runPlan).not.toHaveBeenCalled();
    expect(spies.runOpen).not.toHaveBeenCalled();
    expect(spies.waitForPr).not.toHaveBeenCalled();
    expect(spies.waitForTag).not.toHaveBeenCalled();
    expect(spies.verifyNpmPublished).not.toHaveBeenCalled();
  });

  it('preserves the leading `v` when the operator already prefixed it', async () => {
    const { env } = makeHappyEnv();
    const result = await runShipE2eSmoke(
      { version: 'v2026.6.0', epicId: 'T10099', execute: false },
      env,
    );
    expect(result.version).toBe('v2026.6.0');
    expect(result.steps[0]?.detail).toContain('v2026.6.0');
  });
});

describe('runShipE2eSmoke — execute mode happy path (T10103)', () => {
  it('walks all five steps in order, advancing finalState after each success', async () => {
    const { env, spies } = makeHappyEnv();
    const result = await runShipE2eSmoke(
      { version: '2026.6.0', epicId: 'T10099', execute: true, pollIntervalMs: 1 },
      env,
    );

    expect(result.success).toBe(true);
    expect(result.executed).toBe(true);
    expect(result.finalState).toBe('npm-published');
    expect(result.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);

    // plan → open → waitForPr → waitForTag → verifyNpmPublished
    expect(spies.runPlan).toHaveBeenCalledWith({ version: 'v2026.6.0', epicId: 'T10099' });
    expect(spies.runOpen).toHaveBeenCalledWith({ version: 'v2026.6.0' });
    expect(spies.waitForPr).toHaveBeenCalledTimes(1);
    expect(spies.waitForTag).toHaveBeenCalledTimes(1);
    expect(spies.verifyNpmPublished).toHaveBeenCalledTimes(1);

    expect(result.steps[0]?.detail).toContain('.cleo/release/v2026.6.0.plan.json');
    expect(result.steps[1]?.detail).toContain('run-7');
    expect(result.steps[2]?.detail).toContain('#524');
    expect(result.steps[3]?.detail).toContain('deadbeef0011');
    expect(result.steps[4]?.detail).toContain('registry.npmjs.org');
  });
});

describe('runShipE2eSmoke — failure handling (T10103)', () => {
  it('halts after a failed step but reports every prior step + highest finalState', async () => {
    const { env, spies } = makeHappyEnv();
    spies.waitForPr.mockImplementationOnce(async () => {
      throw new Error('PR never merged');
    });

    const result = await runShipE2eSmoke(
      { version: '2026.6.0', epicId: 'T10099', execute: true, pollIntervalMs: 1 },
      env,
    );

    expect(result.success).toBe(false);
    expect(result.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'failed']);
    expect(result.steps[2]?.error).toBe('PR never merged');
    // The walker MUST stop after the failed step — tag + npm steps absent.
    expect(spies.waitForTag).not.toHaveBeenCalled();
    expect(spies.verifyNpmPublished).not.toHaveBeenCalled();
    // finalState reflects the LAST successful step (open → pr-opened).
    expect(result.finalState).toBe('pr-opened');
  });

  it('records totalDurationMs as monotonic difference of env.now()', async () => {
    const { env } = makeHappyEnv();
    const result = await runShipE2eSmoke(
      { version: '2026.6.0', epicId: 'T10099', execute: true, pollIntervalMs: 1 },
      env,
    );
    expect(result.totalDurationMs).toBeGreaterThan(0);
  });
});
