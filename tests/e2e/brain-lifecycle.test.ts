/**
 * Brain Lifecycle E2E Tests
 *
 * End-to-end tests for Phase 3-4 brain features:
 * 1. observe -> FTS5 search -> verify found
 * 2. observe -> hybrid search -> verify found (FTS5-only mode)
 * 3. PageIndex graph: add nodes + edges -> query neighbors -> verify traversal
 * 4. reasonWhy on mock task chain -> verify trace structure
 * 5. applyTemporalDecay -> verify reduced confidence
 * 6. consolidateMemories on old entries -> verify summary created
 *
 * All tests use real SQLite databases in temp directories. No mocks.
 *
 * @task T5398
 * @epic T5149
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ============================================================================
// 1. observe -> FTS5 search -> verify found
// ============================================================================

describe('E2E: observe -> FTS5 search', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainRetrieval: typeof import('../../src/core/memory/brain-retrieval.js');
  let brainSearch: typeof import('../../src/core/memory/brain-search.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brain-lifecycle-fts-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainRetrieval = await import('../../src/core/memory/brain-retrieval.js');
    brainSearch = await import('../../src/core/memory/brain-search.js');

    brainSqlite.resetBrainDbState();
    brainSearch.resetFts5Cache();
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('observes an entry and finds it via FTS5 search', async () => {
    const obs = await brainRetrieval.observeBrain(testDir, {
      text: 'Drizzle ORM migration requires snapshot.json for every migration.sql',
      title: 'Drizzle migration snapshot requirement',
      type: 'discovery',
      sourceType: 'agent',
    });

    expect(obs.id).toMatch(/^O-/);

    const searchResult = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'Drizzle migration snapshot',
    });

    expect(searchResult.total).toBeGreaterThan(0);
    const found = searchResult.results.find((r) => r.id === obs.id);
    expect(found).toBeDefined();
    expect(found!.type).toBe('observation');
  });
});

// ============================================================================
// 2. observe -> hybrid search -> verify found (FTS5-only mode)
// ============================================================================

describe('E2E: observe -> hybrid search', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainRetrieval: typeof import('../../src/core/memory/brain-retrieval.js');
  let brainSearch: typeof import('../../src/core/memory/brain-search.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brain-lifecycle-hybrid-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainRetrieval = await import('../../src/core/memory/brain-retrieval.js');
    brainSearch = await import('../../src/core/memory/brain-search.js');

    brainSqlite.resetBrainDbState();
    brainSearch.resetFts5Cache();
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('finds observation via hybrid search in FTS5-only mode', async () => {
    const obs = await brainRetrieval.observeBrain(testDir, {
      text: 'Atomic file operations prevent data corruption during concurrent writes',
      title: 'Atomic write safety pattern',
      type: 'discovery',
      sourceType: 'agent',
    });

    expect(obs.id).toMatch(/^O-/);

    const results = await brainSearch.hybridSearch('atomic write corruption', testDir, {
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === obs.id);
    expect(found).toBeDefined();
    expect(found!.sources).toContain('fts');
  });
});

// ============================================================================
// 3. PageIndex graph: add nodes + edges -> query neighbors
// ============================================================================

describe('E2E: PageIndex graph traversal', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainAccessorMod: typeof import('../../src/store/brain-accessor.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brain-lifecycle-graph-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainAccessorMod = await import('../../src/store/brain-accessor.js');

    brainSqlite.resetBrainDbState();
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('adds nodes and edges, then queries neighbors', async () => {
    const accessor = await brainAccessorMod.getBrainAccessor(testDir);

    // Add 3 concept nodes
    await accessor.addPageNode({
      id: 'concept:auth',
      nodeType: 'concept',
      label: 'Authentication',
    });
    await accessor.addPageNode({ id: 'concept:jwt', nodeType: 'concept', label: 'JWT Tokens' });
    await accessor.addPageNode({
      id: 'concept:oauth',
      nodeType: 'concept',
      label: 'OAuth2 Protocol',
    });

    // Connect: auth -> jwt (related_to), auth -> oauth (related_to)
    await accessor.addPageEdge({
      fromId: 'concept:auth',
      toId: 'concept:jwt',
      edgeType: 'related_to',
    });
    await accessor.addPageEdge({
      fromId: 'concept:auth',
      toId: 'concept:oauth',
      edgeType: 'related_to',
    });

    // Query neighbors of auth
    const neighbors = await accessor.getNeighbors('concept:auth');
    expect(neighbors.length).toBe(2);

    const neighborIds = neighbors.map((n) => n.id);
    expect(neighborIds).toContain('concept:jwt');
    expect(neighborIds).toContain('concept:oauth');

    // Verify node retrieval
    const authNode = await accessor.getPageNode('concept:auth');
    expect(authNode).not.toBeNull();
    expect(authNode!.label).toBe('Authentication');
  });
});

// ============================================================================
// 4. reasonWhy on mock task chain
// ============================================================================

describe('E2E: reasonWhy causal trace', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brain-lifecycle-reason-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainSqlite.resetBrainDbState();

    // Initialize brain.db so accessor is available
    await brainSqlite.getBrainDb(testDir);

    // reasonWhy reads from getTaskPath() which returns .cleo/tasks.db
    // and parses it as JSON via readJsonRequired. Write a JSON file at that path.
    const tasksFile = {
      version: '2025.1.0',
      project: { name: 'test', prefix: 'T' },
      lastUpdated: '2026-03-04T00:00:00.000Z',
      _meta: { schemaVersion: '2025.1.0' },
      tasks: [
        {
          id: 'T1',
          title: 'Root blocker',
          description: 'The root cause',
          status: 'blocked',
          depends: [],
          blockedBy: 'External dependency',
        },
        {
          id: 'T2',
          title: 'Middle task',
          description: 'Depends on T1',
          status: 'blocked',
          depends: ['T1'],
        },
        {
          id: 'T3',
          title: 'Leaf task',
          description: 'Depends on T2',
          status: 'blocked',
          depends: ['T2'],
        },
      ],
    };

    await writeFile(join(testDir, '.cleo', 'tasks.db'), JSON.stringify(tasksFile, null, 2));
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('traces blocker chain and identifies root causes', async () => {
    const { reasonWhy } = await import('../../src/core/memory/brain-reasoning.js');

    const trace = await reasonWhy('T3', testDir);

    expect(trace.taskId).toBe('T3');
    expect(trace.blockers.length).toBeGreaterThanOrEqual(1);

    // T2 should be a blocker of T3
    const t2Blocker = trace.blockers.find((b) => b.taskId === 'T2');
    expect(t2Blocker).toBeDefined();
    expect(t2Blocker!.status).toBe('blocked');

    // T1 should be identified as a root cause (no unresolved deps of its own)
    expect(trace.rootCauses).toContain('T1');
    expect(trace.depth).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// 5. applyTemporalDecay -> verify reduced confidence
// ============================================================================

describe('E2E: temporal decay', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainAccessorMod: typeof import('../../src/store/brain-accessor.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brain-lifecycle-decay-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainAccessorMod = await import('../../src/store/brain-accessor.js');

    brainSqlite.resetBrainDbState();
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('reduces confidence of old learnings', async () => {
    const accessor = await brainAccessorMod.getBrainAccessor(testDir);

    // Insert a learning with an old date and known confidence
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) // 60 days ago
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    await accessor.addLearning({
      id: 'L-decay-test',
      insight: 'Old insight about testing patterns',
      source: 'historical analysis',
      confidence: 0.9,
      actionable: true,
      createdAt: oldDate,
    });

    // Verify initial confidence
    const before = await accessor.getLearning('L-decay-test');
    expect(before).not.toBeNull();
    expect(before!.confidence).toBe(0.9);

    const { applyTemporalDecay } = await import('../../src/core/memory/brain-lifecycle.js');

    const result = await applyTemporalDecay(testDir, {
      decayRate: 0.99,
      olderThanDays: 30,
    });

    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(result.tablesProcessed).toContain('brain_learnings');

    // Verify confidence was reduced
    const after = await accessor.getLearning('L-decay-test');
    expect(after).not.toBeNull();
    expect(after!.confidence).toBeLessThan(0.9);
  });
});

// ============================================================================
// 6. consolidateMemories on old entries -> verify summary created
// ============================================================================

describe('E2E: memory consolidation', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainAccessorMod: typeof import('../../src/store/brain-accessor.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brain-lifecycle-consolidate-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainAccessorMod = await import('../../src/store/brain-accessor.js');

    brainSqlite.resetBrainDbState();
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('groups old similar observations and creates summary', async () => {
    const accessor = await brainAccessorMod.getBrainAccessor(testDir);

    // Create 4 old, similar observations (same topic: authentication testing)
    const oldDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000) // 120 days ago
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    for (let i = 0; i < 4; i++) {
      await accessor.addObservation({
        id: `O-consolidate-${i}`,
        type: 'discovery',
        title: `Authentication testing pattern variant ${i}`,
        narrative: `Discovered authentication testing pattern for login flow variant ${i} with token validation`,
        contentHash: `hash-consolidate-${i}`,
        sourceType: 'agent',
        createdAt: oldDate,
      });
    }

    const { consolidateMemories } = await import('../../src/core/memory/brain-lifecycle.js');

    const result = await consolidateMemories(testDir, {
      olderThanDays: 90,
      minClusterSize: 3,
    });

    expect(result.grouped).toBeGreaterThanOrEqual(3);
    expect(result.merged).toBeGreaterThanOrEqual(1);
    expect(result.archived).toBeGreaterThanOrEqual(3);

    // Verify originals are archived
    const archived = await accessor.getObservation('O-consolidate-0');
    expect(archived).not.toBeNull();
    expect(archived!.narrative).toMatch(/^\[ARCHIVED\]/);
  });
});
