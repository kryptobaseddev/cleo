/**
 * Unit tests for `emitDispatchTrace`.
 *
 * Verifies that:
 * - `verifyAndStore` is called with the correct `memoryType`, `sourceConfidence`,
 *   and `tier` when `emitDispatchTrace` is invoked.
 * - The universal-fallback path (the primary T1325 scenario) produces a trace
 *   that carries `fallbackUsed=true` and the `resolverWarning` text.
 * - Registry-hit traces produce `fallbackUsed=false` with no `resolverWarning`.
 * - The emitted text contains all required trace fields.
 *
 * @task T1325
 * @epic T1323
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { worktreeScope } from '../../project-scope.js';
import { resolveAgent } from '../../store/agent-resolver.js';
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

describe('emitDispatchTrace', () => {
  it('calls verifyAndStore with memoryType=pattern and sourceConfidence=speculative', async () => {
    mockVerifyAndStore.mockClear();

    const { emitDispatchTrace } = await import('../dispatch-trace.js');

    await emitDispatchTrace('/tmp/fake-project', {
      taskId: 'T1000',
      predictedAgentId: 'ct-cleo',
      confidence: 0.87,
      reason: "resolved at tier 'packaged'",
      registryHit: true,
      fallbackUsed: false,
      resolvedAt: '2026-04-24T00:00:00.000Z',
    });

    expect(mockVerifyAndStore).toHaveBeenCalledOnce();

    const [projectRoot, candidate] = mockVerifyAndStore.mock.calls[0]!;
    expect(projectRoot).toBe('/tmp/fake-project');

    const c = candidate;
    // 'procedural' is the BRAIN schema value for process/dispatch knowledge
    // (task spec named this 'pattern' but the schema uses 'procedural')
    expect(c.memoryType).toBe('procedural');
    expect(c.sourceConfidence).toBe('speculative');
    expect(c.tier).toBe('short');
    expect(c.source).toBe('task-completion');
  });

  it('universal-fallback path — trace includes resolverWarning and fallbackUsed=true', async () => {
    mockVerifyAndStore.mockClear();

    const { emitDispatchTrace } = await import('../dispatch-trace.js');

    const warning =
      "[agent-resolver] agent 'ghost-agent' not found in project/global/packaged/fallback tiers — " +
      "falling back to universal base 'cleo-subagent'.";

    await emitDispatchTrace('/tmp/fake-project', {
      taskId: 'T9999',
      predictedAgentId: 'ghost-agent',
      confidence: 0,
      reason: 'universal-base fallback engaged after tiers: project, global, packaged, fallback',
      registryHit: false,
      fallbackUsed: true,
      resolverWarning: warning,
      resolvedAt: '2026-04-24T00:00:00.000Z',
    });

    expect(mockVerifyAndStore).toHaveBeenCalledOnce();

    const [, candidate] = mockVerifyAndStore.mock.calls[0]!;
    const c = candidate;

    // Title should signal universal fallback
    expect(c.title).toContain('universal-fallback');

    // Text must contain the resolver warning
    expect(c.text).toContain('resolverWarning:');
    expect(c.text).toContain('ghost-agent');
    expect(c.text).toContain('fallbackUsed: true');
  });

  it('registry-hit path — no resolverWarning in text', async () => {
    mockVerifyAndStore.mockClear();

    const { emitDispatchTrace } = await import('../dispatch-trace.js');

    await emitDispatchTrace('/tmp/fake-project', {
      taskId: 'T2000',
      predictedAgentId: 'ct-orchestrator',
      confidence: 0.95,
      reason: "resolved at tier 'global'",
      registryHit: true,
      fallbackUsed: false,
      resolvedAt: '2026-04-24T00:00:00.000Z',
    });

    expect(mockVerifyAndStore).toHaveBeenCalledOnce();

    const [, candidate] = mockVerifyAndStore.mock.calls[0]!;
    const c = candidate;

    expect(c.text).not.toContain('resolverWarning');
    expect(c.text).toContain('registryHit: true');
    expect(c.text).toContain('fallbackUsed: false');
  });
});

describe('resolver dispatch trace lifecycle', () => {
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
    const cant = join(directory, 'base.cant');
    await writeFile(cant, 'Synthetic universal protocol');
    return { first, second, cant };
  }

  it('keeps actual resolver-emitter work pending through the completion barrier', async () => {
    const { first, cant } = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    mockVerifyAndStore.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      finished.resolve();
      return { action: 'stored', id: 'O-held', reason: 'controlled write completed' };
    });
    const db = new DatabaseSync(':memory:');
    let barrierFinished = false;
    try {
      resolveAgent(db, 'fixture-worker', {
        projectRoot: first,
        preferTier: 'universal',
        universalBasePath: cant,
      });
      await entered.promise;
      expect(pendingBackgroundOpCount()).toBeGreaterThan(0);
      const barrier = awaitBackgroundOps().then(() => {
        barrierFinished = true;
      });
      await Promise.resolve();
      expect(barrierFinished).toBe(false);
      release.resolve();
      await barrier;
      expect(barrierFinished).toBe(true);
      expect(pendingBackgroundOpCount()).toBe(0);
    } finally {
      release.resolve();
      await finished.promise;
      db.close();
    }
  });

  it('retains interleaved caller roots and the original execution identity', async () => {
    const { first, second, cant } = await fixture();
    const seen: string[] = [];
    const one = createOperationExecutionContext(
      {
        projectRoot: first,
        projectId: 'first',
        actor: 'test',
        operation: 'agent.resolve',
        idempotencyKey: 'one',
      },
      { budgetMs: 10000 },
    );
    const two = createOperationExecutionContext(
      {
        projectRoot: second,
        projectId: 'second',
        actor: 'test',
        operation: 'agent.resolve',
        idempotencyKey: 'two',
      },
      { budgetMs: 10000 },
    );
    mockVerifyAndStore.mockImplementation(async (root) => {
      seen.push(root);
      const execution = worktreeScope.getStore()?.execution;
      expect(execution).toBe(root === first ? one : two);
      return { action: 'stored', id: 'O-owned', reason: 'fixture' };
    });
    const db = new DatabaseSync(':memory:');
    try {
      for (const [root, execution] of [
        [first, one],
        [second, two],
      ] as const) {
        worktreeScope.run(
          { worktreeRoot: root, projectHash: execution.identity.projectId, execution },
          () =>
            resolveAgent(db, 'fixture-worker', {
              projectRoot: root,
              preferTier: 'universal',
              universalBasePath: cant,
            }),
        );
      }
      await awaitBackgroundOps();
      expect(seen.toSorted()).toEqual([first, second].toSorted());
    } finally {
      db.close();
    }
  });

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

  it.each([
    'cancelled',
    'expired',
  ] as const)('does not start optional writes after the original lifetime is %s', async (stop) => {
    const { first, cant } = await fixture();
    const abort = new AbortController();
    const execution = createOperationExecutionContext(
      {
        projectRoot: first,
        projectId: 'first',
        actor: 'test',
        operation: 'agent.resolve',
        idempotencyKey: stop,
      },
      { deadlineAt: stop === 'expired' ? 0 : Date.now() + 10000, signal: abort.signal },
    );
    const db = new DatabaseSync(':memory:');
    mockVerifyAndStore.mockClear();
    try {
      worktreeScope.run({ worktreeRoot: first, projectHash: 'first', execution }, () => {
        resolveAgent(db, 'fixture-worker', {
          projectRoot: first,
          preferTier: 'universal',
          universalBasePath: cant,
        });
        if (stop === 'cancelled') abort.abort(new Error('Caller cancelled'));
      });
      await awaitBackgroundOps();
      // Drain the original untracked import as well, making the defective-source oracle deterministic.
      const { emitDispatchTrace } = await import('../dispatch-trace.js');
      expect(emitDispatchTrace).toBeTypeOf('function');
      await Promise.resolve();
      expect(mockVerifyAndStore).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
