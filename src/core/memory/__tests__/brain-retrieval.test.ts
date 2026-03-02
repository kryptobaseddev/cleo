/**
 * Tests for BRAIN retrieval operations — 3-layer pattern.
 *
 * Tests: searchBrainCompact, timelineBrain, fetchBrainEntries, observeBrain.
 *
 * @task T5131 T5132 T5133 T5134 T5135
 * @epic T5149
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
let cleoDir: string;

describe('Brain Retrieval', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-retrieval-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    const { resetFts5Cache } = await import('../brain-search.js');
    closeBrainDb();
    resetFts5Cache();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // searchBrainCompact
  // ==========================================================================

  describe('searchBrainCompact', () => {
    it('should return empty results for empty query', async () => {
      const { searchBrainCompact } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      const longDecision = 'This is a very long decision about truncation testing that exceeds eighty characters and should be properly truncated in compact results';
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
  });

  // ==========================================================================
  // timelineBrain
  // ==========================================================================

  describe('timelineBrain', () => {
    it('should return null anchor for unknown ID', async () => {
      const { timelineBrain } = await import('../brain-retrieval.js');
      const { closeBrainDb, getBrainDb } = await import('../../../store/brain-sqlite.js');
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
      const { closeBrainDb, getBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();
      await getBrainDb(tempDir);

      const result = await timelineBrain(tempDir, { anchor: 'UNKNOWN-123' });
      expect(result.anchor).toBeNull();
    });

    it('should return anchor data for a decision', async () => {
      const { timelineBrain } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
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
      const { closeBrainDb, getBrainDb } = await import('../../../store/brain-sqlite.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      // Need to init DB first
      const { getBrainDb } = await import('../../../store/brain-sqlite.js');
      await getBrainDb(tempDir);

      await expect(
        observeBrain(tempDir, { text: '' }),
      ).rejects.toThrow('Observation text is required');

      await expect(
        observeBrain(tempDir, { text: '   ' }),
      ).rejects.toThrow('Observation text is required');
    });

    it('should store observation searchable via searchBrainCompact', async () => {
      const { observeBrain, searchBrainCompact } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
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
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
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
  // Integration: search -> timeline -> fetch
  // ==========================================================================

  describe('3-layer integration', () => {
    it('should flow: search -> timeline -> fetch', async () => {
      const { searchBrainCompact, timelineBrain, fetchBrainEntries } = await import('../brain-retrieval.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { resetFts5Cache } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
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
