/**
 * Memory Domain — Legacy Operation Name Rejection (Regression Tests)
 *
 * Verifies that OLD operation names that were renamed or moved during
 * the T5241 memory domain cutover now return E_INVALID_OPERATION from
 * the MemoryHandler. This prevents agents using stale operation names
 * from silently succeeding.
 *
 * @task T5241
 * @epic T5149
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock engine-compat brain.db functions (required by import)
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
}));

// Mock pipeline-manifest-sqlite functions (required by import)
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

describe('MemoryHandler legacy operation rejection', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new MemoryHandler();
  });

  // =========================================================================
  // Old brain.* query names (renamed to flat ops: find, timeline, fetch)
  // =========================================================================

  describe('old brain.* query names → E_INVALID_OPERATION', () => {
    it('should reject brain.search (renamed to find)', async () => {
      const result = await handler.query('brain.search', { query: 'test' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should reject brain.timeline (renamed to timeline)', async () => {
      const result = await handler.query('brain.timeline', { anchor: 'D001' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should reject brain.fetch (renamed to fetch)', async () => {
      const result = await handler.query('brain.fetch', { ids: ['D001'] });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  // =========================================================================
  // Old brain.observe mutate name (renamed to observe)
  // =========================================================================

  describe('old brain.observe mutate name → E_INVALID_OPERATION', () => {
    it('should reject brain.observe (renamed to observe)', async () => {
      const result = await handler.mutate('brain.observe', { text: 'test' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  // =========================================================================
  // Old pattern.search / learning.search names (renamed to pattern.find / learning.find)
  // =========================================================================

  describe('old *.search names → E_INVALID_OPERATION', () => {
    it('should reject pattern.search (renamed to pattern.find)', async () => {
      const result = await handler.query('pattern.search', { type: 'workflow' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should reject learning.search (renamed to learning.find)', async () => {
      const result = await handler.query('learning.search', { query: 'test' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  // =========================================================================
  // Old manifest.* names (moved to pipeline domain)
  // =========================================================================

  describe('old manifest.* names → E_INVALID_OPERATION', () => {
    it('should reject manifest.read (moved to pipeline.manifest.list)', async () => {
      const result = await handler.query('manifest.read', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should reject manifest.append (moved to pipeline.manifest.append)', async () => {
      const result = await handler.mutate('manifest.append', { entry: {} });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should reject manifest.archive (moved to pipeline.manifest.archive)', async () => {
      const result = await handler.mutate('manifest.archive', { beforeDate: '2026-01-01' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  // =========================================================================
  // Old inject name (moved to session.context.inject)
  // =========================================================================

  describe('old inject name → E_INVALID_OPERATION', () => {
    it('should reject inject (moved to session.context.inject)', async () => {
      const result = await handler.mutate('inject', { protocolType: 'research' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  // =========================================================================
  // Old list and pending names (renamed/restructured)
  // =========================================================================

  describe('old list/pending names → E_INVALID_OPERATION', () => {
    it('should reject list (no longer in memory domain)', async () => {
      const result = await handler.query('list', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should reject pending (no longer in memory domain)', async () => {
      const result = await handler.query('pending', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  // =========================================================================
  // Verify the error message mentions the operation name
  // =========================================================================

  describe('error messages', () => {
    it('should include the rejected operation name in error message', async () => {
      const result = await handler.query('brain.search', { query: 'test' });
      expect(result.error?.message).toContain('brain.search');
    });

    it('should include the rejected mutate operation name in error message', async () => {
      const result = await handler.mutate('inject', { protocolType: 'test' });
      expect(result.error?.message).toContain('inject');
    });
  });
});
