/**
 * Regression tests for the lifecycle-bound background-op registry (T10490).
 *
 * These prove the *mechanism-class* fix for the intermittent cross-test DB
 * races: best-effort fire-and-forget DB writes kicked off by `addTask` /
 * `completeTask` are now tracked and MUST be fully drained by
 * `awaitBackgroundOps()` (which the shared `createTestDb` harness calls before
 * resetting the SQLite singleton). If a detached op could survive a test
 * boundary, `pendingBackgroundOpCount()` would be non-zero after the flush.
 *
 * @task T10490
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTask } from '../../tasks/add.js';
import {
  awaitBackgroundOps,
  pendingBackgroundOpCount,
  trackBackgroundOp,
} from '../background-ops.js';
import type { DataAccessor } from '../data-accessor.js';
import { resetDbState } from '../sqlite.js';
import { createTestDb, type TestDbEnv } from './test-db-helper.js';

describe('background-ops registry (T10490)', () => {
  it('drains a tracked op so the count returns to zero', async () => {
    let resolved = false;
    trackBackgroundOp(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          resolved = true;
          resolve();
        }, 5),
      ),
    );
    expect(pendingBackgroundOpCount()).toBe(1);
    await awaitBackgroundOps();
    expect(resolved).toBe(true);
    expect(pendingBackgroundOpCount()).toBe(0);
  });

  it('swallows a rejected tracked op without leaking it', async () => {
    trackBackgroundOp(Promise.reject(new Error('best-effort failure')));
    // Must not throw and must drain to zero — the registry never re-raises.
    await expect(awaitBackgroundOps()).resolves.toBeUndefined();
    expect(pendingBackgroundOpCount()).toBe(0);
  });

  it('is a no-op when nothing is pending', async () => {
    await awaitBackgroundOps();
    expect(pendingBackgroundOpCount()).toBe(0);
  });
});

describe('addTask background ops are flushed at the test boundary (T10490)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('leaves zero in-flight background ops after an explicit flush', async () => {
    // addTask kicks off the detached ensureTaskNode graph write.
    await addTask(
      {
        title: 'bg-op task',
        description: 'tracks a deferred graph write',
        skipContainmentInvariant: true,
      },
      env.tempDir,
      accessor,
    );
    // The deferred op is registered; flushing must drain it entirely so no
    // detached promise can survive into the next test's fixture.
    await awaitBackgroundOps();
    expect(pendingBackgroundOpCount()).toBe(0);
  });

  it('epic creation tracks + drains its initLoomForEpic op', async () => {
    await addTask(
      {
        title: 'bg-op epic',
        description: 'tracks a deferred LOOM init',
        type: 'epic',
        skipContainmentInvariant: true,
      },
      env.tempDir,
      accessor,
    );
    await awaitBackgroundOps();
    expect(pendingBackgroundOpCount()).toBe(0);
  });
});
