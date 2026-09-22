/**
 * T12310 — a successful command must not report the work that succeeded as failed.
 *
 * Measured 2026-09-21 against the shipped 2026.9.11 binary: every `cleo show`
 * printed two stderr lines on a run whose envelope said `"success": true`.
 *
 *   [cleo] Project encounter registration failed: Operation cancelled during teardown
 *   cleo: teardown background-operations: tracked promises settled; producer outcomes unassessed.
 *
 * Both were false in the same specific way — a true fact about the process
 * reported as an answer to a question nobody asked:
 *
 *   1. Path resolution scheduled the encounter registration TWICE per process.
 *      The first committed (the registry's `lastSeen` advanced on 6 of 6 runs);
 *      the second was still in flight when teardown cancelled it. The message
 *      named the one thing that had demonstrably just worked.
 *   2. The drain receipt hardcoded `producerOutcome: 'unassessed'`, so the
 *      caveat printed on EVERY successful command — including the ones where
 *      the barrier observed no producers at all, leaving nothing to assess.
 *
 * The registry stores each producer's own settled result, so the barrier can
 * assess them rather than disclaim them.
 *
 * @task T12310
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCleoDirAbsolute } from '../paths.js';
import { formatShutdownOutcomes } from '../shutdown-deadline.js';
import {
  awaitBackgroundOps,
  isExpectedTeardownRejection,
  OperationExecutionError,
  pendingBackgroundOpCount,
  trackBackgroundOp,
} from '../store/background-ops.js';

/** One throwaway CLEO project whose encounter writes land in a temp home. */
function createFixture(label: string): { home: string; projectRoot: string; projectId: string } {
  const base = join(tmpdir(), `cleo-t12310-${label}-${Date.now()}-${process.pid}`);
  const home = join(base, 'home');
  const projectRoot = join(base, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  // getProjectRoot validation wants a repository marker.
  mkdirSync(join(projectRoot, '.git'), { recursive: true });
  const projectId = `t12310-${label}-${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(
    join(projectRoot, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId, name: `t12310-${label}` }),
  );
  return { home, projectRoot: resolve(projectRoot), projectId };
}

describe('T12310 AC1 — one encounter registration per process, not one per path resolution', () => {
  const fixtures: string[] = [];

  beforeEach(() => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await awaitBackgroundOps();
    for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('schedules exactly one registration across repeated resolutions of the same project', async () => {
    const fixture = createFixture('dedupe');
    fixtures.push(join(fixture.projectRoot, '..'));
    vi.stubEnv('CLEO_HOME', fixture.home);

    // trackBackgroundOp registers synchronously inside registerProjectOnEncounter,
    // so the pending count is a direct read of how many were scheduled.
    const before = pendingBackgroundOpCount();
    for (let i = 0; i < 4; i += 1) getCleoDirAbsolute(fixture.projectRoot);
    const scheduled = pendingBackgroundOpCount() - before;

    // Before the fix this was one per resolution — the shipped binary measured
    // 2 on a single `cleo show`, the second of which teardown then cancelled.
    expect(scheduled).toBe(1);
  });

  it('registers each distinct project on its own first encounter', async () => {
    const one = createFixture('first');
    const two = createFixture('second');
    fixtures.push(join(one.projectRoot, '..'), join(two.projectRoot, '..'));
    vi.stubEnv('CLEO_HOME', one.home);

    const before = pendingBackgroundOpCount();
    getCleoDirAbsolute(one.projectRoot);
    getCleoDirAbsolute(two.projectRoot);
    getCleoDirAbsolute(one.projectRoot);
    getCleoDirAbsolute(two.projectRoot);

    // Deduplication is per identity, so it must never suppress a real project.
    expect(pendingBackgroundOpCount() - before).toBe(2);
  });
});

describe('T12310 AC2 — teardown cancellation is not a producer failure', () => {
  afterEach(async () => {
    await awaitBackgroundOps();
  });

  it.each([
    ['E_OPERATION_CANCELLED', 'Operation cancelled during teardown'],
    ['E_OPERATION_CLOSED', 'Operation scope is closed'],
    ['E_OPERATION_DEADLINE', 'Shared operation deadline reached'],
  ] as const)('classifies %s as an expected teardown stop', (code, message) => {
    expect(isExpectedTeardownRejection(new OperationExecutionError(code, message))).toBe(true);
  });

  it('does not classify a real failure or a non-error reason as a teardown stop', () => {
    expect(
      isExpectedTeardownRejection(
        new OperationExecutionError('E_OPERATION_RESOURCE_LIMIT', 'admission limit exceeded'),
      ),
    ).toBe(false);
    expect(isExpectedTeardownRejection(new Error('registry write refused'))).toBe(false);
    expect(isExpectedTeardownRejection('cancelled')).toBe(false);
    expect(isExpectedTeardownRejection(undefined)).toBe(false);
  });

  it('counts a teardown-cancelled producer as cancelled, never as failed', async () => {
    trackBackgroundOp(
      Promise.reject(
        new OperationExecutionError('E_OPERATION_CANCELLED', 'Operation cancelled during teardown'),
      ),
    );
    const report = await awaitBackgroundOps();
    expect(report).toMatchObject({ observed: 1, fulfilled: 0, failed: 0, cancelled: 1 });
  });
});

describe('T12310 AC3 — the drain assesses its producers instead of disclaiming them', () => {
  afterEach(async () => {
    await awaitBackgroundOps();
  });

  it('reports an empty registry as observed-nothing rather than unassessed', async () => {
    const report = await awaitBackgroundOps();
    expect(report).toEqual({ observed: 0, fulfilled: 0, failed: 0, cancelled: 0, discarded: 0 });
  });

  it('assesses a fulfilled producer', async () => {
    trackBackgroundOp(Promise.resolve());
    const report = await awaitBackgroundOps();
    expect(report).toMatchObject({ observed: 1, fulfilled: 1, failed: 0, cancelled: 0 });
  });

  it('assesses a genuinely failed producer', async () => {
    trackBackgroundOp(Promise.reject(new Error('optional projection refused')));
    const report = await awaitBackgroundOps();
    expect(report).toMatchObject({ observed: 1, fulfilled: 0, failed: 1, cancelled: 0 });
  });

  it('assesses producers registered by an earlier producer while it settled', async () => {
    const release = Promise.withResolvers<void>();
    trackBackgroundOp(
      release.promise.then(() => {
        trackBackgroundOp(Promise.resolve());
      }),
    );
    // Start the barrier while the parent is still pending. The descendant it
    // registers settles inside the same drain round and is gone from the
    // registry before a later round could poll for it — assessment must happen
    // when each producer settles, not by re-reading the registry.
    const drain = awaitBackgroundOps();
    release.resolve();
    const report = await drain;
    expect(report).toMatchObject({ observed: 2, fulfilled: 2, failed: 0 });
  });

  it('prints nothing for a completed drain whose producers all succeeded', () => {
    const text = formatShutdownOutcomes([
      {
        label: 'background-operations',
        settled: true,
        threw: false,
        durationMs: 1,
        status: 'completed',
        producerOutcome: 'assessed',
        failedOperations: 0,
        pendingOperations: 0,
      },
    ]);
    expect(text).toBe('');
  });

  it('discloses a real producer failure with its count', () => {
    const text = formatShutdownOutcomes([
      {
        label: 'background-operations',
        settled: true,
        threw: false,
        durationMs: 1,
        status: 'completed',
        producerOutcome: 'assessed',
        failedOperations: 2,
        pendingOperations: 0,
      },
    ]);
    expect(text).toContain('2 background operations failed');
    expect(text).not.toContain('unassessed');
  });

  it('still discloses the limit when a drain could not assess its producers', () => {
    const text = formatShutdownOutcomes([
      {
        label: 'background-operations',
        settled: true,
        threw: false,
        durationMs: 1,
        status: 'completed',
        producerOutcome: 'unassessed',
        pendingOperations: 0,
      },
    ]);
    expect(text).toContain('producer outcomes unassessed');
  });
});
