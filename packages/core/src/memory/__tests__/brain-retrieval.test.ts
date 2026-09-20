/**
 * Tests for BRAIN retrieval operations — 3-layer pattern.
 *
 * Tests: searchBrainCompact, timelineBrain, fetchBrainEntries, observeBrain.
 *
 * @task T5131 T5132 T5133 T5134 T5135
 * @epic T5149
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worktreeScope } from '../../paths.js';
import {
  awaitBackgroundOps,
  createOperationExecutionContext,
  pendingBackgroundOpCount,
} from '../../store/background-ops.js';

let tempDir: string;
let cleoDir: string;

describe('Brain Retrieval', () => {
  aroundEach(async (runTest) => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-retrieval-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });

    await worktreeScope.run(
      { worktreeRoot: tempDir, projectHash: 'brain-retrieval-test' },
      runTest,
    );
  });

  beforeEach(async () => {
    // Initialize tasks.db with test session for cross-db write-guard validation
    const { getDb } = await import('../../store/sqlite.js');
    const { sessions } = await import('../../store/tasks-schema.js');
    const db = await getDb(tempDir);
    await db
      .insert(sessions)
      .values({ id: 'S-123', name: 'test-session', status: 'active' })
      .onConflictDoNothing()
      .run();
  });

  afterEach(async () => {
    await awaitBackgroundOps();
    try {
      const { shutdownBrainWriter, _resetBrainWriterForTests } = await import(
        '../brain-writer-thread.js'
      );
      await shutdownBrainWriter();
      _resetBrainWriterForTests();
    } catch {
      /* may not be loaded */
    }
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* may not be loaded */
    }
    try {
      const { closeDb } = await import('../../store/sqlite.js');
      closeDb();
    } catch {
      /* may not be loaded */
    }
    try {
      const { resetFts5Cache } = await import('../brain-search.js');
      resetFts5Cache();
    } catch {
      /* may not be loaded */
    }
    // Race rm against an 8s timeout. On Windows, fs.rm can block indefinitely
    // on locked SQLite WAL files — racing prevents the hook from timing out.
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  // ==========================================================================
  // searchBrainCompact
  // ==========================================================================

  describe('searchBrainCompact', () => {
    it.each([
      'lexical',
      'rrf',
      'fetch',
    ])('retains project/session ownership until telemetry finishes (%s)', async (method) => {
      const { searchBrainCompact, fetchBrainEntries } = await import('../brain-retrieval.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const { getDb, closeAllDatabases } = await import('../../store/sqlite.js');
      const { sessions } = await import('../../store/tasks-schema.js');
      const retrieval = await import('../retrieval/log-retrieval.js');
      const original = retrieval.logRetrieval;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<void>();
      const second = await mkdtemp(join(tmpdir(), 'cleo-retrieval-owner-b-'));
      const spy = vi.spyOn(retrieval, 'logRetrieval').mockImplementation(async (...args) => {
        if (args[0] === tempDir) {
          entered.resolve();
          await release.promise;
        }
        try {
          await original(...args);
        } finally {
          if (args[0] === tempDir) completed.resolve();
        }
      });
      try {
        await mkdir(join(second, '.cleo'));
        await worktreeScope.run({ worktreeRoot: second, projectHash: 'seed-b' }, async () => {
          const secondDb = await getDb(second);
          await secondDb
            .insert(sessions)
            .values({ id: 'S-B', name: 'second', status: 'active' })
            .run();
        });
        for (const root of [tempDir, second]) {
          await worktreeScope.run({ worktreeRoot: root, projectHash: 'seed' }, async () => {
            const accessor = await getBrainAccessor(root);
            await accessor.addObservation({
              id: 'O-owner',
              type: 'discovery',
              title: 'ownershipneedle',
              narrative: 'ownershipneedle',
              sourceType: 'agent',
            });
          });
        }
        const first =
          method === 'fetch'
            ? await fetchBrainEntries(tempDir, { ids: ['O-owner'] })
            : await searchBrainCompact(tempDir, {
                query: 'ownershipneedle',
                tables: ['observations'],
                useRRF: method === 'rrf',
              });
        expect(first.results.map((hit) => hit.id)).toContain('O-owner');
        await entered.promise;
        expect(pendingBackgroundOpCount()).toBeGreaterThan(0);
        const next =
          method === 'fetch'
            ? await fetchBrainEntries(second, { ids: ['O-owner'] })
            : await searchBrainCompact(second, {
                query: 'ownershipneedle',
                tables: ['observations'],
                useRRF: method === 'rrf',
              });
        expect(next.results.map((hit) => hit.id)).toContain('O-owner');
        release.resolve();
        await completed.promise;
        await awaitBackgroundOps();
        expect(pendingBackgroundOpCount()).toBe(0);
        for (const [root, session] of [
          [tempDir, 'S-123'],
          [second, 'S-B'],
        ]) {
          const native = worktreeScope.run({ worktreeRoot: root, projectHash: 'read' }, () =>
            getBrainNativeDb(root),
          );
          expect(
            native
              ?.prepare('SELECT session_id FROM brain_retrieval_log WHERE query = ?')
              .all(method === 'fetch' ? 'O-owner' : 'ownershipneedle'),
          ).toEqual([{ session_id: session }]);
          expect(
            native
              ?.prepare('SELECT citation_count FROM brain_observations WHERE id = ?')
              .get('O-owner'),
          ).toMatchObject({ citation_count: 1 });
        }
      } finally {
        release.resolve();
        if (spy.mock.calls.some((args) => args[0] === tempDir)) await completed.promise;
        await awaitBackgroundOps();
        spy.mockRestore();
        await closeAllDatabases();
        await rm(second, { recursive: true, force: true });
      }
    });

    it.each(
      ['lexical', 'rrf', 'fetch'].flatMap((method) =>
        ['cancel', 'deadline'].map((stop) => ({ method, stop })),
      ),
    )('prevents telemetry writes after the original operation $method $stop', async ({
      method,
      stop,
    }) => {
      const { searchBrainCompact, fetchBrainEntries } = await import('../brain-retrieval.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const retrieval = await import('../retrieval/log-retrieval.js');
      const original = retrieval.logRetrieval;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      await writeFile(
        join(cleoDir, 'project-info.json'),
        JSON.stringify({
          projectId: 'telemetry-fixture',
          projectHash: 'telemetry-fixture',
          projectRoot: tempDir,
        }),
      );
      const accessor = await getBrainAccessor(tempDir);
      await accessor.addObservation({
        id: 'O-cancel',
        type: 'discovery',
        title: 'cancelneedle',
        narrative: 'cancelneedle',
        sourceType: 'agent',
      });
      const abort = new AbortController();
      const context = createOperationExecutionContext(
        {
          projectRoot: tempDir,
          projectId: 'telemetry-fixture',
          actor: 'test',
          operation: 'memory.find',
          idempotencyKey: stop,
        },
        { budgetMs: 10000, signal: abort.signal },
      );
      const spy = vi.spyOn(retrieval, 'logRetrieval').mockImplementation(async (...args) => {
        entered.resolve();
        await release.promise;
        try {
          await original(...args);
        } finally {
          finished.resolve();
        }
      });
      try {
        const found = await worktreeScope.run(
          { worktreeRoot: tempDir, projectHash: 'test', execution: context },
          () =>
            method === 'fetch'
              ? fetchBrainEntries(tempDir, { ids: ['O-cancel'] })
              : searchBrainCompact(tempDir, {
                  query: 'cancelneedle',
                  tables: ['observations'],
                  useRRF: method === 'rrf',
                }),
        );
        expect(found.results.map((hit) => hit.id)).toContain('O-cancel');
        await entered.promise;
        expect(pendingBackgroundOpCount()).toBeGreaterThan(0);
        if (stop === 'cancel') abort.abort();
        else vi.spyOn(Date, 'now').mockReturnValue(context.deadlineAt + 1);
        release.resolve();
        await finished.promise;
        await awaitBackgroundOps();
        expect(pendingBackgroundOpCount()).toBe(0);
        vi.restoreAllMocks();
        const native = getBrainNativeDb(tempDir);
        const table = native
          ?.prepare("SELECT name FROM sqlite_master WHERE name = 'brain_retrieval_log'")
          .get();
        if (table)
          expect(
            native
              ?.prepare('SELECT COUNT(*) AS count FROM brain_retrieval_log WHERE query = ?')
              .get(method === 'fetch' ? 'O-cancel' : 'cancelneedle'),
          ).toEqual({ count: 0 });
        else expect(table).toBeUndefined();
      } finally {
        release.resolve();
        if (spy.mock.calls.length > 0) await finished.promise;
        await awaitBackgroundOps();
        vi.restoreAllMocks();
        context.close();
      }
    });

    it.each([
      'complete',
      'cancel',
      'deadline',
    ])('tracks budget citation lifetime and ownership: %s', async (stop) => {
      const { retrieveWithBudget } = await import('../brain-retrieval.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const { closeAllDatabases } = await import('../../store/sqlite.js');
      const citation = await import('../retrieval/increment-citation-counts.js');
      const original = citation.incrementCitationCounts;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      const second = await mkdtemp(join(tmpdir(), 'cleo-budget-owner-b-'));
      await mkdir(join(second, '.cleo'));
      await writeFile(
        join(cleoDir, 'project-info.json'),
        JSON.stringify({
          projectId: 'budget-fixture',
          projectHash: 'budget-fixture',
          projectRoot: tempDir,
        }),
      );
      for (const root of [tempDir, second]) {
        await worktreeScope.run({ worktreeRoot: root, projectHash: 'seed' }, async () => {
          const accessor = await getBrainAccessor(root);
          await accessor.addObservation({
            id: 'O-budget',
            type: 'discovery',
            title: 'budgetneedle',
            narrative: 'budgetneedle durable evidence',
            sourceType: 'agent',
          });
        });
      }
      const abort = new AbortController();
      const context = createOperationExecutionContext(
        {
          projectRoot: tempDir,
          projectId: 'budget-fixture',
          actor: 'test',
          operation: 'memory.retrieve',
          idempotencyKey: stop,
        },
        { budgetMs: 10000, signal: abort.signal },
      );
      const spy = vi
        .spyOn(citation, 'incrementCitationCounts')
        .mockImplementation(async (...args) => {
          if (args[0] === tempDir) {
            entered.resolve();
            await release.promise;
          }
          try {
            await original(...args);
          } finally {
            if (args[0] === tempDir) finished.resolve();
          }
        });
      try {
        const result = await worktreeScope.run(
          { worktreeRoot: tempDir, projectHash: 'test', execution: context },
          () => retrieveWithBudget(tempDir, 'budgetneedle', 500),
        );
        expect(result.entries.map((entry) => entry.id)).toContain('O-budget');
        await entered.promise;
        expect(pendingBackgroundOpCount()).toBeGreaterThan(0);
        if (stop === 'complete') {
          const next = await retrieveWithBudget(second, 'budgetneedle', 500);
          expect(next.entries.map((entry) => entry.id)).toContain('O-budget');
        } else if (stop === 'cancel') abort.abort();
        else vi.spyOn(Date, 'now').mockReturnValue(context.deadlineAt + 1);
        release.resolve();
        await finished.promise;
        await awaitBackgroundOps();
        expect(pendingBackgroundOpCount()).toBe(0);
        vi.restoreAllMocks();
        for (const root of [tempDir, second]) {
          const native = worktreeScope.run({ worktreeRoot: root, projectHash: 'read' }, () =>
            getBrainNativeDb(root),
          );
          expect(
            native
              ?.prepare('SELECT citation_count FROM brain_observations WHERE id = ?')
              .get('O-budget'),
          ).toEqual({ citation_count: stop === 'complete' ? 1 : 0 });
        }
      } finally {
        release.resolve();
        if (spy.mock.calls.some((args) => args[0] === tempDir)) await finished.promise;
        await awaitBackgroundOps();
        vi.restoreAllMocks();
        context.close();
        await closeAllDatabases();
        await rm(second, { recursive: true, force: true });
      }
    });

    it('should return empty results for empty query', async () => {
      const { searchBrainCompact } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      const result = await searchBrainCompact(tempDir, { query: '' });
      expect(result.results).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.tokensEstimated).toBe(0);
    });

    it('should return compact results from decisions', async () => {
      const { searchBrainCompact } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D001',
        type: 'architecture',
        decision: 'Use SQLite for persistent storage in BRAIN module',
        rationale: 'Reliable embedded database with FTS5',
        confidence: 'high',
      });

      const result = await searchBrainCompact(tempDir, { query: 'SQLite' });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0].id).toBe('D001');
      expect(result.results[0].type).toBe('decision');
      expect(result.results[0].title).toBe('Use SQLite for persistent storage in BRAIN module');
      expect(result.results[0].date).toBeTruthy();
      expect(result.tokensEstimated).toBe(result.results.length * 50);
    });

    it('should return compact results from all table types', async () => {
      const { searchBrainCompact } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);

      await accessor.addDecision({
        id: 'D001',
        type: 'technical',
        decision: 'Use unified search for memory',
        rationale: 'Better developer experience',
        confidence: 'high',
      });
      await accessor.addPattern({
        id: 'P001',
        type: 'workflow',
        pattern: 'Search then filter pattern for memory',
        context: 'Memory retrieval',
        frequency: 3,
      });
      await accessor.addLearning({
        id: 'L001',
        insight: 'Unified memory search reduces token usage',
        source: 'T5131',
        confidence: 0.9,
        actionable: true,
      });
      await accessor.addObservation({
        id: 'O-test1',
        type: 'discovery',
        title: 'Memory retrieval needs compact search layer',
        narrative: 'Compact search for memory saves tokens',
        sourceType: 'agent',
      });

      const result = await searchBrainCompact(tempDir, { query: 'memory' });
      const types = result.results.map((r) => r.type);
      expect(types).toContain('decision');
      expect(types).toContain('pattern');
      expect(types).toContain('learning');
      expect(types).toContain('observation');
    });

    it('should filter by table type', async () => {
      const { searchBrainCompact } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D001',
        type: 'technical',
        decision: 'Compact format for search results',
        rationale: 'Saves tokens',
        confidence: 'medium',
      });
      await accessor.addPattern({
        id: 'P001',
        type: 'optimization',
        pattern: 'Compact format improves performance',
        context: 'API design',
        frequency: 2,
      });

      const result = await searchBrainCompact(tempDir, {
        query: 'compact',
        tables: ['decisions'],
      });
      expect(result.results.every((r) => r.type === 'decision')).toBe(true);
    });

    it('should apply date filters', async () => {
      const { searchBrainCompact } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D001',
        type: 'technical',
        decision: 'Old date filter test decision',
        rationale: 'Testing date ranges',
        confidence: 'medium',
        createdAt: '2025-01-01 00:00:00',
      });
      await accessor.addDecision({
        id: 'D002',
        type: 'technical',
        decision: 'Recent date filter test decision',
        rationale: 'Testing date ranges',
        confidence: 'medium',
        createdAt: '2026-06-01 00:00:00',
      });

      const result = await searchBrainCompact(tempDir, {
        query: 'date filter test',
        dateStart: '2026-01-01',
      });
      expect(result.results.every((r) => r.date >= '2026-01-01')).toBe(true);
    });

    it('should truncate titles to 80 characters', async () => {
      const { searchBrainCompact } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      const longDecision =
        'This is a very long decision about truncation testing that exceeds eighty characters and should be properly truncated in compact results';
      await accessor.addDecision({
        id: 'D001',
        type: 'technical',
        decision: longDecision,
        rationale: 'Test truncation behavior',
        confidence: 'low',
      });

      const result = await searchBrainCompact(tempDir, { query: 'truncation' });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0].title.length).toBeLessThanOrEqual(80);
      expect(longDecision.length).toBeGreaterThan(80);
    });

    it('T1900: mode=recency returns observations newest-first regardless of BM25 rank', async () => {
      const { searchBrainCompact } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainNativeDb, getBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
      resetFts5Cache();

      // Initialize the brain DB first via accessor
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const accessor = await getBrainAccessor(tempDir);

      // Insert two observations with explicit created_at timestamps:
      // stale row: 2026-04-24 — matches 'session' keyword
      // fresh row: 2026-05-05 — also matches 'session' keyword
      // BM25 may rank the stale row first (it was observed in T1900 with the old code).
      await accessor.addObservation({
        id: 'O-stale-session',
        type: 'discovery',
        title: 'session notes from April',
        narrative: 'session debrief from April 24',
        sourceType: 'session-debrief',
      });
      await accessor.addObservation({
        id: 'O-fresh-session',
        type: 'discovery',
        title: 'session notes from May',
        narrative: 'session debrief from May 05',
        sourceType: 'session-debrief',
      });

      // Backdate the stale row directly so we control the timestamp
      await getBrainDb(tempDir);
      const nativeDb = getBrainNativeDb(tempDir);
      if (nativeDb) {
        nativeDb
          .prepare(
            "UPDATE brain_observations SET created_at = '2026-04-24T10:00:00.000Z' WHERE id = 'O-stale-session'",
          )
          .run();
        nativeDb
          .prepare(
            "UPDATE brain_observations SET created_at = '2026-05-05T10:00:00.000Z' WHERE id = 'O-fresh-session'",
          )
          .run();
      }

      const result = await searchBrainCompact(tempDir, {
        query: 'session',
        tables: ['observations'],
        mode: 'recency',
      });

      expect(result.results.length).toBeGreaterThanOrEqual(2);
      // May row must rank BEFORE April row (descending date order)
      const ids = result.results.map((r) => r.id);
      const freshIdx = ids.indexOf('O-fresh-session');
      const staleIdx = ids.indexOf('O-stale-session');
      expect(freshIdx).toBeGreaterThanOrEqual(0);
      expect(staleIdx).toBeGreaterThanOrEqual(0);
      expect(freshIdx).toBeLessThan(staleIdx);
    });
  });

  // ==========================================================================
  // timelineBrain
  // ==========================================================================

  describe('timelineBrain', () => {
    it('should return null anchor for unknown ID', async () => {
      const { timelineBrain } = await import('../brain-retrieval.js');
      const { closeBrainDb, getBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();
      await getBrainDb(tempDir);

      const result = await timelineBrain(tempDir, { anchor: 'D-nonexistent' });
      expect(result.anchor).toBeNull();
      expect(result.before).toHaveLength(0);
      expect(result.after).toHaveLength(0);
    });

    it('should return null anchor for unrecognized ID prefix', async () => {
      const { timelineBrain } = await import('../brain-retrieval.js');
      const { closeBrainDb, getBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();
      await getBrainDb(tempDir);

      const result = await timelineBrain(tempDir, { anchor: 'UNKNOWN-123' });
      expect(result.anchor).toBeNull();
    });

    it('should return anchor data for a decision', async () => {
      const { timelineBrain } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D001',
        type: 'architecture',
        decision: 'Use drizzle ORM',
        rationale: 'Type-safe queries',
        confidence: 'high',
        createdAt: '2026-03-01 12:00:00',
      });

      const result = await timelineBrain(tempDir, { anchor: 'D001' });
      expect(result.anchor).not.toBeNull();
      expect(result.anchor!.id).toBe('D001');
      expect(result.anchor!.type).toBe('decision');
      expect(result.anchor!.data).toBeTruthy();
    });

    it('should return before and after entries across tables', async () => {
      const { timelineBrain } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);

      // Create entries with different timestamps across tables
      await accessor.addDecision({
        id: 'D001',
        type: 'technical',
        decision: 'Early decision',
        rationale: 'First',
        confidence: 'low',
        createdAt: '2026-01-01 10:00:00',
      });
      await accessor.addPattern({
        id: 'P001',
        type: 'workflow',
        pattern: 'Early pattern',
        context: 'Testing',
        frequency: 1,
        extractedAt: '2026-01-15 10:00:00',
      });
      // Anchor
      await accessor.addLearning({
        id: 'L001',
        insight: 'Middle learning (anchor)',
        source: 'T5132',
        confidence: 0.8,
        actionable: true,
        createdAt: '2026-02-01 12:00:00',
      });
      await accessor.addDecision({
        id: 'D002',
        type: 'technical',
        decision: 'Later decision',
        rationale: 'After anchor',
        confidence: 'high',
        createdAt: '2026-03-01 10:00:00',
      });
      await accessor.addObservation({
        id: 'O-after1',
        type: 'discovery',
        title: 'Late observation',
        narrative: 'After anchor',
        sourceType: 'agent',
        createdAt: '2026-03-15 10:00:00',
      });

      const result = await timelineBrain(tempDir, {
        anchor: 'L001',
        depthBefore: 5,
        depthAfter: 5,
      });

      expect(result.anchor).not.toBeNull();
      expect(result.anchor!.id).toBe('L001');
      expect(result.anchor!.type).toBe('learning');

      // Before: D001 and P001 should appear
      expect(result.before.length).toBeGreaterThanOrEqual(2);
      const beforeIds = result.before.map((e) => e.id);
      expect(beforeIds).toContain('D001');
      expect(beforeIds).toContain('P001');

      // After: D002 and O-after1 should appear
      expect(result.after.length).toBeGreaterThanOrEqual(2);
      const afterIds = result.after.map((e) => e.id);
      expect(afterIds).toContain('D002');
      expect(afterIds).toContain('O-after1');
    });

    it('should respect depth parameters', async () => {
      const { timelineBrain } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);

      // Create many entries before the anchor
      for (let i = 1; i <= 5; i++) {
        await accessor.addDecision({
          id: `D${String(i).padStart(3, '0')}`,
          type: 'technical',
          decision: `Decision ${i}`,
          rationale: `Rationale ${i}`,
          confidence: 'low',
          createdAt: `2026-01-${String(i).padStart(2, '0')} 10:00:00`,
        });
      }

      // Anchor
      await accessor.addLearning({
        id: 'L001',
        insight: 'Anchor learning',
        source: 'T5132',
        confidence: 0.5,
        actionable: false,
        createdAt: '2026-02-01 12:00:00',
      });

      const result = await timelineBrain(tempDir, {
        anchor: 'L001',
        depthBefore: 2,
        depthAfter: 0,
      });

      expect(result.before.length).toBeLessThanOrEqual(2);
      expect(result.after).toHaveLength(0);
    });

    it('should handle observation anchors with O- prefix', async () => {
      const { timelineBrain } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addObservation({
        id: 'O-test123',
        type: 'feature',
        title: 'Test observation anchor',
        narrative: 'Testing observation as anchor',
        sourceType: 'agent',
        createdAt: '2026-03-01 12:00:00',
      });

      const result = await timelineBrain(tempDir, { anchor: 'O-test123' });
      expect(result.anchor).not.toBeNull();
      expect(result.anchor!.id).toBe('O-test123');
      expect(result.anchor!.type).toBe('observation');
    });
  });

  // ==========================================================================
  // fetchBrainEntries
  // ==========================================================================

  describe('fetchBrainEntries', () => {
    it('should return empty for empty IDs array', async () => {
      const { fetchBrainEntries } = await import('../brain-retrieval.js');
      const { closeBrainDb, getBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();
      await getBrainDb(tempDir);

      const result = await fetchBrainEntries(tempDir, { ids: [] });
      expect(result.results).toHaveLength(0);
      expect(result.notFound).toHaveLength(0);
      expect(result.tokensEstimated).toBe(0);
    });

    it('should fetch entries by IDs from different tables', async () => {
      const { fetchBrainEntries } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);

      await accessor.addDecision({
        id: 'D001',
        type: 'architecture',
        decision: 'Use fetch by ID pattern',
        rationale: 'Direct access',
        confidence: 'high',
      });
      await accessor.addPattern({
        id: 'P001',
        type: 'workflow',
        pattern: 'Batch fetch pattern',
        context: 'API design',
        frequency: 2,
      });
      await accessor.addLearning({
        id: 'L001',
        insight: 'Batch fetching reduces round-trips',
        source: 'T5133',
        confidence: 0.85,
        actionable: true,
      });
      await accessor.addObservation({
        id: 'O-fetch1',
        type: 'discovery',
        title: 'Observation for fetch test',
        narrative: 'Testing batch fetch',
        sourceType: 'agent',
      });

      const result = await fetchBrainEntries(tempDir, {
        ids: ['D001', 'P001', 'L001', 'O-fetch1'],
      });

      expect(result.results).toHaveLength(4);
      expect(result.notFound).toHaveLength(0);
      expect(result.tokensEstimated).toBe(4 * 500);

      const types = result.results.map((r) => r.type);
      expect(types).toContain('decision');
      expect(types).toContain('pattern');
      expect(types).toContain('learning');
      expect(types).toContain('observation');
    });

    it('should report not-found IDs', async () => {
      const { fetchBrainEntries } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D001',
        type: 'technical',
        decision: 'Existing decision',
        rationale: 'Test',
        confidence: 'low',
      });

      const result = await fetchBrainEntries(tempDir, {
        ids: ['D001', 'D999', 'P999', 'UNKNOWN-123'],
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe('D001');
      expect(result.notFound).toContain('D999');
      expect(result.notFound).toContain('P999');
      expect(result.notFound).toContain('UNKNOWN-123');
    });

    it('should return full data in each entry', async () => {
      const { fetchBrainEntries } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D001',
        type: 'architecture',
        decision: 'Full data test decision',
        rationale: 'Verify all fields returned',
        confidence: 'high',
      });

      const result = await fetchBrainEntries(tempDir, { ids: ['D001'] });
      expect(result.results).toHaveLength(1);

      const entry = result.results[0];
      expect(entry.id).toBe('D001');
      expect(entry.type).toBe('decision');

      const data = entry.data as Record<string, unknown>;
      expect(data['decision']).toBe('Full data test decision');
      expect(data['rationale']).toBe('Verify all fields returned');
      expect(data['confidence']).toBe('high');
    });
  });

  // ==========================================================================
  // observeBrain
  // ==========================================================================

  describe('observeBrain', () => {
    it('should create an observation with generated ID', async () => {
      const { observeBrain } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      const result = await observeBrain(tempDir, {
        text: 'Test observation for brain module',
      });

      expect(result.id).toMatch(/^O-/);
      expect(result.type).toBeTruthy();
      expect(result.createdAt).toBeTruthy();
    });

    it('should auto-classify type from text keywords', async () => {
      const { observeBrain } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      const bugResult = await observeBrain(tempDir, {
        text: 'Found a bug in the search module that causes a crash',
      });
      expect(bugResult.type).toBe('bugfix');

      const featureResult = await observeBrain(tempDir, {
        text: 'Implement new retrieval layer for BRAIN',
      });
      expect(featureResult.type).toBe('feature');

      const refactorResult = await observeBrain(tempDir, {
        text: 'Refactor the engine compatibility layer',
      });
      expect(refactorResult.type).toBe('refactor');

      const changeResult = await observeBrain(tempDir, {
        text: 'Update the timeline query to use UNION ALL',
      });
      expect(changeResult.type).toBe('change');

      const decisionResult = await observeBrain(tempDir, {
        text: 'Decided to use async pattern instead of sync',
      });
      expect(decisionResult.type).toBe('decision');

      const discoveryResult = await observeBrain(tempDir, {
        text: 'Interesting behavior in the database layer',
      });
      expect(discoveryResult.type).toBe('discovery');
    });

    it('should use provided type over auto-classification', async () => {
      const { observeBrain } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      // Text has 'bug' keyword but we override with 'feature'
      const result = await observeBrain(tempDir, {
        text: 'This has bug keyword but is a feature',
        type: 'feature',
      });
      expect(result.type).toBe('feature');
    });

    it('should use provided title', async () => {
      const { observeBrain } = await import('../brain-retrieval.js');
      const { fetchBrainEntries } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      const result = await observeBrain(tempDir, {
        text: 'Long observation text that describes a discovery in detail',
        title: 'Custom Title',
      });

      // Fetch it back and verify
      const fetched = await fetchBrainEntries(tempDir, { ids: [result.id] });
      expect(fetched.results).toHaveLength(1);
      const data = fetched.results[0].data as Record<string, unknown>;
      expect(data['title']).toBe('Custom Title');
    });

    it('should throw on empty text', async () => {
      const { observeBrain } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      // Need to init DB first
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      await getBrainDb(tempDir);

      await expect(observeBrain(tempDir, { text: '' })).rejects.toThrow(
        'Observation text is required',
      );

      await expect(observeBrain(tempDir, { text: '   ' })).rejects.toThrow(
        'Observation text is required',
      );
    });

    it('should store observation searchable via searchBrainCompact', async () => {
      const { observeBrain, searchBrainCompact } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      const created = await observeBrain(tempDir, {
        text: 'Unique searchable observation content xyzzy123',
        title: 'Searchable xyzzy123 observation',
      });

      // Search should find it
      const searchResult = await searchBrainCompact(tempDir, {
        query: 'xyzzy123',
        tables: ['observations'],
      });

      expect(searchResult.results.length).toBeGreaterThan(0);
      expect(searchResult.results[0].id).toBe(created.id);
      expect(searchResult.results[0].type).toBe('observation');
    });

    it('should set sourceType and project', async () => {
      const { observeBrain, fetchBrainEntries } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      const result = await observeBrain(tempDir, {
        text: 'Observation with metadata',
        sourceType: 'session-debrief',
        project: 'cleo',
        sourceSessionId: 'S-123',
      });

      const fetched = await fetchBrainEntries(tempDir, { ids: [result.id] });
      expect(fetched.results).toHaveLength(1);
      const data = fetched.results[0].data as Record<string, unknown>;
      expect(data['sourceType']).toBe('session-debrief');
      expect(data['project']).toBe('cleo');
      expect(data['sourceSessionId']).toBe('S-123');
    });
  });

  // ==========================================================================
  // T793: rrfScore + bm25Score on BrainCompactHit (RRF path)
  // ==========================================================================

  describe('T793 — rrfScore and bm25Score on compact hits', () => {
    it('exposes rrfScore (number > 0) on each RRF-path hit', async () => {
      const { searchBrainCompact } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D-rrf1',
        type: 'technical',
        decision: 'RRF score normalization decision',
        rationale: 'Expose rrfScore on compact hits',
        confidence: 'high',
      });

      const result = await searchBrainCompact(tempDir, {
        query: 'RRF score normalization',
        useRRF: false, // FTS-only to ensure deterministic hit
        tables: ['decisions'],
      });

      // FTS-only path does not populate rrfScore; use a separate RRF call.
      const rrfResult = await searchBrainCompact(tempDir, {
        query: 'RRF score normalization',
        useRRF: true,
        tables: ['decisions'],
      });

      expect(result.results.length).toBeGreaterThan(0);
      // FTS-only path: no rrfScore field
      expect(result.results[0]!.rrfScore).toBeUndefined();

      // RRF path: rrfScore must be a positive number
      if (rrfResult.results.length > 0) {
        const hit = rrfResult.results[0]!;
        expect(typeof hit.rrfScore).toBe('number');
        expect(hit.rrfScore!).toBeGreaterThan(0);
      }
    });

    it('exposes bm25Score in [0, 1] range on RRF hits', async () => {
      const { searchBrainCompact } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D-bm25-1',
        type: 'technical',
        decision: 'BM25 bm25Score test first entry bm25 normalization',
        rationale: 'Testing bm25Score range',
        confidence: 'high',
      });
      await accessor.addDecision({
        id: 'D-bm25-2',
        type: 'technical',
        decision: 'BM25 bm25Score test second entry normalization',
        rationale: 'Testing bm25Score range',
        confidence: 'medium',
      });

      const result = await searchBrainCompact(tempDir, {
        query: 'bm25Score normalization',
        useRRF: true,
        tables: ['decisions'],
      });

      for (const hit of result.results) {
        expect(typeof hit.bm25Score).toBe('number');
        expect(hit.bm25Score!).toBeGreaterThanOrEqual(0);
        expect(hit.bm25Score!).toBeLessThanOrEqual(1);
      }
    });

    it('top FTS hit gets bm25Score = 1.0 when only one FTS result', async () => {
      const { searchBrainCompact } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D-bm25-solo',
        type: 'technical',
        decision: 'Unique solitary bm25scoretoprank entry xyz987',
        rationale: 'Test top rank',
        confidence: 'high',
      });

      const result = await searchBrainCompact(tempDir, {
        query: 'bm25scoretoprank xyz987',
        useRRF: true,
        tables: ['decisions'],
      });

      // When only one FTS result, maxFtsRank = 0 so bm25Score = 1 - (0/0 default) = 1
      if (result.results.length === 1) {
        expect(result.results[0]!.bm25Score).toBe(1);
      }
    });

    it('rrfScore values are positive and in descending order', async () => {
      const { searchBrainCompact } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      for (let i = 1; i <= 3; i++) {
        await accessor.addDecision({
          id: `D-order${i}`,
          type: 'technical',
          decision: `RRF order test decision rrforderdesc entry ${i}`.repeat(Math.max(1, 4 - i)),
          rationale: 'Ordering test',
          confidence: 'high',
        });
      }

      const result = await searchBrainCompact(tempDir, {
        query: 'rrforderdesc order test',
        useRRF: true,
        tables: ['decisions'],
      });

      const scores = result.results.filter((r) => r.rrfScore !== undefined).map((r) => r.rrfScore!);

      for (let i = 0; i < scores.length - 1; i++) {
        expect(scores[i]!).toBeGreaterThanOrEqual(scores[i + 1]!);
      }
    });
  });

  // ==========================================================================
  // T794: observation retention floor — auto-promote to medium tier
  // ==========================================================================

  describe('T794 — retention floor: auto-promote to medium tier', () => {
    it('defaults to short tier for single-task-ref observations', async () => {
      const { observeBrain, fetchBrainEntries } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      const result = await observeBrain(tempDir, {
        text: 'Working on T123 only — single task reference here',
      });

      const fetched = await fetchBrainEntries(tempDir, { ids: [result.id] });
      expect(fetched.results).toHaveLength(1);
      const data = fetched.results[0]!.data as Record<string, unknown>;
      expect(data['memoryTier']).toBe('short');
    });

    it('auto-promotes to medium when text contains ≥2 distinct task IDs', async () => {
      const { observeBrain, fetchBrainEntries } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      const result = await observeBrain(tempDir, {
        text: 'T793 and T794 both landed in wave1 — cross-task observation',
      });

      const fetched = await fetchBrainEntries(tempDir, { ids: [result.id] });
      expect(fetched.results).toHaveLength(1);
      const data = fetched.results[0]!.data as Record<string, unknown>;
      expect(data['memoryTier']).toBe('medium');
    });

    it('auto-promotes to medium when text contains ≥2 distinct task IDs (3 unique)', async () => {
      const { observeBrain, fetchBrainEntries } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      const result = await observeBrain(tempDir, {
        text: 'Completed T100, T101, and T102 in same session',
      });

      const fetched = await fetchBrainEntries(tempDir, { ids: [result.id] });
      expect(fetched.results).toHaveLength(1);
      const data = fetched.results[0]!.data as Record<string, unknown>;
      expect(data['memoryTier']).toBe('medium');
    });

    it('does NOT promote when the same task ID appears multiple times', async () => {
      const { observeBrain, fetchBrainEntries } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      const result = await observeBrain(tempDir, {
        text: 'T999 was mentioned, then T999 was mentioned again — same task T999',
      });

      const fetched = await fetchBrainEntries(tempDir, { ids: [result.id] });
      expect(fetched.results).toHaveLength(1);
      const data = fetched.results[0]!.data as Record<string, unknown>;
      expect(data['memoryTier']).toBe('short');
    });

    it('auto-promotes to medium when crossRef has ≥1 entry', async () => {
      const { observeBrain, fetchBrainEntries } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      const result = await observeBrain(tempDir, {
        text: 'This observation has a cross-reference to another entry',
        crossRef: ['D-rrf1'],
      });

      const fetched = await fetchBrainEntries(tempDir, { ids: [result.id] });
      expect(fetched.results).toHaveLength(1);
      const data = fetched.results[0]!.data as Record<string, unknown>;
      expect(data['memoryTier']).toBe('medium');
    });

    it('stays short when crossRef is empty array', async () => {
      const { observeBrain, fetchBrainEntries } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      const result = await observeBrain(tempDir, {
        text: 'Single observation with empty crossRef array',
        crossRef: [],
      });

      const fetched = await fetchBrainEntries(tempDir, { ids: [result.id] });
      expect(fetched.results).toHaveLength(1);
      const data = fetched.results[0]!.data as Record<string, unknown>;
      expect(data['memoryTier']).toBe('short');
    });

    it('promotes via crossRef even with no task IDs in text', async () => {
      const { observeBrain, fetchBrainEntries } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      const result = await observeBrain(tempDir, {
        text: 'No task refs but has crossRef entry — should promote',
        crossRef: ['O-some-other-obs'],
      });

      const fetched = await fetchBrainEntries(tempDir, { ids: [result.id] });
      expect(fetched.results).toHaveLength(1);
      const data = fetched.results[0]!.data as Record<string, unknown>;
      expect(data['memoryTier']).toBe('medium');
    });
  });

  // ==========================================================================
  // Integration: search -> timeline -> fetch
  // ==========================================================================

  describe('3-layer integration', () => {
    it('should flow: search -> timeline -> fetch', async () => {
      const { searchBrainCompact, timelineBrain, fetchBrainEntries } = await import(
        '../brain-retrieval.js'
      );
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);

      // Seed data
      await accessor.addDecision({
        id: 'D001',
        type: 'architecture',
        decision: 'Integration test architecture decision',
        rationale: 'Testing 3-layer flow',
        confidence: 'high',
        createdAt: '2026-01-15 10:00:00',
      });
      await accessor.addPattern({
        id: 'P001',
        type: 'workflow',
        pattern: 'Integration test workflow pattern',
        context: '3-layer retrieval',
        frequency: 1,
        extractedAt: '2026-02-01 10:00:00',
      });
      await accessor.addLearning({
        id: 'L001',
        insight: 'Integration test learning insight',
        source: 'T5131',
        confidence: 0.9,
        actionable: true,
        createdAt: '2026-03-01 10:00:00',
      });

      // Layer 1: Search
      const searchResult = await searchBrainCompact(tempDir, { query: 'integration test' });
      expect(searchResult.results.length).toBeGreaterThan(0);

      // Layer 2: Timeline around first result
      const firstHit = searchResult.results[0];
      const timelineResult = await timelineBrain(tempDir, {
        anchor: firstHit.id,
        depthBefore: 5,
        depthAfter: 5,
      });
      expect(timelineResult.anchor).not.toBeNull();

      // Layer 3: Fetch full details for anchor + neighbors
      const allIds = [
        timelineResult.anchor!.id,
        ...timelineResult.before.map((e) => e.id),
        ...timelineResult.after.map((e) => e.id),
      ];
      const fetchResult = await fetchBrainEntries(tempDir, { ids: allIds });
      expect(fetchResult.results.length).toBeGreaterThan(0);
      expect(fetchResult.notFound).toHaveLength(0);
      expect(fetchResult.tokensEstimated).toBe(fetchResult.results.length * 500);
    });
  });
});
