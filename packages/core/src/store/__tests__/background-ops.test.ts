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

import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worktreeScope } from '../../project-scope.js';
import { addTask } from '../../tasks/add.js';
import { _resetTeardownSignalForTests, markShuttingDown } from '../../teardown-signal.js';
import {
  awaitBackgroundOps,
  bindOperationWriteFence,
  createOperationExecutionContext,
  observeOperation,
  pendingBackgroundOpCount,
  receiveOperationContext,
  trackBackgroundOp,
  transferOperationContext,
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

describe('transaction-bound lazy background operations', () => {
  let env: TestDbEnv;
  beforeEach(async () => {
    env = await createTestDb();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('runs once after the outer commit, never at a nested savepoint release', async () => {
    const effects: string[] = [];
    let outcome: ReturnType<typeof trackBackgroundOp> | undefined;
    await env.accessor.transaction(async () => {
      await env.accessor.transaction(async () => {
        outcome = trackBackgroundOp(async () => {
          effects.push('committed');
        });
        expect(pendingBackgroundOpCount()).toBe(1);
        expect(effects).toEqual([]);
      });
      expect(effects).toEqual([]);
      await expect(awaitBackgroundOps()).rejects.toThrow('before its transaction commits');
    });
    await awaitBackgroundOps();
    expect(await outcome).toEqual({ status: 'fulfilled', value: undefined });
    expect(effects).toEqual(['committed']);
    expect(pendingBackgroundOpCount()).toBe(0);
  });

  it('discards successful nested effects when the outer transaction rolls back', async () => {
    const effects: string[] = [];
    let outcome: ReturnType<typeof trackBackgroundOp> | undefined;
    await expect(
      env.accessor.transaction(async () => {
        await env.accessor.transaction(async () => {
          outcome = trackBackgroundOp(async () => {
            effects.push('must not run');
          });
        });
        throw new Error('outer rollback');
      }),
    ).rejects.toThrow('outer rollback');
    await awaitBackgroundOps();
    expect(await outcome).toMatchObject({
      status: 'rejected',
      reason: { message: expect.stringContaining('rolled back') },
    });
    expect(effects).toEqual([]);
  });

  it('discards only a rolled-back savepoint while committing its valid sibling', async () => {
    const effects: string[] = [];
    await env.accessor.transaction(async () => {
      await expect(
        env.accessor.transaction(async () => {
          trackBackgroundOp(async () => {
            effects.push('rejected');
          });
          throw new Error('savepoint rollback');
        }),
      ).rejects.toThrow('savepoint rollback');
      trackBackgroundOp(async () => {
        effects.push('accepted');
      });
    });
    await awaitBackgroundOps();
    expect(effects).toEqual(['accepted']);
  });

  it('retains captured project context after ambient changes and reports operation failures', async () => {
    const seen: string[] = [];
    let outcome: ReturnType<typeof trackBackgroundOp> | undefined;
    await env.accessor.transaction(async () => {
      worktreeScope.run({ worktreeRoot: env.tempDir }, () => {
        outcome = trackBackgroundOp(async () => {
          seen.push(worktreeScope.getStore()!.worktreeRoot);
          throw new Error('inspectable projection failure');
        });
      });
    });
    await awaitBackgroundOps();
    expect(seen).toEqual([env.tempDir]);
    expect(await outcome).toMatchObject({
      status: 'rejected',
      reason: { message: 'inspectable projection failure' },
    });
  });

  it('does not replace a captured expired budget when work becomes runnable', async () => {
    const execution = createOperationExecutionContext({
      projectId: 'fixture',
      projectRoot: env.tempDir,
      actor: 'test',
      operation: 'effect',
      idempotencyKey: 'one',
    });
    let invoked = false;
    let outcome: ReturnType<typeof trackBackgroundOp> | undefined;
    await env.accessor.transaction(async () => {
      worktreeScope.run({ worktreeRoot: env.tempDir, execution }, () => {
        outcome = trackBackgroundOp(async () => {
          invoked = true;
        }, execution);
      });
      execution.close();
    });
    await awaitBackgroundOps();
    expect(invoked).toBe(false);
    expect(await outcome).toMatchObject({
      status: 'rejected',
      reason: { code: 'E_OPERATION_CLOSED' },
    });
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

describe('captured operation execution lifetime (T12265)', () => {
  const scopes: OperationExecutionContext[] = [];
  const identity = {
    projectId: 'project-A',
    projectRoot: '/synthetic/project-A',
    actor: 'foreground-agent',
    operation: 'docs.projection',
    idempotencyKey: 'attachment-hash',
  };
  function scope(options: Parameters<typeof createOperationExecutionContext>[1] = {}) {
    const context = createOperationExecutionContext(identity, options);
    scopes.push(context);
    return context;
  }
  afterEach(() => {
    for (const context of scopes.splice(0)) context.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    _resetTeardownSignalForTests();
  });

  it('pins A before a paused stage and ignores a later ambient B root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-operation-scope-'));
    const a = new DatabaseSync(join(root, 'a.db'));
    const b = new DatabaseSync(join(root, 'b.db'));
    a.exec('CREATE TABLE evidence(project TEXT, actor TEXT)');
    b.exec('CREATE TABLE evidence(project TEXT, actor TEXT)');
    const accepted = { ...identity, projectRoot: join(root, 'a') };
    const context = createOperationExecutionContext(accepted);
    scopes.push(context);
    const ready = Promise.withResolvers<void>();
    const work = (async () => {
      await ready.promise;
      context.assertActive();
      const db = context.identity.projectRoot === join(root, 'a') ? a : b;
      db.prepare('INSERT INTO evidence VALUES (?,?)').run(
        context.identity.projectId,
        context.identity.actor,
      );
    })();
    accepted.projectRoot = join(root, 'b');
    accepted.actor = 'wrong-agent';
    vi.stubEnv('CLEO_ROOT', join(root, 'b'));
    ready.resolve();
    try {
      await work;
      expect(a.prepare('SELECT * FROM evidence').all()).toEqual([
        { project: 'project-A', actor: 'foreground-agent' },
      ]);
      expect(b.prepare('SELECT * FROM evidence').all()).toEqual([]);
      expect(Object.isFrozen(context.identity)).toBe(true);
      expect(Object.isFrozen(context)).toBe(true);
    } finally {
      a.close();
      b.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    'caller',
    'teardown',
    'close',
  ] as const)('refuses paused guarded writes after %s cancellation', async (kind) => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE evidence(id TEXT)');
    const caller = new AbortController();
    const context = scope({ signal: caller.signal });
    const ready = Promise.withResolvers<void>();
    const work = (async () => {
      await ready.promise;
      context.assertActive();
      db.prepare('INSERT INTO evidence VALUES (?)').run('late');
    })();
    const observation = observeOperation(context, work);
    if (kind === 'caller') caller.abort();
    else if (kind === 'teardown') markShuttingDown();
    else context.close();
    expect(await observation).toMatchObject({ settled: false });
    ready.resolve();
    try {
      await expect(work).rejects.toThrow(/cancelled|closed/);
      expect(db.prepare('SELECT * FROM evidence').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('shares the default two seconds across phases and checks time without a timer turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const context = scope();
    expect(context.deadlineAt).toBe(102_000);
    vi.setSystemTime(101_200);
    expect(context.remainingMs()).toBe(800);
    context.assertActive();
    vi.setSystemTime(102_000);
    expect(() => context.assertActive()).toThrow('deadline');
    expect(context.signal.aborted).toBe(true);
    expect(context.remainingMs()).toBe(0);
  });

  it('honors an earlier enclosing deadline and zero budget without admitting work', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    const context = scope({ budgetMs: 9000, deadlineAt: 5100 });
    expect(context.deadlineAt).toBe(5100);
    expect(scope({ budgetMs: 0 }).signal.aborted).toBe(true);
  });

  it('reports an uncooperative promise unresolved, then fences its late stage', async () => {
    vi.useFakeTimers();
    const context = scope({ budgetMs: 20 });
    const work = Promise.withResolvers<string>();
    const observation = observeOperation(context, work.promise);
    await vi.advanceTimersByTimeAsync(20);
    expect(await observation).toEqual({
      settled: false,
      reason: 'E_OPERATION_DEADLINE',
      deadlineExceeded: true,
    });
    work.resolve('actually continued');
    expect(await work.promise).toBe('actually continued');
    expect(() => context.assertActive()).toThrow('deadline');
  });

  it('reports a synchronous overrun without discarding its committed result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const context = scope({ budgetMs: 10 });
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE evidence(id TEXT)');
    const work = Promise.resolve().then(() => {
      context.assertActive();
      db.exec("INSERT INTO evidence VALUES ('committed')");
      // Synchronous elapsed time: no cancellation timer has had a chance to run.
      vi.setSystemTime(1020);
      return { committed: true };
    });
    try {
      expect(await observeOperation(context, work)).toEqual({
        settled: true,
        success: true,
        value: { committed: true },
        deadlineExceeded: true,
      });
      context.close();
      expect(db.prepare('SELECT id FROM evidence').all()).toEqual([{ id: 'committed' }]);
      expect(() => context.assertActive()).toThrow('closed');
    } finally {
      db.close();
    }
  });

  it('preserves settled rejection diagnostics and closes escaped capabilities', async () => {
    const context = scope();
    const failure = new Error('projection unavailable');
    expect(await observeOperation(context, Promise.reject(failure))).toEqual({
      settled: true,
      success: false,
      error: failure,
      deadlineExceeded: false,
    });
    context.close();
    expect(() => context.consume({ items: 1 })).toThrow('closed');
    context.close();
  });

  it('accounts aggregate resources across stages and freezes caller limits', () => {
    const resources = { maxBytes: 5, maxItems: 2 };
    const context = scope({ resources });
    resources.maxBytes = 1000;
    context.consume({ bytes: 3, items: 1 });
    context.consume({ bytes: 2, items: 1 });
    expect(() => context.consume({ bytes: 1 })).toThrow('resource');
    expect(context.signal.aborted).toBe(true);
    expect(context.resources.maxBytes).toBe(5);
    expect(Object.isFrozen(context.resources)).toBe(true);
  });

  it('rejects invalid input and already cancelled work without opening resources', () => {
    expect(() => createOperationExecutionContext({ ...identity, projectRoot: 'relative' })).toThrow(
      'absolute',
    );
    expect(() => scope({ budgetMs: -1 })).toThrow('budget');
    expect(() => scope({ resources: { maxItems: Number.NaN } })).toThrow('limits');
    const caller = new AbortController();
    caller.abort();
    const context = scope({ signal: caller.signal });
    expect(() => context.assertActive()).toThrow('cancelled');
    markShuttingDown();
    expect(() => scope().assertActive()).toThrow('teardown');
  });
});

describe('captured worker scope transfer', () => {
  it('retains the deadline and charges aggregate resources only in the origin', () => {
    const context = createOperationExecutionContext(
      {
        projectId: 'A',
        projectRoot: '/tmp/A',
        actor: 'foreground',
        operation: 'docs.projection',
        idempotencyKey: 'one',
      },
      { budgetMs: 1000, resources: { maxBytes: 8, maxItems: 2 } },
    );
    const link = transferOperationContext(context, { bytes: 5, items: 1 });
    const received = receiveOperationContext(structuredClone(link.transfer));
    try {
      expect(received.identity).toEqual(context.identity);
      expect(received.deadlineAt).toBe(context.deadlineAt);
      received.assertActive();
      expect(() => received.consume({ bytes: 1 })).toThrow();
      expect(() => transferOperationContext(context, { bytes: 4, items: 1 })).toThrow();
    } finally {
      received.close();
      link.release();
      context.close();
    }
  });

  it.each([
    'cancel-before-write',
    'cancel-after-commit',
  ] as const)('observes %s across a blocked real worker without claiming preemption', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-operation-worker-'));
    const dbPath = join(root, 'proof.db');
    const native = new DatabaseSync(dbPath);
    native.exec('CREATE TABLE proof (value TEXT)');
    native.close();
    const bundle = join(root, 'scope.mjs');
    buildSync({
      entryPoints: [fileURLToPath(new URL('../background-ops.ts', import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
    });
    const context = createOperationExecutionContext(
      {
        projectId: 'A',
        projectRoot: root,
        actor: 'foreground',
        operation: 'docs.projection',
        idempotencyKey: mode,
      },
      { budgetMs: 10000, resources: { maxBytes: 128, maxItems: 1 } },
    );
    const link = transferOperationContext(context, { bytes: 32, items: 1 });
    const latch = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const flags = new Int32Array(latch);
    const worker = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads');
        const { DatabaseSync } = require('node:sqlite');
        (async () => {
          const { receiveOperationContext } = await import(workerData.bundle);
          const context = receiveOperationContext(workerData.scope);
          const flags = new Int32Array(workerData.latch);
          parentPort.postMessage('ready');
          Atomics.wait(flags, 0, 0, 5000);
          let db;
          try {
            context.assertActive();
            db = new DatabaseSync(workerData.dbPath);
            context.assertActive();
            db.exec("INSERT INTO proof VALUES ('committed')");
            parentPort.postMessage('committed');
            Atomics.wait(flags, 1, 0, 5000);
            parentPort.postMessage({ result: 'committed', projectId: context.identity.projectId });
          } catch (error) {
            parentPort.postMessage({ result: 'rejected', code: error.code });
          } finally { db?.close(); context.close(); }
        })().catch(error => { throw error; });
      `,
      {
        eval: true,
        resourceLimits: { maxOldGenerationSizeMb: 64 },
        workerData: { bundle: pathToFileURL(bundle).href, scope: link.transfer, latch, dbPath },
      },
    );
    try {
      expect((await once(worker, 'message'))[0]).toBe('ready');
      const next = once(worker, 'message');
      if (mode === 'cancel-before-write') context.close();
      Atomics.store(flags, 0, 1);
      Atomics.notify(flags, 0);
      if (mode === 'cancel-before-write') {
        expect((await next)[0]).toEqual({ result: 'rejected', code: 'E_OPERATION_CANCELLED' });
      } else {
        expect((await next)[0]).toBe('committed');
        const final = once(worker, 'message');
        context.close();
        Atomics.store(flags, 1, 1);
        Atomics.notify(flags, 1);
        expect((await final)[0]).toEqual({ result: 'committed', projectId: 'A' });
      }
      const fresh = new DatabaseSync(dbPath, { readOnly: true });
      expect(fresh.prepare('SELECT value FROM proof').all()).toEqual(
        mode === 'cancel-before-write' ? [] : [{ value: 'committed' }],
      );
      fresh.close();
    } finally {
      link.release();
      context.close();
      await worker.terminate();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  it('invalidates an escaped receiver when the transfer is released', () => {
    const context = createOperationExecutionContext({
      projectId: 'A',
      projectRoot: '/tmp/A',
      actor: 'caller',
      operation: 'docs.projection',
      idempotencyKey: 'release',
    });
    const link = transferOperationContext(context, { items: 1 });
    const received = receiveOperationContext(link.transfer);
    link.release();
    try {
      expect(() => received.assertActive()).toThrow();
    } finally {
      received.close();
      context.close();
    }
  });
});

describe('captured domain write fence transfer', () => {
  it('captures deeply immutable authority without resetting it in another realm', () => {
    const writeFence = {
      dbPath: '/tmp/synthetic/cleo.db',
      proposalHash: 'a'.repeat(64),
      lease: { jobId: 'job-a', ownerId: 'owner-a', epoch: 2, expiresAt: Date.now() + 1000 },
    };
    const expected = structuredClone(writeFence);
    const context = createOperationExecutionContext(
      {
        projectId: 'A',
        projectRoot: '/tmp/synthetic',
        actor: 'fixture',
        operation: 'docs.projection',
        idempotencyKey: 'fence-transfer',
      },
      { writeFence },
    );
    writeFence.lease.ownerId = 'forged';
    writeFence.proposalHash = 'b'.repeat(64);
    const link = transferOperationContext(context, { items: 1 });
    const receiver = receiveOperationContext(structuredClone(link.transfer));
    try {
      expect(context.writeFence).toEqual(expected);
      expect(receiver.writeFence).toEqual(expected);
      expect(Object.isFrozen(receiver.writeFence)).toBe(true);
      expect(Object.isFrozen(receiver.writeFence?.lease)).toBe(true);
      expect(receiver.deadlineAt).toBe(context.deadlineAt);
    } finally {
      receiver.close();
      link.release();
      context.close();
    }
  });

  it('rejects malformed authority before admitting an operation', () => {
    expect(() =>
      createOperationExecutionContext(
        {
          projectId: 'A',
          projectRoot: '/tmp/synthetic',
          actor: 'fixture',
          operation: 'docs.projection',
          idempotencyKey: 'invalid-fence',
        },
        {
          writeFence: {
            dbPath: 'relative.db',
            proposalHash: 'not-a-hash',
            lease: { jobId: 'j', ownerId: 'o', epoch: 0, expiresAt: 1 },
          },
        },
      ),
    ).toThrow('Invalid operation write fence');
  });
});

it('binding claimed authority shares the original deadline, cancellation and aggregate admission', () => {
  const context = createOperationExecutionContext(
    {
      projectId: 'A',
      projectRoot: '/tmp/synthetic',
      actor: 'fixture',
      operation: 'docs.projection',
      idempotencyKey: 'binding',
    },
    { resources: { maxItems: 1 } },
  );
  const bound = bindOperationWriteFence(context, {
    dbPath: '/tmp/synthetic/cleo.db',
    proposalHash: 'a'.repeat(64),
    lease: { jobId: 'job', ownerId: 'owner', epoch: 1, expiresAt: Date.now() + 1000 },
  });
  try {
    expect(bound.deadlineAt).toBe(context.deadlineAt);
    expect(bound.signal).toBe(context.signal);
    expect(() => bindOperationWriteFence(bound, bound.writeFence!)).toThrow(
      'immutable write fence',
    );
    context.consume({ items: 1 });
    expect(() => bound.consume({ items: 1 })).toThrow();
    expect(context.signal.aborted).toBe(true);
    expect(() => bindOperationWriteFence(bound, bound.writeFence!)).toThrow();
  } finally {
    bound.close();
    context.close();
  }
});

describe('cancelled outcome fence binding', () => {
  it.each([
    'active',
    'expired-deadline',
    'expired-lease',
    'cancelled',
  ] as const)('preserves original authority and refuses %s when unsuitable', (kind) => {
    const context = createOperationExecutionContext(
      {
        projectId: 'A',
        projectRoot: '/tmp/synthetic',
        actor: 'fixture',
        operation: 'doctor.knowledge',
        idempotencyKey: 'outcome-binding',
      },
      { budgetMs: kind === 'expired-deadline' ? 0 : 2000 },
    );
    const fence = {
      dbPath: '/tmp/synthetic/cleo.db',
      proposalHash: 'a'.repeat(64),
      lease: {
        jobId: 'job',
        ownerId: 'owner',
        epoch: 1,
        expiresAt: Date.now() + (kind === 'expired-lease' ? -1 : 1000),
      },
    };
    if (kind !== 'active') context.close();
    try {
      if (kind !== 'cancelled')
        expect(() => bindOperationWriteFence(context, fence, true)).toThrow();
      else {
        const bound = bindOperationWriteFence(context, fence, true);
        expect(bound.identity).toBe(context.identity);
        expect(bound.signal).toBe(context.signal);
        expect(bound.deadlineAt).toBe(context.deadlineAt);
        expect(bound.assertActive).toBe(context.assertActive);
        expect(bound.consume).toBe(context.consume);
        expect(() => bound.assertActive()).toThrow();
        expect(() => bound.consume({ items: 1 })).toThrow();
        expect(() => bindOperationWriteFence(bound, fence, true)).toThrow('immutable write fence');
        expect(() => bindOperationWriteFence(context, fence)).toThrow();
      }
    } finally {
      context.close();
    }
  });
});
