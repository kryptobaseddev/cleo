/**
 * Dispatch shape-parity tests for the T1116 Code Intelligence CLI surface.
 *
 * Verifies that each of the 4 new `query:nexus.*` operations correctly wires
 * to the corresponding engine function and returns a LAFS-compliant envelope.
 *
 * Operations under test:
 *   - nexus.route-map
 *   - nexus.shape-check
 *   - nexus.search-code
 *   - nexus.wiki
 *
 * @task T1116
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock core internals used by the handler
// Mock the nexus-engine — stub all functions referenced by NexusHandler
vi.mock('@cleocode/core/internal', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
  getLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
  nexusStatus: vi.fn(),
  nexusListProjects: vi.fn(),
  nexusShowProject: vi.fn(),
  nexusResolve: vi.fn(),
  nexusDepsQuery: vi.fn(),
  nexusGraph: vi.fn(),
  nexusCriticalPath: vi.fn(),
  nexusBlockers: vi.fn(),
  nexusOrphans: vi.fn(),
  nexusDiscover: vi.fn(),
  nexusSearch: vi.fn(),
  nexusAugment: vi.fn(),
  nexusInitialize: vi.fn(),
  nexusRegisterProject: vi.fn(),
  nexusUnregisterProject: vi.fn(),
  nexusSyncProject: vi.fn(),
  nexusSetPermission: vi.fn(),
  nexusReconcileProject: vi.fn(),
  nexusShareStatus: vi.fn(),
  nexusShareSnapshotExport: vi.fn(),
  nexusShareSnapshotImport: vi.fn(),
  nexusTransferPreview: vi.fn(),
  nexusTransferExecute: vi.fn(),
  // T1115 — Living Brain engine functions (needed so handler imports resolve)
  nexusFullContext: vi.fn(),
  nexusTaskFootprint: vi.fn(),
  nexusBrainAnchors: vi.fn(),
  nexusWhy: vi.fn(),
  nexusImpactFull: vi.fn(),
  // T1116 — Code Intelligence engine functions
  nexusRouteMap: vi.fn(),
  nexusShapeCheck: vi.fn(),
  nexusSearchCode: vi.fn(),
  nexusWiki: vi.fn(),
}));

import {
  nexusRouteMap,
  nexusSearchCode,
  nexusShapeCheck,
  nexusWiki,
} from '@cleocode/core/internal';
import { NexusHandler } from '../nexus.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROUTE_MAP_RESULT_FIXTURE = {
  projectId: 'mock-project-id',
  routes: [
    {
      routeId: 'route:getUserById',
      handlerName: 'getUserById',
      routeMeta: { method: 'GET', path: '/users/:id' },
      fetchedDeps: ['db.query'],
      callerCount: 3,
    },
  ],
  distinctDeps: ['db.query'],
};

const SHAPE_CHECK_RESULT_FIXTURE = {
  handlerId: 'getUserById',
  declaredShape: '{ id: string; name: string }',
  overallStatus: 'compatible' as const,
  recommendation: 'No changes needed.',
  callers: [
    {
      callerName: 'fetchUser',
      callerFile: 'src/api/users.ts',
      expectedShape: '{ id: string; name: string }',
      status: 'compatible' as const,
      diagnosis: '',
    },
  ],
};

const SEARCH_CODE_RESULT_FIXTURE = {
  hits: [
    {
      symbolId: 'nexusAugment',
      kind: 'function',
      filePath: 'packages/cleo/src/dispatch/engines/nexus-engine.ts',
      score: 0.95,
    },
  ],
  query: 'nexusAugment',
  count: 1,
};

const WIKI_RESULT_FIXTURE = {
  success: true,
  communityCount: 3,
  fileCount: 3,
  loomEnabled: false,
  skippedCommunities: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NexusHandler — T1116 Code Intelligence CLI surface', () => {
  let handler: NexusHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new NexusHandler();
  });

  // -------------------------------------------------------------------------
  // nexus.route-map
  // -------------------------------------------------------------------------

  describe('query: route-map', () => {
    it('returns LAFS envelope with RouteMapResult data on success', async () => {
      vi.mocked(nexusRouteMap).mockResolvedValue({
        success: true,
        data: ROUTE_MAP_RESULT_FIXTURE,
      });

      const result = await handler.query('route-map', {});

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        routes: expect.arrayContaining([expect.objectContaining({ handlerName: 'getUserById' })]),
      });
      // projectId auto-derived from projectRoot when not provided
      expect(vi.mocked(nexusRouteMap)).toHaveBeenCalledWith(expect.any(String), '/mock/project');
    });

    it('uses provided projectId when supplied', async () => {
      vi.mocked(nexusRouteMap).mockResolvedValue({
        success: true,
        data: ROUTE_MAP_RESULT_FIXTURE,
      });

      await handler.query('route-map', { projectId: 'explicit-id' });

      expect(vi.mocked(nexusRouteMap)).toHaveBeenCalledWith('explicit-id', '/mock/project');
    });

    it('propagates engine error to LAFS envelope', async () => {
      vi.mocked(nexusRouteMap).mockResolvedValue({
        success: false,
        error: { code: 'E_INTERNAL', message: 'nexus.db not found' },
      });

      const result = await handler.query('route-map', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
    });
  });

  // -------------------------------------------------------------------------
  // nexus.shape-check
  // -------------------------------------------------------------------------

  describe('query: shape-check', () => {
    it('returns LAFS envelope with ShapeCheckResult data on success', async () => {
      vi.mocked(nexusShapeCheck).mockResolvedValue({
        success: true,
        data: SHAPE_CHECK_RESULT_FIXTURE,
      });

      const result = await handler.query('shape-check', {
        routeSymbol: 'src/api/users.ts::getUserById',
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        handlerId: 'getUserById',
        overallStatus: 'compatible',
      });
      expect(vi.mocked(nexusShapeCheck)).toHaveBeenCalledWith(
        'src/api/users.ts::getUserById',
        expect.any(String),
        '/mock/project',
      );
    });

    it('returns E_INVALID_INPUT when routeSymbol param is missing', async () => {
      const result = await handler.query('shape-check', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(vi.mocked(nexusShapeCheck)).not.toHaveBeenCalled();
    });

    it('propagates engine error to LAFS envelope', async () => {
      vi.mocked(nexusShapeCheck).mockResolvedValue({
        success: false,
        error: { code: 'E_INTERNAL', message: 'route symbol not found in nexus index' },
      });

      const result = await handler.query('shape-check', {
        routeSymbol: 'src/missing.ts::handler',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
    });
  });

  // -------------------------------------------------------------------------
  // nexus.search-code
  // -------------------------------------------------------------------------

  describe('query: search-code', () => {
    it('returns LAFS envelope with BM25 search results on success', async () => {
      vi.mocked(nexusSearchCode).mockResolvedValue({
        success: true,
        data: SEARCH_CODE_RESULT_FIXTURE,
      });

      const result = await handler.query('search-code', { pattern: 'nexusAugment', limit: 5 });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ query: 'nexusAugment', count: 1 });
      expect(vi.mocked(nexusSearchCode)).toHaveBeenCalledWith('nexusAugment', 5);
    });

    it('returns E_INVALID_INPUT when pattern param is missing', async () => {
      const result = await handler.query('search-code', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(vi.mocked(nexusSearchCode)).not.toHaveBeenCalled();
    });

    it('uses default limit of 10 when limit param is omitted', async () => {
      vi.mocked(nexusSearchCode).mockResolvedValue({
        success: true,
        data: SEARCH_CODE_RESULT_FIXTURE,
      });

      await handler.query('search-code', { pattern: 'foo' });

      expect(vi.mocked(nexusSearchCode)).toHaveBeenCalledWith('foo', 10);
    });
  });

  // -------------------------------------------------------------------------
  // nexus.wiki
  // -------------------------------------------------------------------------

  describe('query: wiki', () => {
    it('returns LAFS envelope with NexusWikiResult on success', async () => {
      vi.mocked(nexusWiki).mockResolvedValue({
        success: true,
        data: WIKI_RESULT_FIXTURE,
      });

      const result = await handler.query('wiki', {});

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        success: true,
        communityCount: 3,
        loomEnabled: false,
      });
      // outputDir defaults to <projectRoot>/.cleo/wiki
      expect(vi.mocked(nexusWiki)).toHaveBeenCalledWith(
        '/mock/project/.cleo/wiki',
        '/mock/project',
        { communityFilter: undefined, incremental: undefined },
      );
    });

    it('passes communityFilter and incremental flags when provided', async () => {
      vi.mocked(nexusWiki).mockResolvedValue({
        success: true,
        data: WIKI_RESULT_FIXTURE,
      });

      await handler.query('wiki', {
        outputDir: '/tmp/wiki-out',
        communityFilter: 'community:2',
        incremental: true,
      });

      expect(vi.mocked(nexusWiki)).toHaveBeenCalledWith('/tmp/wiki-out', '/mock/project', {
        communityFilter: 'community:2',
        incremental: true,
      });
    });

    it('propagates engine error to LAFS envelope', async () => {
      vi.mocked(nexusWiki).mockResolvedValue({
        success: false,
        error: { code: 'E_INTERNAL', message: 'wiki-index.js module not found' },
      });

      const result = await handler.query('wiki', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
    });
  });
});
