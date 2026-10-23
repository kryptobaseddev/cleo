/**
 * Storage-boundary fence tests for `storePattern`: cancellation, deadlines,
 * readback rollback and delayed graph projection.
 *
 * Formerly `dispatch-trace.test.ts`; the dispatch-trace writer and its
 * resolver lifecycle tests were removed by T13946.
 *
 * @task T1325
 * @task T13946
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { worktreeScope } from '../../project-scope.js';
import {
  awaitBackgroundOps,
  createOperationExecutionContext,
  pendingBackgroundOpCount,
} from '../../store/background-ops.js';
import { BrainDataAccessor, getBrainAccessor } from '../../store/memory-accessor.js';
import * as brain from '../../store/memory-sqlite.js';
import { closeAllDatabases } from '../../store/sqlite.js';
import type { verifyAndStore } from '../extraction-gate.js';
import * as graph from '../graph-auto-populate.js';
import { storePattern } from '../patterns.js';

// ---------------------------------------------------------------------------
// Mock verifyAndStore so no real brain.db is opened
// ---------------------------------------------------------------------------

const mockVerifyAndStore = vi.hoisted(() => vi.fn<typeof verifyAndStore>());
mockVerifyAndStore.mockResolvedValue({ action: 'stored', id: 'O-test', reason: 'fixture' });

vi.mock('../extraction-gate.js', () => ({
  verifyAndStore: mockVerifyAndStore,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pattern storage fence', () => {
  let directory: string | undefined;
  afterEach(async () => {
    await awaitBackgroundOps();
    await closeAllDatabases();
    vi.restoreAllMocks();
    mockVerifyAndStore.mockReset();
    mockVerifyAndStore.mockResolvedValue({ action: 'stored', id: 'O-test', reason: 'fixture' });
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function fixture() {
    directory = await mkdtemp(join(tmpdir(), 'dispatch-lifecycle-'));
    const first = join(directory, 'first');
    const second = join(directory, 'second');
    await mkdir(join(first, '.cleo'), { recursive: true });
    await mkdir(join(second, '.cleo'), { recursive: true });
    for (const [root, id] of [
      [first, 'first'],
      [second, 'second'],
    ]) {
      await writeFile(
        join(root!, '.cleo/project-info.json'),
        JSON.stringify({ projectId: id, projectHash: id, projectRoot: root }),
      );
    }
    await writeFile(
      join(first, '.cleo/config.json'),
      JSON.stringify({ brain: { autoCapture: true } }),
    );
    await writeFile(
      join(second, '.cleo/config.json'),
      JSON.stringify({ brain: { autoCapture: true } }),
    );
    return { first, second };
  }

  it.each([
    ['insert', 'cancel'],
    ['update', 'cancel'],
    ['insert', 'deadline'],
    ['update', 'deadline'],
  ] as const)('refuses the actual primary %s write after %s at the storage boundary', async (operation, stop) => {
    const { first } = await fixture();
    const scope = { worktreeRoot: first, projectHash: 'first' };
    const params = {
      type: 'workflow' as const,
      pattern: 'Primary fence fixture',
      context: 'Original row retained',
      _skipGate: true,
    };
    const seed =
      operation === 'update'
        ? await worktreeScope.run(scope, () => storePattern(first, params))
        : null;
    await awaitBackgroundOps();
    const abort = new AbortController();
    const now = Date.now();
    const execution = createOperationExecutionContext(
      {
        projectRoot: first,
        projectId: 'first',
        actor: 'test',
        operation: 'memory.pattern',
        idempotencyKey: operation + stop,
      },
      { deadlineAt: now + 10000, signal: abort.signal },
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    if (operation === 'insert') {
      const original = BrainDataAccessor.prototype.addPattern;
      vi.spyOn(BrainDataAccessor.prototype, 'addPattern').mockImplementationOnce(async function (
        this: BrainDataAccessor,
        ...args
      ) {
        entered.resolve();
        await release.promise;
        return original.apply(this, args);
      });
    } else {
      const original = BrainDataAccessor.prototype.updatePattern;
      vi.spyOn(BrainDataAccessor.prototype, 'updatePattern').mockImplementationOnce(async function (
        this: BrainDataAccessor,
        ...args
      ) {
        entered.resolve();
        await release.promise;
        return original.apply(this, args);
      });
    }
    const pending = worktreeScope.run({ ...scope, execution }, () => storePattern(first, params));
    try {
      await entered.promise;
      if (stop === 'cancel') abort.abort(new Error('Primary write cancelled'));
      else vi.spyOn(Date, 'now').mockReturnValue(now + 20000);
      release.resolve();
      await expect(pending).rejects.toThrow(/cancel|deadline/i);
      const rows = await worktreeScope.run(scope, async () =>
        (await getBrainAccessor(first)).findPatterns({ includeHistory: true }),
      );
      expect(rows.map((row) => [row.id, row.frequency])).toEqual(seed ? [[seed.id, 1]] : []);
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
  });

  it('rolls back a scoped pattern insertion when required readback fails', async () => {
    const { first } = await fixture();
    const scope = { worktreeRoot: first, projectHash: 'first' };
    const seed = await worktreeScope.run(scope, () =>
      storePattern(first, {
        type: 'workflow',
        pattern: 'Seed pattern',
        context: 'Independent committed row',
        _skipGate: true,
      }),
    );
    await awaitBackgroundOps();
    const accessor = await worktreeScope.run(scope, () => getBrainAccessor(first));
    const row = await accessor.getPattern(seed.id);
    if (!row) throw new Error('Seed pattern missing');
    const native = worktreeScope.run(scope, () => brain.getBrainNativeDb(first));
    if (!native) throw new Error('Seed native handle missing');
    native.exec(
      `CREATE TRIGGER invalidate_readback AFTER INSERT ON brain_patterns WHEN NEW.id = 'P-rollback' BEGIN UPDATE brain_patterns SET frequency = 99 WHERE id = '${seed.id}'; DELETE FROM brain_patterns WHERE id = NEW.id; END`,
    );
    const execution = createOperationExecutionContext(
      {
        projectRoot: first,
        projectId: 'first',
        actor: 'test',
        operation: 'memory.pattern',
        idempotencyKey: 'readback-rollback',
      },
      { budgetMs: 10000 },
    );
    await expect(accessor.addPattern({ ...row, id: 'P-rollback' }, execution)).rejects.toThrow(
      'Inserted pattern could not be read back',
    );
    expect(await accessor.getPattern('P-rollback')).toBeNull();
    expect(await accessor.getPattern(seed.id)).toMatchObject({
      pattern: 'Seed pattern',
      frequency: 1,
    });
  });

  it.each([
    'finish',
    'cancel',
    'deadline',
    'sql-failure',
  ] as const)('awaits and fences the actual duplicate citation write (%s)', async (mode) => {
    const { first } = await fixture();
    const gate =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    const scope = { worktreeRoot: first, projectHash: 'first' };
    const saved = await worktreeScope.run(scope, () =>
      storePattern(first, {
        type: 'workflow',
        pattern: 'Exact citation fixture',
        context: 'Duplicate trace',
        _skipGate: true,
      }),
    );
    await awaitBackgroundOps();
    const abort = new AbortController();
    let clock = Date.now();
    const execution = createOperationExecutionContext(
      {
        projectRoot: first,
        projectId: 'first',
        actor: 'test',
        operation: 'memory.gate',
        idempotencyKey: mode,
      },
      { deadlineAt: clock + 10000, signal: abort.signal },
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = brain.getBrainDb;
    let opens = 0;
    vi.spyOn(brain, 'getBrainDb').mockImplementation(async (...args) => {
      const db = await original(...args);
      if (++opens === 2) {
        entered.resolve();
        await release.promise;
      }
      return db;
    });
    let finished = false;
    const pending = worktreeScope
      .run({ ...scope, execution }, () =>
        gate.verifyAndStore(first, {
          text: 'Exact citation fixture',
          memoryType: 'procedural',
          tier: 'short',
          confidence: 1,
          source: 'manual',
          trusted: true,
        }),
      )
      .then((result) => {
        finished = true;
        return result;
      });
    try {
      await entered.promise;
      // Drain the ready event-loop turn without releasing the controlled SQL boundary.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (mode === 'finish') expect(finished).toBe(false);
      if (mode === 'cancel') abort.abort(new Error('Cancel before native citation UPDATE'));
      if (mode === 'deadline') {
        clock += 20000;
        vi.spyOn(Date, 'now').mockReturnValue(clock);
      }
      if (mode === 'sql-failure') {
        worktreeScope
          .run(scope, () => brain.getBrainNativeDb(first))!
          .exec(
            "CREATE TRIGGER deny_citation BEFORE UPDATE OF citation_count ON brain_patterns BEGIN SELECT RAISE(ABORT, 'fixture citation denied'); END",
          );
      }
      release.resolve();
      const result = await pending;
      if (mode === 'finish') expect(result.action).toBe('merged');
      else
        expect(result).toMatchObject({
          action: 'rejected',
          reason: expect.stringMatching(/cancel|deadline|denied/i),
        });
      const row = await worktreeScope.run(scope, async () =>
        (await getBrainAccessor(first)).getPattern(saved.id),
      );
      expect(row?.citationCount).toBe(mode === 'finish' ? 1 : 0);
    } finally {
      release.resolve();
      await pending;
      vi.restoreAllMocks();
    }
  });

  it('does not authorize storing when canonical duplicate lookup fails', async () => {
    const { first } = await fixture();
    const gate =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    vi.spyOn(brain, 'getBrainDb').mockRejectedValueOnce(
      new Error('Independent canonical read failure'),
    );
    const result = await worktreeScope.run({ worktreeRoot: first, projectHash: 'first' }, () =>
      gate.verifyCandidate(first, {
        text: 'Unassessed candidate',
        memoryType: 'procedural',
        tier: 'short',
        confidence: 1,
        source: 'manual',
        trusted: true,
      }),
    );
    expect(result).toMatchObject({
      action: 'rejected',
      reason: expect.stringContaining('Independent canonical read failure'),
    });
  });

  it.each([
    'insert',
    'duplicate',
  ] as const)('owns the actual pattern graph descendant through completion (%s)', async (mode) => {
    const { first } = await fixture();
    const execution = createOperationExecutionContext(
      {
        projectRoot: first,
        projectId: 'first',
        actor: 'test',
        operation: 'memory.pattern',
        idempotencyKey: mode,
      },
      { budgetMs: 10000 },
    );
    const scope = { worktreeRoot: first, projectHash: 'first', execution };
    const params = {
      type: 'workflow' as const,
      pattern: 'Recorded dispatch behavior',
      context: 'Controlled trace',
      _skipGate: true,
    };
    if (mode === 'duplicate') {
      await worktreeScope.run(scope, () => storePattern(first, params));
      await awaitBackgroundOps();
    }
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const original = graph.upsertGraphNode;
    const spy = vi.spyOn(graph, 'upsertGraphNode').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      try {
        return await original(...args);
      } finally {
        finished.resolve();
      }
    });
    try {
      const saved = await worktreeScope.run(scope, () => storePattern(first, params));
      await entered.promise;
      expect(saved.frequency).toBe(mode === 'duplicate' ? 2 : 1);
      expect(pendingBackgroundOpCount()).toBeGreaterThan(0);
      expect(spy.mock.calls[0]?.[0]).toBe(first);
      expect(spy.mock.calls[0]?.[7]).toBe(execution);
      let completed = false;
      const barrier = awaitBackgroundOps().then(() => {
        completed = true;
      });
      await Promise.resolve();
      expect(completed).toBe(false);
      release.resolve();
      await barrier;
      const row = await worktreeScope.run({ worktreeRoot: first, projectHash: 'first' }, async () =>
        (await getBrainAccessor(first)).getPageNode(`pattern:${saved.id}`),
      );
      expect(row?.id).toBe(`pattern:${saved.id}`);
      expect(pendingBackgroundOpCount()).toBe(0);
    } finally {
      release.resolve();
      await finished.promise;
    }
  });

  it('retains the committed pattern but refuses a cancelled delayed graph projection', async () => {
    const { first } = await fixture();
    const abort = new AbortController();
    const execution = createOperationExecutionContext(
      {
        projectRoot: first,
        projectId: 'first',
        actor: 'test',
        operation: 'memory.pattern',
        idempotencyKey: 'cancel-graph',
      },
      { budgetMs: 10000, signal: abort.signal },
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const original = graph.upsertGraphNode;
    vi.spyOn(graph, 'upsertGraphNode').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      try {
        return await original(...args);
      } finally {
        finished.resolve();
      }
    });
    try {
      const saved = await worktreeScope.run(
        { worktreeRoot: first, projectHash: 'first', execution },
        () =>
          storePattern(first, {
            type: 'workflow',
            pattern: 'Cancelled graph only',
            context: 'Committed row retained',
            _skipGate: true,
          }),
      );
      await entered.promise;
      abort.abort(new Error('Cancel graph after pattern commit'));
      release.resolve();
      await awaitBackgroundOps();
      await finished.promise;
      const accessor = await worktreeScope.run({ worktreeRoot: first, projectHash: 'first' }, () =>
        getBrainAccessor(first),
      );
      expect((await accessor.getPattern(saved.id))?.pattern).toBe('Cancelled graph only');
      expect(await accessor.getPageNode(`pattern:${saved.id}`)).toBeNull();
    } finally {
      release.resolve();
      await finished.promise;
    }
  });
});
