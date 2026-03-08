/**
 * Pipeline Domain — Manifest Operations (Post-Cutover)
 *
 * Tests that the PipelineHandler correctly delegates manifest.* operations
 * through the dispatch/lib/engine.js barrel to pipeline-manifest functions.
 *
 * Updated for T5671: handler imports from dispatch/lib/engine.js, not
 * directly from core/memory/pipeline-manifest-sqlite.js. manifest.pending
 * was removed from the handler.
 *
 * @task T5241
 * @epic T5149
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock engine functions — handler imports everything from dispatch/lib/engine.js
vi.mock('../../lib/engine.js', () => ({
  lifecycleStatus: vi.fn(),
  lifecycleHistory: vi.fn(),
  lifecycleCheck: vi.fn(),
  lifecycleProgress: vi.fn(),
  lifecycleSkip: vi.fn(),
  lifecycleReset: vi.fn(),
  lifecycleGatePass: vi.fn(),
  lifecycleGateFail: vi.fn(),
  releaseRollback: vi.fn(),
  releaseShip: vi.fn(),
  releaseList: vi.fn(),
  releaseShow: vi.fn(),
  releaseCancel: vi.fn(),
  phaseList: vi.fn(),
  phaseShow: vi.fn(),
  phaseSet: vi.fn(),
  phaseStart: vi.fn(),
  phaseComplete: vi.fn(),
  phaseAdvance: vi.fn(),
  phaseRename: vi.fn(),
  phaseDelete: vi.fn(),
  pipelineManifestShow: vi.fn(),
  pipelineManifestList: vi.fn(),
  pipelineManifestFind: vi.fn(),
  pipelineManifestStats: vi.fn(),
  pipelineManifestAppend: vi.fn(),
  pipelineManifestArchive: vi.fn(),
}));

// Mock getProjectRoot
vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

// Mock release channel functions
vi.mock('../../../core/release/channel.js', () => ({
  resolveChannelFromBranch: vi.fn(() => 'stable'),
  channelToDistTag: vi.fn(() => 'latest'),
  describeChannel: vi.fn(() => 'Stable channel'),
}));

// Mock chain-store
vi.mock('../../../core/lifecycle/chain-store.js', () => ({
  showChain: vi.fn(),
  listChains: vi.fn(() => []),
  addChain: vi.fn(),
  createInstance: vi.fn(),
  advanceInstance: vi.fn(),
}));

import { PipelineHandler } from '../pipeline.js';
import {
  pipelineManifestShow,
  pipelineManifestList,
  pipelineManifestFind,
  pipelineManifestStats,
  pipelineManifestAppend,
  pipelineManifestArchive,
} from '../../lib/engine.js';

describe('PipelineHandler manifest operations', () => {
  let handler: PipelineHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new PipelineHandler();
  });

  // =========================================================================
  // getSupportedOperations — manifest subset
  // =========================================================================

  describe('getSupportedOperations (manifest)', () => {
    it('should include manifest query operations', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.query).toContain('manifest.show');
      expect(ops.query).toContain('manifest.list');
      expect(ops.query).toContain('manifest.find');
      expect(ops.query).toContain('manifest.stats');
    });

    it('should include manifest mutate operations', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.mutate).toContain('manifest.append');
      expect(ops.mutate).toContain('manifest.archive');
    });
  });

  // =========================================================================
  // Query: manifest.show
  // =========================================================================

  describe('query: manifest.show', () => {
    it('should return manifest entry by ID', async () => {
      vi.mocked(pipelineManifestShow).mockResolvedValue({
        success: true,
        data: { id: 'R001', title: 'Auth Research', file: '.cleo/research/auth.md', fileExists: true },
      });

      const result = await handler.query('manifest.show', { entryId: 'R001' });
      expect(result.success).toBe(true);
      expect((result.data as { id: string }).id).toBe('R001');
      expect(pipelineManifestShow).toHaveBeenCalledWith('R001', '/mock/project');
    });

    it('should return E_INVALID_INPUT when entryId is missing', async () => {
      const result = await handler.query('manifest.show', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('entryId');
    });
  });

  // =========================================================================
  // Query: manifest.list
  // =========================================================================

  describe('query: manifest.list', () => {
    it('should return manifest entries', async () => {
      vi.mocked(pipelineManifestList).mockResolvedValue({
        success: true,
        data: { entries: [{ id: 'R001' }, { id: 'R002' }], total: 3, filtered: 2 },
        page: { mode: 'offset', limit: 2, offset: 0, hasMore: false, total: 2 },
      });

      const result = await handler.query('manifest.list', {});
      expect(result.success).toBe(true);
      expect((result.data as { total: number }).total).toBe(3);
      expect((result.data as { filtered: number }).filtered).toBe(2);
      expect(result.page).toEqual({ mode: 'offset', limit: 2, offset: 0, hasMore: false, total: 2 });
      expect(pipelineManifestList).toHaveBeenCalled();
    });

    it('should pass filter params', async () => {
      vi.mocked(pipelineManifestList).mockResolvedValue({
        success: true,
        data: { entries: [], total: 0 },
      });

      await handler.query('manifest.list', { type: 'research', status: 'completed' });
      expect(pipelineManifestList).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'research', status: 'completed' }),
        '/mock/project',
      );
    });
  });

  // =========================================================================
  // Query: manifest.find
  // =========================================================================

  describe('query: manifest.find', () => {
    it('should search manifest entries by text', async () => {
      vi.mocked(pipelineManifestFind).mockResolvedValue({
        success: true,
        data: {
          query: 'authentication',
          results: [{ id: 'R001', title: 'Auth Research', relevanceScore: 0.8 }],
          total: 1,
        },
      });

      const result = await handler.query('manifest.find', { query: 'authentication' });
      expect(result.success).toBe(true);
      expect(pipelineManifestFind).toHaveBeenCalledWith(
        'authentication',
        { confidence: undefined, limit: undefined },
        '/mock/project',
      );
    });

    it('should pass confidence and limit params', async () => {
      vi.mocked(pipelineManifestFind).mockResolvedValue({
        success: true,
        data: { query: 'auth', results: [], total: 0 },
      });

      await handler.query('manifest.find', { query: 'auth', confidence: 0.5, limit: 10 });
      expect(pipelineManifestFind).toHaveBeenCalledWith(
        'auth',
        { confidence: 0.5, limit: 10 },
        '/mock/project',
      );
    });

    it('should return E_INVALID_INPUT when query is missing', async () => {
      const result = await handler.query('manifest.find', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('query');
    });
  });

  // =========================================================================
  // Query: manifest.stats
  // =========================================================================

  describe('query: manifest.stats', () => {
    it('should return manifest statistics', async () => {
      vi.mocked(pipelineManifestStats).mockResolvedValue({
        success: true,
        data: { total: 25, byStatus: { completed: 20, partial: 5 }, actionable: 8, needsFollowup: 3, averageFindings: 2.5 },
      });

      const result = await handler.query('manifest.stats', {});
      expect(result.success).toBe(true);
      expect((result.data as { total: number }).total).toBe(25);
      expect(pipelineManifestStats).toHaveBeenCalledWith(undefined, '/mock/project');
    });

    it('should pass epicId filter', async () => {
      vi.mocked(pipelineManifestStats).mockResolvedValue({
        success: true,
        data: { total: 5 },
      });

      await handler.query('manifest.stats', { epicId: 'T5241' });
      expect(pipelineManifestStats).toHaveBeenCalledWith('T5241', '/mock/project');
    });
  });

  // =========================================================================
  // Mutate: manifest.append
  // =========================================================================

  describe('mutate: manifest.append', () => {
    it('should append entry to manifest', async () => {
      vi.mocked(pipelineManifestAppend).mockResolvedValue({
        success: true,
        data: { appended: true, entryId: 'R001' },
      });

      const entry = {
        id: 'R001',
        file: '.cleo/research/test.md',
        title: 'Test Research',
        date: '2026-03-03',
        status: 'completed',
        agent_type: 'research',
        topics: ['testing'],
        actionable: true,
      };

      const result = await handler.mutate('manifest.append', { entry });
      expect(result.success).toBe(true);
      expect(pipelineManifestAppend).toHaveBeenCalledWith(entry, '/mock/project');
    });

    it('should return E_INVALID_INPUT when entry is missing', async () => {
      const result = await handler.mutate('manifest.append', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('entry');
    });
  });

  // =========================================================================
  // Mutate: manifest.archive
  // =========================================================================

  describe('mutate: manifest.archive', () => {
    it('should archive old manifest entries', async () => {
      vi.mocked(pipelineManifestArchive).mockResolvedValue({
        success: true,
        data: { archived: 5, remaining: 20 },
      });

      const result = await handler.mutate('manifest.archive', { beforeDate: '2026-01-01' });
      expect(result.success).toBe(true);
      expect((result.data as { archived: number }).archived).toBe(5);
      expect(pipelineManifestArchive).toHaveBeenCalledWith('2026-01-01', '/mock/project');
    });

    it('should return E_INVALID_INPUT when beforeDate is missing', async () => {
      const result = await handler.mutate('manifest.archive', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('beforeDate');
    });
  });

  // =========================================================================
  // Unknown manifest operations
  // =========================================================================

  describe('unknown manifest operations', () => {
    it('should return E_INVALID_OPERATION for unknown manifest query', async () => {
      const result = await handler.query('manifest.nonexistent');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should return E_INVALID_OPERATION for unknown manifest mutation', async () => {
      const result = await handler.mutate('manifest.nonexistent');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  // =========================================================================
  // Response metadata
  // =========================================================================

  describe('response metadata', () => {
    it('should include _meta with pipeline domain', async () => {
      vi.mocked(pipelineManifestStats).mockResolvedValue({
        success: true,
        data: { total: 0 },
      });

      const result = await handler.query('manifest.stats', {});
      expect(result._meta).toBeDefined();
      expect(result._meta.domain).toBe('pipeline');
      expect(result._meta.operation).toBe('manifest.stats');
      expect(result._meta.gateway).toBe('query');
    });

    it('should include _meta in mutate responses', async () => {
      vi.mocked(pipelineManifestArchive).mockResolvedValue({
        success: true,
        data: { archived: 0, remaining: 0 },
      });

      const result = await handler.mutate('manifest.archive', { beforeDate: '2026-01-01' });
      expect(result._meta).toBeDefined();
      expect(result._meta.domain).toBe('pipeline');
      expect(result._meta.gateway).toBe('mutate');
    });
  });
});
