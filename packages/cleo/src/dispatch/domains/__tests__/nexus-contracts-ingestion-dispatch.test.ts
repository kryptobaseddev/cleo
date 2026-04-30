/**
 * Dispatch shape-parity tests for the T1117 Contracts + Ingestion Bridge verbs.
 *
 * Verifies that each of the 5 new operations correctly wires to the
 * corresponding engine function and returns a LAFS-compliant envelope.
 *
 * Operations under test:
 *   query:
 *     - nexus.contracts-show
 *     - nexus.task-symbols
 *   mutate:
 *     - nexus.contracts-sync
 *     - nexus.contracts-link-tasks
 *     - nexus.conduit-scan
 *
 * @task T1117
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
  // T1116 — Code Intelligence engine functions (needed so handler imports resolve)
  nexusRouteMap: vi.fn(),
  nexusShapeCheck: vi.fn(),
  nexusSearchCode: vi.fn(),
  nexusWiki: vi.fn(),
  // T1117 — Contracts + ingestion bridge engine functions
  nexusContractsShow: vi.fn(),
  nexusContractsSync: vi.fn(),
  nexusContractsLinkTasks: vi.fn(),
  nexusConduitScan: vi.fn(),
  nexusTaskSymbols: vi.fn(),
}));

import {
  nexusConduitScan,
  nexusContractsLinkTasks,
  nexusContractsShow,
  nexusContractsSync,
  nexusTaskSymbols,
} from '@cleocode/core/internal';
import { NexusHandler } from '../nexus.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONTRACTS_SHOW_FIXTURE = {
  projectAId: 'proj-a',
  projectBId: 'proj-b',
  matches: [
    {
      contractA: {
        id: 'http:proj-a::/api/tasks::GET',
        type: 'http',
        projectId: 'proj-a',
        method: 'GET',
        path: '/api/tasks',
        requestSchemaJson: '{}',
        responseSchemaJson: '{}',
        sourceSymbolId: 'src/tasks.ts::listTasks',
        confidence: 0.9,
      },
      contractB: {
        id: 'http:proj-b::/api/tasks::GET',
        type: 'http',
        projectId: 'proj-b',
        method: 'GET',
        path: '/api/tasks',
        requestSchemaJson: '{}',
        responseSchemaJson: '{}',
        sourceSymbolId: 'src/tasks.ts::listTasks',
        confidence: 0.9,
      },
      level: 'exact' as const,
      score: 1.0,
      reason: 'Exact HTTP method + path match',
      compatibility: 'compatible' as const,
    },
  ],
  compatibleCount: 1,
  incompatibleCount: 0,
  partialCount: 0,
  overallCompatibility: 100,
  recommendations: [],
};

const TASK_SYMBOLS_FIXTURE = {
  taskId: 'T1117',
  count: 2,
  symbols: [
    {
      nexusNodeId: 'nexus:abc',
      label: 'nexusContractsSync',
      kind: 'function',
      filePath: 'packages/cleo/src/dispatch/engines/nexus-engine.ts',
      weight: 1.0,
      matchStrategy: 'git-log-file-match',
    },
    {
      nexusNodeId: 'nexus:def',
      label: 'NexusHandler',
      kind: 'class',
      filePath: 'packages/cleo/src/dispatch/domains/nexus.ts',
      weight: 0.8,
      matchStrategy: 'git-log-file-match',
    },
  ],
};

const CONTRACTS_SYNC_FIXTURE = {
  projectId: 'mock-project-id',
  repoPath: '/mock/project',
  http: 3,
  grpc: 1,
  topic: 2,
  totalCount: 6,
};

const CONTRACTS_LINK_TASKS_FIXTURE = {
  linked: 5,
  commitsProcessed: 12,
  tasksFound: 3,
  lastCommitHash: 'abc1234',
};

const CONDUIT_SCAN_FIXTURE = {
  scanned: 42,
  linked: 7,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NexusHandler — T1117 Contracts + Ingestion Bridge', () => {
  let handler: NexusHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new NexusHandler();
  });

  // -------------------------------------------------------------------------
  // query: contracts-show
  // -------------------------------------------------------------------------

  describe('query: contracts-show', () => {
    it('returns LAFS envelope with ContractCompatibilityMatrix on success', async () => {
      vi.mocked(nexusContractsShow).mockResolvedValue({
        success: true,
        data: CONTRACTS_SHOW_FIXTURE,
      });

      const result = await handler.query('contracts-show', {
        projectA: 'proj-a',
        projectB: 'proj-b',
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        compatibleCount: 1,
        overallCompatibility: 100,
      });
      expect(vi.mocked(nexusContractsShow)).toHaveBeenCalledWith(
        'proj-a',
        'proj-b',
        '/mock/project',
      );
    });

    it('returns E_INVALID_INPUT when projectA is missing', async () => {
      const result = await handler.query('contracts-show', { projectB: 'proj-b' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(vi.mocked(nexusContractsShow)).not.toHaveBeenCalled();
    });

    it('returns E_INVALID_INPUT when projectB is missing', async () => {
      const result = await handler.query('contracts-show', { projectA: 'proj-a' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(vi.mocked(nexusContractsShow)).not.toHaveBeenCalled();
    });

    it('propagates engine error to LAFS envelope', async () => {
      vi.mocked(nexusContractsShow).mockResolvedValue({
        success: false,
        error: { code: 'E_INTERNAL', message: 'nexus.db not found' },
      });

      const result = await handler.query('contracts-show', {
        projectA: 'proj-a',
        projectB: 'proj-b',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
    });
  });

  // -------------------------------------------------------------------------
  // query: task-symbols
  // -------------------------------------------------------------------------

  describe('query: task-symbols', () => {
    it('returns LAFS envelope with symbol list on success', async () => {
      vi.mocked(nexusTaskSymbols).mockResolvedValue({
        success: true,
        data: TASK_SYMBOLS_FIXTURE,
      });

      const result = await handler.query('task-symbols', { taskId: 'T1117' });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        taskId: 'T1117',
        count: 2,
        symbols: expect.arrayContaining([expect.objectContaining({ label: 'nexusContractsSync' })]),
      });
      expect(vi.mocked(nexusTaskSymbols)).toHaveBeenCalledWith('T1117', '/mock/project');
    });

    it('returns E_INVALID_INPUT when taskId is missing', async () => {
      const result = await handler.query('task-symbols', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(vi.mocked(nexusTaskSymbols)).not.toHaveBeenCalled();
    });

    it('propagates engine error to LAFS envelope', async () => {
      vi.mocked(nexusTaskSymbols).mockResolvedValue({
        success: false,
        error: { code: 'E_INTERNAL', message: 'brain.db unavailable' },
      });

      const result = await handler.query('task-symbols', { taskId: 'T9999' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
    });
  });

  // -------------------------------------------------------------------------
  // mutate: contracts-sync
  // -------------------------------------------------------------------------

  describe('mutate: contracts-sync', () => {
    it('returns LAFS envelope with extraction counts on success', async () => {
      vi.mocked(nexusContractsSync).mockResolvedValue({
        success: true,
        data: CONTRACTS_SYNC_FIXTURE,
      });

      const result = await handler.mutate('contracts-sync', { repoPath: '/mock/project' });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        http: 3,
        grpc: 1,
        topic: 2,
        totalCount: 6,
      });
      expect(vi.mocked(nexusContractsSync)).toHaveBeenCalledWith(
        expect.any(String),
        '/mock/project',
      );
    });

    it('uses projectRoot as repoPath when not provided', async () => {
      vi.mocked(nexusContractsSync).mockResolvedValue({
        success: true,
        data: CONTRACTS_SYNC_FIXTURE,
      });

      await handler.mutate('contracts-sync', {});

      expect(vi.mocked(nexusContractsSync)).toHaveBeenCalledWith(
        expect.any(String),
        '/mock/project',
      );
    });

    it('uses explicit projectId when provided', async () => {
      vi.mocked(nexusContractsSync).mockResolvedValue({
        success: true,
        data: CONTRACTS_SYNC_FIXTURE,
      });

      await handler.mutate('contracts-sync', {
        projectId: 'explicit-id',
        repoPath: '/mock/project',
      });

      expect(vi.mocked(nexusContractsSync)).toHaveBeenCalledWith('explicit-id', '/mock/project');
    });

    it('propagates engine error to LAFS envelope', async () => {
      vi.mocked(nexusContractsSync).mockResolvedValue({
        success: false,
        error: { code: 'E_INTERNAL', message: 'extractor failed' },
      });

      const result = await handler.mutate('contracts-sync', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
    });
  });

  // -------------------------------------------------------------------------
  // mutate: contracts-link-tasks
  // -------------------------------------------------------------------------

  describe('mutate: contracts-link-tasks', () => {
    it('returns LAFS envelope with linker result on success', async () => {
      vi.mocked(nexusContractsLinkTasks).mockResolvedValue({
        success: true,
        data: CONTRACTS_LINK_TASKS_FIXTURE,
      });

      const result = await handler.mutate('contracts-link-tasks', { repoPath: '/mock/project' });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        linked: 5,
        commitsProcessed: 12,
      });
      expect(vi.mocked(nexusContractsLinkTasks)).toHaveBeenCalledWith(
        expect.any(String),
        '/mock/project',
      );
    });

    it('uses projectRoot as repoPath when not provided', async () => {
      vi.mocked(nexusContractsLinkTasks).mockResolvedValue({
        success: true,
        data: CONTRACTS_LINK_TASKS_FIXTURE,
      });

      await handler.mutate('contracts-link-tasks', {});

      expect(vi.mocked(nexusContractsLinkTasks)).toHaveBeenCalledWith(
        expect.any(String),
        '/mock/project',
      );
    });

    it('propagates engine error to LAFS envelope', async () => {
      vi.mocked(nexusContractsLinkTasks).mockResolvedValue({
        success: false,
        error: { code: 'E_INTERNAL', message: 'git log failed' },
      });

      const result = await handler.mutate('contracts-link-tasks', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
    });
  });

  // -------------------------------------------------------------------------
  // mutate: conduit-scan
  // -------------------------------------------------------------------------

  describe('mutate: conduit-scan', () => {
    it('returns LAFS envelope with scan counts on success', async () => {
      vi.mocked(nexusConduitScan).mockResolvedValue({
        success: true,
        data: CONDUIT_SCAN_FIXTURE,
      });

      const result = await handler.mutate('conduit-scan', {});

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        scanned: 42,
        linked: 7,
      });
      expect(vi.mocked(nexusConduitScan)).toHaveBeenCalledWith('/mock/project');
    });

    it('accepts empty params (uses projectRoot automatically)', async () => {
      vi.mocked(nexusConduitScan).mockResolvedValue({
        success: true,
        data: { scanned: 0, linked: 0 },
      });

      const result = await handler.mutate('conduit-scan');

      expect(result.success).toBe(true);
      expect(vi.mocked(nexusConduitScan)).toHaveBeenCalledWith('/mock/project');
    });

    it('propagates engine error to LAFS envelope', async () => {
      vi.mocked(nexusConduitScan).mockResolvedValue({
        success: false,
        error: { code: 'E_INTERNAL', message: 'conduit.db missing' },
      });

      const result = await handler.mutate('conduit-scan', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
    });
  });
});
