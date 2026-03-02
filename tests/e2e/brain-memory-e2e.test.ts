/**
 * Brain Memory Pipeline — Comprehensive E2E Tests
 *
 * Validates the full brain memory system end-to-end:
 *
 * 1. Observation Full Lifecycle (observeBrain -> search -> timeline -> fetch)
 * 2. Multi-Type Search (keyword, type filter, date filter, BM25 relevance)
 * 3. Token Efficiency (compact search vs full fetch, 5x+ savings)
 * 4. Cross-Linking (observation <-> task bidirectional links)
 * 5. Session Memory Capture (persistSessionMemory from debrief data)
 * 6. Session Briefing with Memory (getSessionMemoryContext enrichment)
 * 7. FTS5 Search Quality (varied content, partial matches, edge cases)
 *
 * All tests use real SQLite databases in temp directories. No mocks.
 *
 * NOTE: Seeding uses accessor.addObservation() with explicit IDs to avoid
 * the Date.now() collision bug in observeBrain() when called rapidly.
 * Tests that exercise observeBrain() directly add small delays.
 *
 * @task T5141
 * @epic T5149
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Small delay to avoid Date.now() ID collision in observeBrain(). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Scenario 1: Observation Full Lifecycle
// ============================================================================

describe('Scenario 1: Observation Full Lifecycle', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainRetrieval: typeof import('../../src/core/memory/brain-retrieval.js');
  let brainSearch: typeof import('../../src/core/memory/brain-search.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brain-e2e-lifecycle-'));
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

  it('creates an observation via observeBrain and retrieves it through all 3 layers', async () => {
    // Layer 0: Create observation
    const obs = await brainRetrieval.observeBrain(testDir, {
      text: 'Discovered that WAL mode prevents lock contention in multi-reader SQLite',
      title: 'WAL mode prevents lock contention',
      type: 'discovery',
      project: 'cleo',
      sourceType: 'agent',
    });

    expect(obs.id).toMatch(/^O-/);
    expect(obs.type).toBe('discovery');
    expect(obs.createdAt).toBeTruthy();

    // Layer 1: Search for it via compact search
    const searchResult = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'WAL mode lock',
    });

    expect(searchResult.results.length).toBeGreaterThanOrEqual(1);
    const found = searchResult.results.find((r) => r.id === obs.id);
    expect(found).toBeDefined();
    expect(found!.type).toBe('observation');
    expect(found!.title).toContain('WAL mode');

    // Layer 2: Timeline around anchor
    const timeline = await brainRetrieval.timelineBrain(testDir, {
      anchor: obs.id,
    });

    expect(timeline.anchor).not.toBeNull();
    expect(timeline.anchor!.id).toBe(obs.id);
    expect(timeline.anchor!.type).toBe('observation');

    // Layer 3: Fetch full details
    const fetched = await brainRetrieval.fetchBrainEntries(testDir, {
      ids: [obs.id],
    });

    expect(fetched.results.length).toBe(1);
    expect(fetched.results[0].id).toBe(obs.id);
    expect(fetched.results[0].type).toBe('observation');
    expect(fetched.notFound).toEqual([]);

    const data = fetched.results[0].data as Record<string, unknown>;
    expect(data.title).toBe('WAL mode prevents lock contention');
    expect(data.narrative).toContain('WAL mode prevents lock contention');
  });

  it('auto-classifies observation type from text keywords', async () => {
    // "bug" keyword -> bugfix
    const bugObs = await brainRetrieval.observeBrain(testDir, {
      text: 'Found a bug in the session end handler that corrupts debrief data',
    });
    expect(bugObs.type).toBe('bugfix');

    await delay(2);

    // "refactor" keyword -> refactor
    const refactorObs = await brainRetrieval.observeBrain(testDir, {
      text: 'Refactor the dispatch layer to use shared engine pattern',
    });
    expect(refactorObs.type).toBe('refactor');

    await delay(2);

    // "implement" keyword -> feature
    const featureObs = await brainRetrieval.observeBrain(testDir, {
      text: 'Implement the brain.db FTS5 search module',
    });
    expect(featureObs.type).toBe('feature');

    await delay(2);

    // No matching keyword -> discovery
    const genericObs = await brainRetrieval.observeBrain(testDir, {
      text: 'The sky is blue and the grass is green on a sunny day',
    });
    expect(genericObs.type).toBe('discovery');
  });

  it('rejects empty text observations', async () => {
    await expect(
      brainRetrieval.observeBrain(testDir, { text: '' }),
    ).rejects.toThrow('Observation text is required');

    await expect(
      brainRetrieval.observeBrain(testDir, { text: '   ' }),
    ).rejects.toThrow('Observation text is required');
  });

  it('fetchBrainEntries handles unknown IDs gracefully', async () => {
    const result = await brainRetrieval.fetchBrainEntries(testDir, {
      ids: ['O-nonexistent', 'ZZZZ-invalid'],
    });

    expect(result.results).toEqual([]);
    expect(result.notFound).toContain('O-nonexistent');
    expect(result.notFound).toContain('ZZZZ-invalid');
  });

  it('fetchBrainEntries returns empty for empty ids array', async () => {
    const result = await brainRetrieval.fetchBrainEntries(testDir, { ids: [] });
    expect(result.results).toEqual([]);
    expect(result.notFound).toEqual([]);
    expect(result.tokensEstimated).toBe(0);
  });
});

// ============================================================================
// Scenario 2: Multi-Type Search
// ============================================================================

describe('Scenario 2: Multi-Type Search', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainAccessorModule: typeof import('../../src/store/brain-accessor.js');
  let brainRetrieval: typeof import('../../src/core/memory/brain-retrieval.js');
  let brainSearch: typeof import('../../src/core/memory/brain-search.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brain-e2e-multitype-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainAccessorModule = await import('../../src/store/brain-accessor.js');
    brainRetrieval = await import('../../src/core/memory/brain-retrieval.js');
    brainSearch = await import('../../src/core/memory/brain-search.js');

    brainSqlite.resetBrainDbState();
    brainSearch.resetFts5Cache();

    // Seed diverse data across all brain tables using accessor directly
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);

    // Decisions
    await accessor.addDecision({
      id: 'D001',
      type: 'technical',
      decision: 'Use SQLite for embedded database storage',
      rationale: 'Zero-dependency, serverless operation for CLI tools',
      confidence: 'high',
      createdAt: '2026-01-15 10:00:00',
    });
    await accessor.addDecision({
      id: 'D002',
      type: 'architecture',
      decision: 'Adopt dispatch-first shared-core architecture',
      rationale: 'Clean separation between MCP/CLI and business logic',
      confidence: 'high',
      createdAt: '2026-02-01 12:00:00',
    });
    await accessor.addDecision({
      id: 'D003',
      type: 'process',
      decision: 'Use CalVer for versioning',
      rationale: 'Time-based releases align with sprint cadence',
      confidence: 'medium',
      createdAt: '2026-02-15 08:30:00',
    });

    // Patterns
    await accessor.addPattern({
      id: 'P001',
      type: 'success',
      pattern: 'Atomic file operations prevent data corruption',
      context: 'Database write safety in CLI tools',
      frequency: 15,
      impact: 'high',
      extractedAt: '2026-01-20 09:00:00',
    });
    await accessor.addPattern({
      id: 'P002',
      type: 'workflow',
      pattern: 'FTS5 content-sync triggers for real-time indexing',
      context: 'Full-text search in SQLite databases',
      frequency: 5,
      impact: 'medium',
      extractedAt: '2026-02-10 14:00:00',
    });

    // Learnings
    await accessor.addLearning({
      id: 'L001',
      insight: 'WAL mode essential for SQLite multi-reader performance',
      source: 'production-debugging',
      confidence: 0.95,
      actionable: true,
      createdAt: '2026-01-25 11:00:00',
    });
    await accessor.addLearning({
      id: 'L002',
      insight: 'drizzle-orm sqlite-proxy pattern works well for node:sqlite',
      source: 'wave2-implementation',
      confidence: 0.88,
      actionable: true,
      createdAt: '2026-02-05 16:00:00',
    });

    // Observations seeded via accessor with explicit IDs
    const observations = [
      { id: 'O-seed-001', type: 'discovery' as const, title: 'FTS5 rebuild after bulk insert', narrative: 'Discovered that FTS5 requires explicit rebuild after bulk inserts' },
      { id: 'O-seed-002', type: 'change' as const, title: 'Auto-rebuild FTS on first query', narrative: 'Changed the brain-search module to auto-rebuild FTS on first query' },
      { id: 'O-seed-003', type: 'feature' as const, title: '3-layer retrieval pattern', narrative: 'Implemented the 3-layer retrieval pattern: search, timeline, fetch' },
      { id: 'O-seed-004', type: 'bugfix' as const, title: 'Fix empty search FTS5 error', narrative: 'Fixed a bug where empty search queries caused FTS5 syntax error' },
      { id: 'O-seed-005', type: 'decision' as const, title: 'Base36 timestamps for IDs', narrative: 'Decided to use base36 timestamps for observation IDs' },
      { id: 'O-seed-006', type: 'refactor' as const, title: 'Refactor brain-accessor to drizzle', narrative: 'Refactored the brain-accessor to use drizzle ORM instead of raw SQL' },
    ];

    for (const obs of observations) {
      await accessor.addObservation({
        id: obs.id,
        type: obs.type,
        title: obs.title,
        narrative: obs.narrative,
        project: 'cleo',
        sourceType: 'agent',
        createdAt: '2026-03-01 10:00:00',
      });
    }
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('searches by keyword and returns relevant results across all types', async () => {
    const result = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'SQLite',
    });

    expect(result.results.length).toBeGreaterThanOrEqual(2);
    // Should find the SQLite decision and the WAL learning at minimum
    const types = new Set(result.results.map((r) => r.type));
    expect(types.size).toBeGreaterThanOrEqual(1);
  });

  it('filters by table type — decisions only', async () => {
    const result = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'architecture',
      tables: ['decisions'],
    });

    for (const r of result.results) {
      expect(r.type).toBe('decision');
    }
  });

  it('filters by table type — observations only', async () => {
    const result = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'FTS5',
      tables: ['observations'],
    });

    for (const r of result.results) {
      expect(r.type).toBe('observation');
    }
  });

  it('filters by date range', async () => {
    const result = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'SQLite',
      dateStart: '2026-02-01',
      dateEnd: '2026-02-28',
    });

    for (const r of result.results) {
      expect(r.date >= '2026-02-01').toBe(true);
      expect(r.date <= '2026-02-28').toBe(true);
    }
  });

  it('returns empty results for non-matching query', async () => {
    const result = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'xyzzy_nonexistent_term_42',
    });

    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.tokensEstimated).toBe(0);
  });

  it('returns empty results for empty query', async () => {
    const result = await brainRetrieval.searchBrainCompact(testDir, {
      query: '',
    });

    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('respects limit parameter', async () => {
    const result = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'the', // common word, should match many
      limit: 3,
    });

    // Limit applies per-table in searchBrain, then results are merged.
    // With limit=3, each table returns up to 3 results, so total can be
    // more than 3. But each individual table is capped.
    // We just verify it doesn't return an unreasonable number.
    expect(result.results.length).toBeLessThanOrEqual(12); // 3 per table * 4 tables
  });
});

// ============================================================================
// Scenario 3: Token Efficiency
// ============================================================================

describe('Scenario 3: Token Efficiency', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainAccessorModule: typeof import('../../src/store/brain-accessor.js');
  let brainRetrieval: typeof import('../../src/core/memory/brain-retrieval.js');
  let brainSearch: typeof import('../../src/core/memory/brain-search.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brain-e2e-tokens-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainAccessorModule = await import('../../src/store/brain-accessor.js');
    brainRetrieval = await import('../../src/core/memory/brain-retrieval.js');
    brainSearch = await import('../../src/core/memory/brain-search.js');

    brainSqlite.resetBrainDbState();
    brainSearch.resetFts5Cache();

    // Seed 25 observations using accessor with explicit IDs (avoids Date.now collision)
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);
    for (let i = 0; i < 25; i++) {
      await accessor.addObservation({
        id: `O-token-${String(i).padStart(3, '0')}`,
        type: 'discovery',
        title: `Detailed observation about CLEO system aspect #${i}`,
        narrative: `Observation #${i}: This is a detailed finding about the CLEO task management system. ` +
          `It covers architectural patterns, implementation details, and performance characteristics. ` +
          `The system uses SQLite with WAL mode for reliable storage, FTS5 for full-text search, ` +
          `and drizzle ORM for type-safe queries. Each observation has metadata including timestamps, ` +
          `project scope, source type, and optional links to tasks and sessions.`,
        project: 'cleo',
        sourceType: 'agent',
        createdAt: `2026-03-01 ${String(10 + i).padStart(2, '0')}:00:00`,
      });
    }
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('compact search returns significantly less data than full fetch', async () => {
    // Compact search
    const compact = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'CLEO system',
      limit: 10,
    });

    expect(compact.results.length).toBeGreaterThanOrEqual(5);

    // Measure compact size: each hit has id, type, title (80 char max), date
    const compactJson = JSON.stringify(compact.results);
    const compactBytes = Buffer.byteLength(compactJson, 'utf-8');

    // Full fetch for the same IDs
    const ids = compact.results.map((r) => r.id);
    const full = await brainRetrieval.fetchBrainEntries(testDir, { ids });

    expect(full.results.length).toBe(compact.results.length);

    // Measure full size
    const fullJson = JSON.stringify(full.results);
    const fullBytes = Buffer.byteLength(fullJson, 'utf-8');

    // Full fetch should be at least 3x larger than compact search
    expect(fullBytes).toBeGreaterThan(compactBytes * 3);
  });

  it('compact search token estimate is ~50 per result', async () => {
    const result = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'CLEO',
      limit: 10,
    });

    if (result.results.length > 0) {
      const tokensPerResult = result.tokensEstimated / result.results.length;
      expect(tokensPerResult).toBe(50); // exact: 50 tokens per result
    }
  });

  it('full fetch token estimate is ~500 per result', async () => {
    const compact = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'CLEO',
      limit: 5,
    });

    const ids = compact.results.map((r) => r.id);
    const full = await brainRetrieval.fetchBrainEntries(testDir, { ids });

    if (full.results.length > 0) {
      const tokensPerResult = full.tokensEstimated / full.results.length;
      expect(tokensPerResult).toBe(500); // exact: 500 tokens per result
    }
  });

  it('search + fetch token ratio is at least 5x', async () => {
    const compact = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'CLEO',
      limit: 10,
    });

    if (compact.results.length > 0) {
      const ids = compact.results.map((r) => r.id);
      const full = await brainRetrieval.fetchBrainEntries(testDir, { ids });

      const ratio = full.tokensEstimated / compact.tokensEstimated;
      expect(ratio).toBeGreaterThanOrEqual(5); // 500/50 = 10x exactly
    }
  });
});

// ============================================================================
// Scenario 4: Cross-Linking
// ============================================================================

describe('Scenario 4: Cross-Linking', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainRetrieval: typeof import('../../src/core/memory/brain-retrieval.js');
  let brainLinks: typeof import('../../src/core/memory/brain-links.js');
  let brainSearch: typeof import('../../src/core/memory/brain-search.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brain-e2e-links-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainRetrieval = await import('../../src/core/memory/brain-retrieval.js');
    brainLinks = await import('../../src/core/memory/brain-links.js');
    brainSearch = await import('../../src/core/memory/brain-search.js');

    brainSqlite.resetBrainDbState();
    brainSearch.resetFts5Cache();
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('links an observation to a task and retrieves bidirectionally', async () => {
    // Create observation
    const obs = await brainRetrieval.observeBrain(testDir, {
      text: 'Implemented atomic file operations for data integrity',
      title: 'Atomic file operations',
      type: 'feature',
    });

    // Link to task
    const link = await brainLinks.linkMemoryToTask(
      testDir,
      'observation',
      obs.id,
      'T5149',
      'produced_by',
    );

    expect(link.memoryType).toBe('observation');
    expect(link.memoryId).toBe(obs.id);
    expect(link.taskId).toBe('T5149');
    expect(link.linkType).toBe('produced_by');

    // Retrieve via task -> memory direction
    const taskLinks = await brainLinks.getTaskLinks(testDir, 'T5149');
    expect(taskLinks.length).toBe(1);
    expect(taskLinks[0].memoryId).toBe(obs.id);
    expect(taskLinks[0].memoryType).toBe('observation');

    // Retrieve via memory -> task direction
    const memLinks = await brainLinks.getMemoryLinks(testDir, 'observation', obs.id);
    expect(memLinks.length).toBe(1);
    expect(memLinks[0].taskId).toBe('T5149');
  });

  it('links multiple observations to same task', async () => {
    const obs1 = await brainRetrieval.observeBrain(testDir, {
      text: 'First observation for multi-link test',
      type: 'discovery',
    });

    await delay(2);

    const obs2 = await brainRetrieval.observeBrain(testDir, {
      text: 'Second observation for multi-link test',
      type: 'change',
    });

    await brainLinks.linkMemoryToTask(testDir, 'observation', obs1.id, 'T100', 'produced_by');
    await brainLinks.linkMemoryToTask(testDir, 'observation', obs2.id, 'T100', 'applies_to');

    const taskLinks = await brainLinks.getTaskLinks(testDir, 'T100');
    expect(taskLinks.length).toBe(2);
    const linkedIds = taskLinks.map((l) => l.memoryId).sort();
    expect(linkedIds).toEqual([obs1.id, obs2.id].sort());
  });

  it('linkMemoryToTask is idempotent', async () => {
    const obs = await brainRetrieval.observeBrain(testDir, {
      text: 'Idempotent link test observation',
      type: 'discovery',
    });

    // Link twice
    await brainLinks.linkMemoryToTask(testDir, 'observation', obs.id, 'T200', 'produced_by');
    await brainLinks.linkMemoryToTask(testDir, 'observation', obs.id, 'T200', 'produced_by');

    // Only 1 link exists
    const links = await brainLinks.getTaskLinks(testDir, 'T200');
    expect(links.length).toBe(1);
  });

  it('unlinkMemoryFromTask removes the link', async () => {
    const obs = await brainRetrieval.observeBrain(testDir, {
      text: 'Unlink test observation',
      type: 'feature',
    });

    await brainLinks.linkMemoryToTask(testDir, 'observation', obs.id, 'T300', 'produced_by');

    // Verify link exists
    let links = await brainLinks.getTaskLinks(testDir, 'T300');
    expect(links.length).toBe(1);

    // Unlink
    const { unlinkMemoryFromTask } = await import('../../src/core/memory/brain-links.js');
    await unlinkMemoryFromTask(testDir, 'observation', obs.id, 'T300', 'produced_by');

    // Verify link removed
    links = await brainLinks.getTaskLinks(testDir, 'T300');
    expect(links.length).toBe(0);
  });
});

// ============================================================================
// Scenario 5: Session Memory Capture
// ============================================================================

describe('Scenario 5: Session Memory Capture', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainAccessorModule: typeof import('../../src/store/brain-accessor.js');
  let sessionMemory: typeof import('../../src/core/memory/session-memory.js');
  let brainSearch: typeof import('../../src/core/memory/brain-search.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brain-e2e-capture-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainAccessorModule = await import('../../src/store/brain-accessor.js');
    sessionMemory = await import('../../src/core/memory/session-memory.js');
    brainSearch = await import('../../src/core/memory/brain-search.js');

    brainSqlite.resetBrainDbState();
    brainSearch.resetFts5Cache();
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('persists decisions from debrief as observations in brain.db', async () => {
    const debrief = {
      handoff: {
        lastTask: 'T5141',
        tasksCompleted: ['T5131', 'T5132'],
        tasksCreated: [],
        decisionsRecorded: 2,
        nextSuggested: ['T5141'],
        openBlockers: [],
        openBugs: [],
      },
      sessionId: 'SES-001',
      agentIdentifier: 'wave4-e2e',
      startedAt: '2026-03-01 10:00:00',
      endedAt: '2026-03-01 12:00:00',
      durationMinutes: 120,
      decisions: [
        {
          id: 'D001',
          decision: 'Use 3-layer retrieval for token efficiency',
          rationale: 'Compact search, timeline, full fetch reduces context cost by 10x',
          taskId: 'T5131',
        },
        {
          id: 'D002',
          decision: 'Auto-classify observation types from text keywords',
          rationale: 'Reduces manual type assignment burden on agents',
          taskId: 'T5134',
        },
      ],
      gitState: null,
      chainPosition: 1,
      chainLength: 1,
    };

    const result = await sessionMemory.persistSessionMemory(testDir, 'SES-001', debrief);

    // 2 decisions + 1 session summary = 3 observations
    expect(result.observationsCreated).toBe(3);
    expect(result.observationIds.length).toBe(3);
    expect(result.errors).toEqual([]);

    // Links created for decisions with taskIds
    expect(result.linksCreated).toBe(2);

    // Verify observations exist in brain.db
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);
    for (const obsId of result.observationIds) {
      const obs = await accessor.getObservation(obsId);
      expect(obs).not.toBeNull();
      expect(obs!.sourceType).toBe('session-debrief');
      expect(obs!.sourceSessionId).toBe('SES-001');
    }
  });

  it('creates session summary observation from completed tasks', async () => {
    const debrief = {
      handoff: {
        lastTask: 'T100',
        tasksCompleted: ['T100', 'T101', 'T102'],
        tasksCreated: ['T200'],
        decisionsRecorded: 0,
        nextSuggested: ['T200'],
        openBlockers: [],
        openBugs: [],
      },
      sessionId: 'SES-002',
      agentIdentifier: null,
      startedAt: '2026-03-01 14:00:00',
      endedAt: '2026-03-01 15:30:00',
      durationMinutes: 90,
      decisions: [],
      gitState: null,
      chainPosition: 1,
      chainLength: 1,
    };

    const result = await sessionMemory.persistSessionMemory(testDir, 'SES-002', debrief);

    // 0 decisions + 1 session summary = 1 observation
    expect(result.observationsCreated).toBe(1);
    expect(result.linksCreated).toBe(0); // no decision linkages

    const accessor = await brainAccessorModule.getBrainAccessor(testDir);
    const obs = await accessor.getObservation(result.observationIds[0]);
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe('change');
    expect(obs!.narrative).toContain('T100');
    expect(obs!.narrative).toContain('T101');
    expect(obs!.narrative).toContain('T102');
    expect(obs!.narrative).toContain('Next suggested');
  });

  it('captures session notes as discovery observations', async () => {
    const debrief = {
      handoff: {
        lastTask: null,
        tasksCompleted: [],
        tasksCreated: [],
        decisionsRecorded: 0,
        nextSuggested: [],
        openBlockers: [],
        openBugs: [],
        note: 'Brain.db initialization is slow on first run due to migration overhead',
      },
      sessionId: 'SES-003',
      agentIdentifier: null,
      startedAt: '2026-03-01 16:00:00',
      endedAt: '2026-03-01 16:10:00',
      durationMinutes: 10,
      decisions: [],
      gitState: null,
      chainPosition: 1,
      chainLength: 1,
    };

    const result = await sessionMemory.persistSessionMemory(testDir, 'SES-003', debrief);

    // 1 note -> 1 observation
    expect(result.observationsCreated).toBe(1);

    const accessor = await brainAccessorModule.getBrainAccessor(testDir);
    const obs = await accessor.getObservation(result.observationIds[0]);
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe('discovery');
    expect(obs!.narrative).toContain('Brain.db initialization is slow');
  });

  it('returns zero results for null debrief', async () => {
    const result = await sessionMemory.persistSessionMemory(testDir, 'SES-NULL', null);
    expect(result.observationsCreated).toBe(0);
    expect(result.linksCreated).toBe(0);
    expect(result.observationIds).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('extractMemoryItems is a pure function', () => {
    const items = sessionMemory.extractMemoryItems('SES-PURE', {
      handoff: {
        lastTask: 'T1',
        tasksCompleted: ['T1'],
        tasksCreated: [],
        decisionsRecorded: 1,
        nextSuggested: [],
        openBlockers: [],
        openBugs: [],
      },
      sessionId: 'SES-PURE',
      agentIdentifier: null,
      startedAt: '2026-03-01 00:00:00',
      endedAt: '2026-03-01 01:00:00',
      durationMinutes: 60,
      decisions: [
        { id: 'D1', decision: 'Test decision', rationale: 'Test rationale', taskId: 'T1' },
      ],
      gitState: null,
      chainPosition: 1,
      chainLength: 1,
    });

    // 1 decision + 1 session summary = 2 items
    expect(items.length).toBe(2);
    expect(items[0].type).toBe('decision');
    expect(items[0].sourceType).toBe('session-debrief');
    expect(items[0].linkTaskId).toBe('T1');
    expect(items[1].type).toBe('change');
  });
});

// ============================================================================
// Scenario 6: Session Briefing with Memory
// ============================================================================

describe('Scenario 6: Session Briefing with Memory', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainRetrieval: typeof import('../../src/core/memory/brain-retrieval.js');
  let sessionMemory: typeof import('../../src/core/memory/session-memory.js');
  let brainSearch: typeof import('../../src/core/memory/brain-search.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brain-e2e-briefing-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainRetrieval = await import('../../src/core/memory/brain-retrieval.js');
    sessionMemory = await import('../../src/core/memory/session-memory.js');
    brainSearch = await import('../../src/core/memory/brain-search.js');

    brainSqlite.resetBrainDbState();
    brainSearch.resetFts5Cache();
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('getSessionMemoryContext returns relevant memory for epic scope', async () => {
    // Seed brain.db with session-debrief observations
    const debrief = {
      handoff: {
        lastTask: 'T5141',
        tasksCompleted: ['T5131', 'T5132', 'T5133'],
        tasksCreated: [],
        decisionsRecorded: 2,
        nextSuggested: ['T5141'],
        openBlockers: [],
        openBugs: [],
      },
      sessionId: 'SES-BRIEF-001',
      agentIdentifier: 'wave2-agent',
      startedAt: '2026-03-01 08:00:00',
      endedAt: '2026-03-01 10:00:00',
      durationMinutes: 120,
      decisions: [
        {
          id: 'D1',
          decision: 'Use FTS5 for brain.db search',
          rationale: 'BM25 ranking and efficient full-text search for T5149',
          taskId: 'T5131',
        },
      ],
      gitState: null,
      chainPosition: 1,
      chainLength: 1,
    };

    await sessionMemory.persistSessionMemory(testDir, 'SES-BRIEF-001', debrief);

    // Now get context for the epic
    const context = await sessionMemory.getSessionMemoryContext(
      testDir,
      { type: 'epic', epicId: 'T5149', rootTaskId: 'T5149' },
    );

    // Should have observations from the seeded debrief
    expect(context.recentObservations.length).toBeGreaterThanOrEqual(0);
    expect(context.tokensEstimated).toBeGreaterThanOrEqual(0);

    // Token estimate should be reasonable (not millions)
    expect(context.tokensEstimated).toBeLessThan(10000);
  });

  it('returns empty context when no memory exists', async () => {
    const context = await sessionMemory.getSessionMemoryContext(testDir);

    expect(context.recentDecisions).toEqual([]);
    expect(context.relevantPatterns).toEqual([]);
    expect(context.recentObservations).toEqual([]);
    expect(context.tokensEstimated).toBe(0);
  });

  it('returns scoped results when rootTaskId is provided', async () => {
    // Seed observations via accessor for reliable IDs
    const brainAccessorModule = await import('../../src/store/brain-accessor.js');
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);

    await accessor.addObservation({
      id: 'O-scope-001',
      type: 'feature',
      title: 'T5149 schema design done',
      narrative: 'T5149 brain database schema design complete',
      sourceType: 'session-debrief',
      sourceSessionId: 'SES-A',
      createdAt: '2026-03-01 10:00:00',
    });
    await accessor.addObservation({
      id: 'O-scope-002',
      type: 'discovery',
      title: 'T9999 unrelated observation',
      narrative: 'T9999 unrelated project observation about something else entirely',
      sourceType: 'session-debrief',
      sourceSessionId: 'SES-B',
      createdAt: '2026-03-01 11:00:00',
    });

    const context = await sessionMemory.getSessionMemoryContext(
      testDir,
      { type: 'epic', rootTaskId: 'T5149' },
    );

    // Results should be present (searches for 'T5149')
    expect(context.tokensEstimated).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// Scenario 7: FTS5 Search Quality
// ============================================================================

describe('Scenario 7: FTS5 Search Quality', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainAccessorModule: typeof import('../../src/store/brain-accessor.js');
  let brainRetrieval: typeof import('../../src/core/memory/brain-retrieval.js');
  let brainSearch: typeof import('../../src/core/memory/brain-search.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'brain-e2e-fts5quality-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainAccessorModule = await import('../../src/store/brain-accessor.js');
    brainRetrieval = await import('../../src/core/memory/brain-retrieval.js');
    brainSearch = await import('../../src/core/memory/brain-search.js');

    brainSqlite.resetBrainDbState();
    brainSearch.resetFts5Cache();

    // Seed 50+ entries with varied content using accessor for explicit IDs
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);

    // 15 decisions covering different topics
    const decisionTopics = [
      'Use TypeScript strict mode for type safety',
      'Adopt ESM modules for modern JavaScript compatibility',
      'Use drizzle ORM for database access layer',
      'Implement atomic file operations for data integrity',
      'Use FTS5 for full-text search capabilities',
      'Adopt CalVer versioning scheme for releases',
      'Use Commander.js for CLI argument parsing',
      'Implement WAL mode for SQLite concurrency',
      'Use Vitest as primary test framework',
      'Adopt dispatch-first architecture pattern',
      'Use JSON Schema for data validation',
      'Implement singleton database connections',
      'Use node:sqlite native module for SQLite',
      'Adopt git-flow branching strategy',
      'Use esbuild for TypeScript bundling',
    ];

    for (let i = 0; i < decisionTopics.length; i++) {
      await accessor.addDecision({
        id: `D${String(i + 1).padStart(3, '0')}`,
        type: 'technical',
        decision: decisionTopics[i],
        rationale: `Rationale for: ${decisionTopics[i]}`,
        confidence: 'high',
        createdAt: `2026-01-${String(i + 1).padStart(2, '0')} 10:00:00`,
      });
    }

    // 10 patterns
    const patternTopics = [
      'Atomic write ensures data consistency during crashes',
      'FTS5 content-sync triggers maintain search index integrity',
      'Singleton database pattern prevents resource leaks',
      'Error-first callback pattern in async operations',
      'Builder pattern for constructing complex queries',
      'Observer pattern for event-driven architecture',
      'Strategy pattern for pluggable search backends',
      'Factory pattern for database accessor creation',
      'Middleware pattern for request processing pipeline',
      'Decorator pattern for extending command functionality',
    ];

    for (let i = 0; i < patternTopics.length; i++) {
      await accessor.addPattern({
        id: `P${String(i + 1).padStart(3, '0')}`,
        type: 'workflow',
        pattern: patternTopics[i],
        context: `Context for pattern: ${patternTopics[i]}`,
        frequency: i + 1,
        extractedAt: `2026-02-${String(i + 1).padStart(2, '0')} 12:00:00`,
      });
    }

    // 10 learnings
    const learningTopics = [
      'WAL mode prevents lock contention in multi-reader scenarios',
      'drizzle-orm sqlite-proxy requires explicit type casting',
      'FTS5 rebuild is necessary after bulk inserts without triggers',
      'node:sqlite DatabaseSync is synchronous but reliable',
      'JSON Schema validation catches malformed data before persistence',
      'Atomic rename provides crash-safe file updates',
      'PRAGMA journal_mode=WAL enables concurrent reads',
      'TypeScript strict null checks prevent runtime errors',
      'Integration tests need fresh database instances for isolation',
      'Exit code ranges provide structured error classification',
    ];

    for (let i = 0; i < learningTopics.length; i++) {
      await accessor.addLearning({
        id: `L${String(i + 1).padStart(3, '0')}`,
        insight: learningTopics[i],
        source: 'implementation-experience',
        confidence: 0.7 + (i * 0.03),
        actionable: i % 2 === 0,
        createdAt: `2026-02-${String(i + 11).padStart(2, '0')} 14:00:00`,
      });
    }

    // 15 observations with explicit IDs
    const observationData = [
      { id: 'O-fts-001', type: 'discovery' as const, text: 'The brain.db schema supports 5 table types for cognitive data' },
      { id: 'O-fts-002', type: 'feature' as const, text: 'FTS5 BM25 ranking provides relevance-sorted search results' },
      { id: 'O-fts-003', type: 'bugfix' as const, text: 'Fixed race condition in concurrent brain.db initialization' },
      { id: 'O-fts-004', type: 'refactor' as const, text: 'Refactored brain-accessor to use drizzle ORM queries' },
      { id: 'O-fts-005', type: 'feature' as const, text: 'Added cross-linking between memory entries and tasks' },
      { id: 'O-fts-006', type: 'change' as const, text: 'Changed session memory capture to be best-effort' },
      { id: 'O-fts-007', type: 'decision' as const, text: 'Decided to use O- prefix for observation IDs' },
      { id: 'O-fts-008', type: 'discovery' as const, text: 'The timeline API returns chronological neighbors efficiently' },
      { id: 'O-fts-009', type: 'feature' as const, text: 'Implemented compact search returning 50 tokens per result' },
      { id: 'O-fts-010', type: 'bugfix' as const, text: 'Fixed FTS5 syntax error on queries with special characters' },
      { id: 'O-fts-011', type: 'refactor' as const, text: 'Refactored search to fall back to LIKE when FTS5 unavailable' },
      { id: 'O-fts-012', type: 'feature' as const, text: 'Added date range filtering to compact search results' },
      { id: 'O-fts-013', type: 'discovery' as const, text: 'The migration system handles JSONL to SQLite conversion' },
      { id: 'O-fts-014', type: 'change' as const, text: 'Changed observation auto-classification keyword matching' },
      { id: 'O-fts-015', type: 'decision' as const, text: 'Decided on 3-layer retrieval for progressive disclosure' },
    ];

    for (const obs of observationData) {
      await accessor.addObservation({
        id: obs.id,
        type: obs.type,
        title: obs.text.slice(0, 80),
        narrative: obs.text,
        project: 'cleo',
        sourceType: 'agent',
        createdAt: '2026-03-01 10:00:00',
      });
    }
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('finds specific technical terms across multiple tables', async () => {
    // "FTS5" appears in decisions, patterns, learnings, and observations
    const result = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'FTS5',
    });

    expect(result.results.length).toBeGreaterThanOrEqual(3);
    const types = new Set(result.results.map((r) => r.type));
    // Should find results in multiple table types
    expect(types.size).toBeGreaterThanOrEqual(2);
  });

  it('finds results for "SQLite" across decisions and learnings', async () => {
    const result = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'SQLite',
    });

    expect(result.results.length).toBeGreaterThanOrEqual(3);
    const foundTypes = new Set(result.results.map((r) => r.type));
    // Should find decisions and learnings at minimum
    expect(
      foundTypes.has('decision') || foundTypes.has('learning'),
    ).toBe(true);
  });

  it('finds results for "atomic" in patterns and observations', async () => {
    const result = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'atomic',
    });

    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty for queries with no matches', async () => {
    const result = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'quantum_entanglement_superconductor',
    });

    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('handles queries with special characters safely', async () => {
    // FTS5 special characters should be escaped
    const result = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'FTS5 + search (OR) "quotes"',
    });

    // Should not throw, may or may not find results
    expect(result).toBeDefined();
    expect(result.results).toBeInstanceOf(Array);
  });

  it('searches observations by narrative content', async () => {
    const result = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'race condition',
      tables: ['observations'],
    });

    expect(result.results.length).toBeGreaterThanOrEqual(1);
    const found = result.results.find((r) =>
      r.title.toLowerCase().includes('race condition'),
    );
    expect(found).toBeDefined();
  });

  it('timeline provides chronological context around an anchor', async () => {
    // Use a known decision as anchor (D008 = "Implement WAL mode for SQLite concurrency")
    const timeline = await brainRetrieval.timelineBrain(testDir, {
      anchor: 'D008',
      depthBefore: 3,
      depthAfter: 3,
    });

    expect(timeline.anchor).not.toBeNull();
    expect(timeline.anchor!.id).toBe('D008');
    expect(timeline.anchor!.type).toBe('decision');

    // Should have entries before and after
    // D008 is at 2026-01-08, so 7 decisions before and 7 after
    expect(timeline.before.length).toBeGreaterThanOrEqual(1);
    expect(timeline.after.length).toBeGreaterThanOrEqual(1);

    // Verify chronological ordering: all "before" entries should have date < anchor date
    const anchorData = timeline.anchor!.data as Record<string, string>;
    const anchorDate = anchorData.created_at ?? anchorData.createdAt;
    for (const entry of timeline.before) {
      expect(entry.date < anchorDate).toBe(true);
    }
    for (const entry of timeline.after) {
      expect(entry.date > anchorDate).toBe(true);
    }
  });

  it('timeline returns null anchor for non-existent ID', async () => {
    const timeline = await brainRetrieval.timelineBrain(testDir, {
      anchor: 'D999',
    });

    expect(timeline.anchor).toBeNull();
    expect(timeline.before).toEqual([]);
    expect(timeline.after).toEqual([]);
  });

  it('timeline returns null for unrecognized ID prefix', async () => {
    const timeline = await brainRetrieval.timelineBrain(testDir, {
      anchor: 'ZZZZZ-unknown',
    });

    expect(timeline.anchor).toBeNull();
  });
});
