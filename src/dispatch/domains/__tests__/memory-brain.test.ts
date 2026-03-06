/**
 * Memory Domain — Brain.db Backed Operations (Post-Cutover)
 *
 * Tests that the MemoryHandler correctly delegates to brain.db-backed
 * engine functions for all new memory domain operations after T5241 cutover.
 *
 * @task T5241
 * @epic T5149
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock engine-compat brain.db functions
vi.mock('../../../core/memory/engine-compat.js', () => ({
  memoryShow: vi.fn(),
  memoryFind: vi.fn(),
  memoryTimeline: vi.fn(),
  memoryFetch: vi.fn(),
  memoryObserve: vi.fn(),
  memoryBrainStats: vi.fn(),
  memoryDecisionFind: vi.fn(),
  memoryDecisionStore: vi.fn(),
  memoryPatternFind: vi.fn(),
  memoryPatternStore: vi.fn(),
  memoryPatternStats: vi.fn(),
  memoryLearningFind: vi.fn(),
  memoryLearningStore: vi.fn(),
  memoryLearningStats: vi.fn(),
  memoryContradictions: vi.fn(),
  memorySuperseded: vi.fn(),
  memoryLink: vi.fn(),
}));

// Mock pipeline-manifest-sqlite functions used by memory handler
vi.mock('../../../core/memory/pipeline-manifest-sqlite.js', () => ({
  pipelineManifestContradictions: vi.fn(),
  pipelineManifestSuperseded: vi.fn(),
  pipelineManifestLink: vi.fn(),
}));

// Mock getProjectRoot
vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

import { MemoryHandler } from '../memory.js';
import {
  memoryShow,
  memoryFind,
  memoryTimeline,
  memoryFetch,
  memoryObserve,
  memoryBrainStats,
  memoryDecisionFind,
  memoryDecisionStore,
  memoryPatternFind,
  memoryPatternStore,
  memoryPatternStats,
  memoryLearningFind,
  memoryLearningStore,
  memoryLearningStats,
  memoryContradictions,
  memorySuperseded,
  memoryLink,
} from '../../../core/memory/engine-compat.js';

describe('MemoryHandler (brain.db backed)', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new MemoryHandler();
  });

  // =========================================================================
  // getSupportedOperations
  // =========================================================================

  describe('getSupportedOperations', () => {
    it('should list all query operations', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.query).toContain('show');
      expect(ops.query).toContain('find');
      expect(ops.query).toContain('timeline');
      expect(ops.query).toContain('fetch');
      expect(ops.query).toContain('stats');
      expect(ops.query).toContain('contradictions');
      expect(ops.query).toContain('superseded');
      expect(ops.query).toContain('decision.find');
      expect(ops.query).toContain('pattern.find');
      expect(ops.query).toContain('pattern.stats');
      expect(ops.query).toContain('learning.find');
      expect(ops.query).toContain('learning.stats');
    });

    it('should list all mutate operations', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.mutate).toContain('observe');
      expect(ops.mutate).toContain('decision.store');
      expect(ops.mutate).toContain('pattern.store');
      expect(ops.mutate).toContain('learning.store');
      expect(ops.mutate).toContain('link');
    });

    it('should NOT list old operation names in query ops', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.query).not.toContain('brain.search');
      expect(ops.query).not.toContain('brain.timeline');
      expect(ops.query).not.toContain('brain.fetch');
      expect(ops.query).not.toContain('manifest.read');
      expect(ops.query).not.toContain('list');
      expect(ops.query).not.toContain('pending');
      expect(ops.query).not.toContain('pattern.search');
      expect(ops.query).not.toContain('learning.search');
    });

    it('should NOT list old operation names in mutate ops', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.mutate).not.toContain('brain.observe');
      expect(ops.mutate).not.toContain('inject');
      expect(ops.mutate).not.toContain('manifest.append');
      expect(ops.mutate).not.toContain('manifest.archive');
    });
  });

  // =========================================================================
  // Query: memory.show
  // =========================================================================

  describe('query: show', () => {
    it('should return brain.db entry by ID', async () => {
      vi.mocked(memoryShow).mockResolvedValue({
        success: true,
        data: { type: 'decision', entry: { id: 'D001', decision: 'Use SQLite' } },
      });

      const result = await handler.query('show', { entryId: 'D001' });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ type: 'decision', entry: { id: 'D001', decision: 'Use SQLite' } });
      expect(memoryShow).toHaveBeenCalledWith('D001', '/mock/project');
    });

    it('should return E_INVALID_INPUT when entryId is missing', async () => {
      const result = await handler.query('show', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('entryId');
    });

    it('should propagate E_NOT_FOUND from engine', async () => {
      vi.mocked(memoryShow).mockResolvedValue({
        success: false,
        error: { code: 'E_NOT_FOUND', message: "Decision 'D999' not found in brain.db" },
      });

      const result = await handler.query('show', { entryId: 'D999' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  // =========================================================================
  // Query: memory.find
  // =========================================================================

  describe('query: find', () => {
    it('should return brain.db FTS5 search results', async () => {
      vi.mocked(memoryFind).mockResolvedValue({
        success: true,
        data: { results: [{ id: 'D001', type: 'decision', title: 'Test', date: '2026-03-01' }], total: 1, tokensEstimated: 50 },
      });

      const result = await handler.query('find', { query: 'test search' });
      expect(result.success).toBe(true);
      expect((result.data as { total: number }).total).toBe(1);
      expect(memoryFind).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'test search' }),
        '/mock/project',
      );
    });

    it('should pass optional filter params', async () => {
      vi.mocked(memoryFind).mockResolvedValue({ success: true, data: { results: [], total: 0, tokensEstimated: 0 } });

      await handler.query('find', {
        query: 'auth',
        limit: 5,
        tables: ['decisions', 'patterns'],
        dateStart: '2026-01-01',
        dateEnd: '2026-12-31',
      });

      expect(memoryFind).toHaveBeenCalledWith(
        {
          query: 'auth',
          limit: 5,
          tables: ['decisions', 'patterns'],
          dateStart: '2026-01-01',
          dateEnd: '2026-12-31',
        },
        '/mock/project',
      );
    });

    it('should return E_INVALID_INPUT when query is missing', async () => {
      const result = await handler.query('find', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('query');
    });
  });

  // =========================================================================
  // Query: memory.timeline
  // =========================================================================

  describe('query: timeline', () => {
    it('should return chronological context around anchor', async () => {
      vi.mocked(memoryTimeline).mockResolvedValue({
        success: true,
        data: {
          anchor: { id: 'D001', type: 'decision', data: {} },
          before: [{ id: 'P001', type: 'pattern' }],
          after: [{ id: 'L001', type: 'learning' }],
        },
      });

      const result = await handler.query('timeline', { anchor: 'D001' });
      expect(result.success).toBe(true);
      expect(memoryTimeline).toHaveBeenCalledWith(
        expect.objectContaining({ anchor: 'D001' }),
        '/mock/project',
      );
    });

    it('should pass depth params', async () => {
      vi.mocked(memoryTimeline).mockResolvedValue({
        success: true,
        data: { anchor: null, before: [], after: [] },
      });

      await handler.query('timeline', { anchor: 'D001', depthBefore: 3, depthAfter: 2 });
      expect(memoryTimeline).toHaveBeenCalledWith(
        { anchor: 'D001', depthBefore: 3, depthAfter: 2 },
        '/mock/project',
      );
    });

    it('should return E_INVALID_INPUT when anchor is missing', async () => {
      const result = await handler.query('timeline', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('anchor');
    });
  });

  // =========================================================================
  // Query: memory.fetch
  // =========================================================================

  describe('query: fetch', () => {
    it('should return batch brain entries by IDs', async () => {
      vi.mocked(memoryFetch).mockResolvedValue({
        success: true,
        data: {
          results: [
            { id: 'D001', type: 'decision', data: { decision: 'test' } },
            { id: 'P001', type: 'pattern', data: { pattern: 'test' } },
          ],
          notFound: [],
          tokensEstimated: 1000,
        },
      });

      const result = await handler.query('fetch', { ids: ['D001', 'P001'] });
      expect(result.success).toBe(true);
      expect(memoryFetch).toHaveBeenCalledWith({ ids: ['D001', 'P001'] }, '/mock/project');
    });

    it('should return E_INVALID_INPUT when ids is missing', async () => {
      const result = await handler.query('fetch', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('ids');
    });

    it('should return E_INVALID_INPUT when ids is empty array', async () => {
      const result = await handler.query('fetch', { ids: [] });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  // =========================================================================
  // Query: memory.stats
  // =========================================================================

  describe('query: stats', () => {
    it('should return brain.db statistics', async () => {
      vi.mocked(memoryBrainStats).mockResolvedValue({
        success: true,
        data: { observations: 100, decisions: 25, patterns: 10, learnings: 15, total: 150 },
      });

      const result = await handler.query('stats');
      expect(result.success).toBe(true);
      expect((result.data as { total: number }).total).toBe(150);
      expect(memoryBrainStats).toHaveBeenCalledWith('/mock/project');
    });
  });

  // =========================================================================
  // Query: memory.decision.find
  // =========================================================================

  describe('query: decision.find', () => {
    it('should search decisions in brain.db', async () => {
      vi.mocked(memoryDecisionFind).mockResolvedValue({
        success: true,
        data: { decisions: [{ id: 'D001', decision: 'Use SQLite' }], total: 1 },
      });

      const result = await handler.query('decision.find', { query: 'SQLite' });
      expect(result.success).toBe(true);
      expect(memoryDecisionFind).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'SQLite' }),
        '/mock/project',
      );
    });

    it('should pass taskId and limit params', async () => {
      vi.mocked(memoryDecisionFind).mockResolvedValue({
        success: true,
        data: { decisions: [], total: 0 },
      });

      await handler.query('decision.find', { taskId: 'T5241', limit: 10 });
      expect(memoryDecisionFind).toHaveBeenCalledWith(
        { query: undefined, taskId: 'T5241', limit: 10 },
        '/mock/project',
      );
    });
  });

  // =========================================================================
  // Query: memory.pattern.find
  // =========================================================================

  describe('query: pattern.find', () => {
    it('should search patterns in brain.db', async () => {
      vi.mocked(memoryPatternFind).mockResolvedValue({
        success: true,
        data: { patterns: [{ id: 'P001', pattern: 'test' }], total: 1 },
      });

      const result = await handler.query('pattern.find', { type: 'workflow' });
      expect(result.success).toBe(true);
      expect(memoryPatternFind).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'workflow' }),
        '/mock/project',
      );
    });
  });

  // =========================================================================
  // Query: memory.pattern.stats
  // =========================================================================

  describe('query: pattern.stats', () => {
    it('should return pattern stats', async () => {
      vi.mocked(memoryPatternStats).mockResolvedValue({
        success: true,
        data: { total: 5, byType: { workflow: 3, optimization: 2 } },
      });

      const result = await handler.query('pattern.stats');
      expect(result.success).toBe(true);
      expect(memoryPatternStats).toHaveBeenCalledWith('/mock/project');
    });
  });

  // =========================================================================
  // Query: memory.learning.find
  // =========================================================================

  describe('query: learning.find', () => {
    it('should search learnings in brain.db', async () => {
      vi.mocked(memoryLearningFind).mockResolvedValue({
        success: true,
        data: { learnings: [{ id: 'L001', insight: 'test' }], total: 1 },
      });

      const result = await handler.query('learning.find', { query: 'test', actionableOnly: true });
      expect(result.success).toBe(true);
      expect(memoryLearningFind).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'test', actionableOnly: true }),
        '/mock/project',
      );
    });
  });

  // =========================================================================
  // Query: memory.learning.stats
  // =========================================================================

  describe('query: learning.stats', () => {
    it('should return learning stats', async () => {
      vi.mocked(memoryLearningStats).mockResolvedValue({
        success: true,
        data: { total: 8 },
      });

      const result = await handler.query('learning.stats');
      expect(result.success).toBe(true);
      expect(memoryLearningStats).toHaveBeenCalledWith('/mock/project');
    });
  });

  // =========================================================================
  // Query: memory.contradictions / memory.superseded (still in memory domain)
  // =========================================================================

  describe('query: contradictions', () => {
    it('should return brain.db contradictions', async () => {
      vi.mocked(memoryContradictions).mockResolvedValue({
        success: true,
        data: { contradictions: [] },
      });

      const result = await handler.query('contradictions', { topic: 'auth' });
      expect(result.success).toBe(true);
      expect(memoryContradictions).toHaveBeenCalled();
    });
  });

  describe('query: superseded', () => {
    it('should return superseded entries', async () => {
      vi.mocked(memorySuperseded).mockResolvedValue({
        success: true,
        data: { superseded: [], total: 0 },
      });

      const result = await handler.query('superseded');
      expect(result.success).toBe(true);
      expect(memorySuperseded).toHaveBeenCalledWith(
        { type: undefined, project: undefined },
        '/mock/project',
      );
    });

    it('should pass type and project params', async () => {
      vi.mocked(memorySuperseded).mockResolvedValue({
        success: true,
        data: { superseded: [], total: 0 },
      });

      const result = await handler.query('superseded', { type: 'technical', project: 'cleo' });
      expect(result.success).toBe(true);
      expect(memorySuperseded).toHaveBeenCalledWith(
        { type: 'technical', project: 'cleo' },
        '/mock/project',
      );
    });
  });

  // =========================================================================
  // Mutate: memory.observe
  // =========================================================================

  describe('mutate: observe', () => {
    it('should save observation to brain.db', async () => {
      vi.mocked(memoryObserve).mockResolvedValue({
        success: true,
        data: { id: 'O-abc123', type: 'discovery', createdAt: '2026-03-03' },
      });

      const result = await handler.mutate('observe', {
        text: 'Test observation',
        title: 'Test',
        type: 'discovery',
      });

      expect(result.success).toBe(true);
      expect((result.data as { id: string }).id).toBe('O-abc123');
      expect(memoryObserve).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Test observation', title: 'Test', type: 'discovery' }),
        '/mock/project',
      );
    });

    it('should return E_INVALID_INPUT when text is missing', async () => {
      const result = await handler.mutate('observe', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('text');
    });
  });

  // =========================================================================
  // Mutate: memory.decision.store
  // =========================================================================

  describe('mutate: decision.store', () => {
    it('should save decision to brain.db', async () => {
      vi.mocked(memoryDecisionStore).mockResolvedValue({
        success: true,
        data: { id: 'D-xyz', type: 'technical', decision: 'Use TypeScript', createdAt: '2026-03-03' },
      });

      const result = await handler.mutate('decision.store', {
        decision: 'Use TypeScript',
        rationale: 'Type safety',
        alternatives: ['JavaScript'],
        taskId: 'T5241',
      });

      expect(result.success).toBe(true);
      expect(memoryDecisionStore).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'Use TypeScript',
          rationale: 'Type safety',
          alternatives: ['JavaScript'],
          taskId: 'T5241',
        }),
        '/mock/project',
      );
    });

    it('should return E_INVALID_INPUT when decision is missing', async () => {
      const result = await handler.mutate('decision.store', { rationale: 'test' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should return E_INVALID_INPUT when rationale is missing', async () => {
      const result = await handler.mutate('decision.store', { decision: 'test' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  // =========================================================================
  // Mutate: memory.pattern.store
  // =========================================================================

  describe('mutate: pattern.store', () => {
    it('should save pattern to brain.db', async () => {
      vi.mocked(memoryPatternStore).mockResolvedValue({
        success: true,
        data: { id: 'P001', type: 'workflow' },
      });

      const result = await handler.mutate('pattern.store', {
        pattern: 'Search then fetch pattern',
        context: 'API design',
        type: 'workflow',
      });

      expect(result.success).toBe(true);
      expect(memoryPatternStore).toHaveBeenCalledWith(
        expect.objectContaining({ pattern: 'Search then fetch pattern', context: 'API design' }),
        '/mock/project',
      );
    });

    it('should return E_INVALID_INPUT when pattern is missing', async () => {
      const result = await handler.mutate('pattern.store', { context: 'test' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should return E_INVALID_INPUT when context is missing', async () => {
      const result = await handler.mutate('pattern.store', { pattern: 'test' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  // =========================================================================
  // Mutate: memory.learning.store
  // =========================================================================

  describe('mutate: learning.store', () => {
    it('should save learning to brain.db', async () => {
      vi.mocked(memoryLearningStore).mockResolvedValue({
        success: true,
        data: { id: 'L001', insight: 'Test insight' },
      });

      const result = await handler.mutate('learning.store', {
        insight: 'FTS5 improves search quality',
        source: 'T5241',
        confidence: 0.9,
        actionable: true,
      });

      expect(result.success).toBe(true);
      expect(memoryLearningStore).toHaveBeenCalledWith(
        expect.objectContaining({
          insight: 'FTS5 improves search quality',
          source: 'T5241',
          confidence: 0.9,
          actionable: true,
        }),
        '/mock/project',
      );
    });

    it('should return E_INVALID_INPUT when insight is missing', async () => {
      const result = await handler.mutate('learning.store', { source: 'test' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should return E_INVALID_INPUT when source is missing', async () => {
      const result = await handler.mutate('learning.store', { insight: 'test' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  // =========================================================================
  // Mutate: memory.link
  // =========================================================================

  describe('mutate: link', () => {
    it('should link brain entry to task', async () => {
      vi.mocked(memoryLink).mockResolvedValue({
        success: true,
        data: { taskId: 'T5241', entryId: 'D001', linked: true },
      });

      const result = await handler.mutate('link', { taskId: 'T5241', entryId: 'D001' });
      expect(result.success).toBe(true);
      expect(memoryLink).toHaveBeenCalledWith(
        { taskId: 'T5241', entryId: 'D001' },
        '/mock/project',
      );
    });

    it('should return E_INVALID_INPUT when taskId is missing', async () => {
      const result = await handler.mutate('link', { entryId: 'R001' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should return E_INVALID_INPUT when entryId is missing', async () => {
      const result = await handler.mutate('link', { taskId: 'T5241' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  // =========================================================================
  // Unknown operations return E_INVALID_OPERATION
  // =========================================================================

  describe('unknown operations', () => {
    it('should return E_INVALID_OPERATION for unknown query', async () => {
      const result = await handler.query('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should return E_INVALID_OPERATION for unknown mutate', async () => {
      const result = await handler.mutate('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  // =========================================================================
  // Response metadata
  // =========================================================================

  describe('response metadata', () => {
    it('should include _meta in successful responses', async () => {
      vi.mocked(memoryBrainStats).mockResolvedValue({
        success: true,
        data: { total: 0 },
      });

      const result = await handler.query('stats');
      expect(result._meta).toBeDefined();
      expect(result._meta.domain).toBe('memory');
      expect(result._meta.operation).toBe('stats');
      expect(result._meta.gateway).toBe('query');
      expect(result._meta.timestamp).toBeDefined();
      expect(result._meta.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should include _meta in error responses', async () => {
      const result = await handler.query('show', {});
      expect(result._meta).toBeDefined();
      expect(result._meta.domain).toBe('memory');
      expect(result._meta.operation).toBe('show');
    });
  });
});
