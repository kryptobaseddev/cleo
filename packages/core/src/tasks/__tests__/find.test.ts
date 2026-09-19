/**
 * Tests for task search (find).
 * @task T4460
 * @epic T4454
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { findTasks, fuzzyScore, RELEVANCE_STRONG_MIN, taskFind } from '../find.js';

describe('fuzzyScore', () => {
  it('returns 100 for exact match', () => {
    expect(fuzzyScore('hello', 'hello')).toBe(100);
  });

  it('returns high score for contains', () => {
    expect(fuzzyScore('auth', 'implement authentication')).toBeGreaterThan(60);
  });

  it('returns 0 for no match', () => {
    expect(fuzzyScore('xyz', 'abc')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('AUTH', 'authentication')).toBeGreaterThan(0);
  });
});

describe('findTasks', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('requires query, id, or at least one filter', async () => {
    await seedTasks(accessor, []);

    // T1187-followup / v2026.4.114: message now covers the filter-only path
    // so the error guides users to `--status` / `--role` as a valid entrypoint.
    await expect(findTasks({}, env.tempDir, accessor)).rejects.toThrow(/query.*--id.*filter/i);
  });

  it('finds tasks by fuzzy query', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Implement authentication',
        status: 'pending',
        priority: 'high',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Fix database query',
        status: 'done',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Update docs',
        status: 'pending',
        priority: 'low',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await findTasks({ query: 'auth', fuzzy: true }, env.tempDir, accessor);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.id).toBe('T001');
    expect(result.searchType).toBe('fuzzy');
  });

  it('excludes unrelated subsequences from default discovery and duplicate checks', async () => {
    await seedTasks(accessor, [
      {
        id: 'T77',
        title: 'Detect and evaluate a decoupled inline engine',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    const lexical = await findTasks({ query: 'deadline' }, env.tempDir, accessor);
    expect(lexical.results).toEqual([]);
    expect(lexical.population.matched).toBe(0);
    expect(lexical.searchType).toBe('lexical');
    const fuzzy = await findTasks({ query: 'deadline', fuzzy: true }, env.tempDir, accessor);
    expect(fuzzy.results).toHaveLength(1);
    expect(fuzzy.results[0].match).toMatchObject({ kind: 'fuzzy', fields: ['title'], terms: [] });
    expect(fuzzy.results[0].match.reason).toContain('Explicit fuzzy opt-in');
  });

  it('honors selected Unicode fields and returns matching basis through SDK projections', async () => {
    await seedTasks(accessor, [
      {
        id: 'T78',
        title: 'plain task',
        description: '解析 authentication',
        notes: ['only-notes-token'],
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T79',
        title: '解析 title',
        description: 'other',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    const description = await findTasks(
      { query: '解析', field: 'description' },
      env.tempDir,
      accessor,
    );
    expect(description.results.map((t) => t.id)).toEqual(['T78']);
    expect(description.results[0].match).toMatchObject({
      kind: 'lexical',
      fields: ['description'],
      terms: ['解析'],
    });
    expect(
      (
        await findTasks({ query: 'only-notes-token', field: 'notes' }, env.tempDir, accessor)
      ).results.map((t) => t.id),
    ).toEqual(['T78']);
    expect(
      (await findTasks({ query: 'T78', field: 'id' }, env.tempDir, accessor)).results.map(
        (t) => t.id,
      ),
    ).toEqual(['T78']);
    for (const verbose of [false, true]) {
      const result = await taskFind(env.tempDir, '解析', 0, { field: 'description', verbose });
      expect(result.success).toBe(true);
      expect(result.data?.searchType).toBe('lexical');
      expect(result.data?.results[0].match).toMatchObject({
        kind: 'lexical',
        fields: ['description'],
      });
    }
    await expect(
      findTasks({ query: '解析', field: 'missing' }, env.tempDir, accessor),
    ).rejects.toThrow(/Unsupported search field/);
    await expect(
      findTasks({ query: '解析', exact: true, fuzzy: true }, env.tempDir, accessor),
    ).rejects.toThrow(/cannot be combined/);
  });

  it('finds tasks by ID prefix', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T010',
        title: 'Task 10',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T100',
        title: 'Task 100',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await findTasks({ id: 'T01' }, env.tempDir, accessor);
    expect(result.results).toHaveLength(1); // T010 starts with T01
    expect(result.results[0]!.id).toBe('T010');
    expect(result.searchType).toBe('id');
  });

  it('finds tasks by exact title', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Exact Match',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Not Exact Match',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await findTasks({ query: 'Exact Match', exact: true }, env.tempDir, accessor);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.id).toBe('T001');
    expect(result.searchType).toBe('exact');
  });

  it('returns minimal fields only', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task with lots of data',
        status: 'pending',
        priority: 'high',
        description: 'Long description here',
        notes: ['Note 1', 'Note 2'],
        labels: ['bug'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await findTasks({ query: 'lots' }, env.tempDir, accessor);
    const found = result.results[0]!;
    expect(found.id).toBe('T001');
    expect(found.title).toBeDefined();
    expect(found.status).toBeDefined();
    expect(found.priority).toBeDefined();
    expect(found.score).toBeDefined();
    // Should NOT include heavy fields
    expect((found as unknown as Record<string, unknown>)['description']).toBeUndefined();
    expect((found as unknown as Record<string, unknown>)['notes']).toBeUndefined();
  });

  it('filters by status', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Done task',
        status: 'done',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Pending task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await findTasks({ query: 'task', status: 'pending' }, env.tempDir, accessor);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.id).toBe('T002');
  });
});

// ---------------------------------------------------------------------------
// T12067 — relevance tiers
// ---------------------------------------------------------------------------

describe('fuzzyScore relevance tiers (T12067)', () => {
  it('scores a full-word cover as strong', () => {
    expect(fuzzyScore('saga tree', 'tree view for a saga')).toBe(70);
    expect(fuzzyScore('saga tree', 'tree view for a saga')).toBeGreaterThanOrEqual(
      RELEVANCE_STRONG_MIN,
    );
  });

  it('demotes a PARTIAL word cover below the strong floor', () => {
    // Matches only "tree" of "saga tree". Before T12067 this scored 60 — a
    // strong-tier score — which is why `find "saga tree"` returned 1818 of
    // 4980 tasks.
    const score = fuzzyScore('saga tree', 'Build WorkGraphView.svelte tree component');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(RELEVANCE_STRONG_MIN);
  });

  it('keeps a bare character-subsequence match in the weak tier', () => {
    // 'deadline' is a subsequence of a great deal of ordinary English.
    const score = fuzzyScore('deadline', 'Detect and evaluate a decoupled inline engine');
    if (score > 0) expect(score).toBeLessThan(RELEVANCE_STRONG_MIN);
  });

  it('still ranks an exact substring above every weaker tier', () => {
    const exact = fuzzyScore('saga tree', 'cleo saga tree <id> recursive hierarchy');
    const allWords = fuzzyScore('saga tree', 'tree view for a saga');
    const partial = fuzzyScore('saga tree', 'Build WorkGraphView.svelte tree component');
    expect(exact).toBe(80);
    expect(exact).toBeGreaterThan(allWords);
    expect(allWords).toBeGreaterThan(partial);
  });

  it('preserves single-word behaviour as a strong match', () => {
    expect(fuzzyScore('auth', 'implement authentication')).toBeGreaterThanOrEqual(
      RELEVANCE_STRONG_MIN,
    );
  });
});
