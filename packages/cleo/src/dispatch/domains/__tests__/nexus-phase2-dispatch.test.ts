/**
 * Dispatch shape-parity tests for the T1510 Phase 2 nexus dispatch ops.
 *
 * Verifies that each of the 14 new operations correctly wires to the
 * corresponding engine function and returns a LAFS-compliant envelope.
 *
 * Operations under test (query):
 *   - nexus.clusters
 *   - nexus.flows
 *   - nexus.context
 *   - nexus.projects.list
 *   - nexus.diff
 *   - nexus.query-cte
 *   - nexus.hot-paths
 *   - nexus.hot-nodes
 *   - nexus.cold-symbols
 *
 * Operations under test (mutate):
 *   - nexus.projects.register
 *   - nexus.projects.remove
 *   - nexus.projects.scan
 *   - nexus.projects.clean
 *   - nexus.refresh-bridge
 *
 * @task T1510
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock core internals
// Mock the nexus-engine — stub all functions referenced by NexusHandler
vi.mock('@cleocode/core/internal', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
  getLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
  getBrainNativeDb: vi.fn(() => null),
  getNexusNativeDb: vi.fn(() => null),
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
  nexusImpact: vi.fn(),
  nexusTopEntries: vi.fn(),
  nexusFullContext: vi.fn(),
  nexusTaskFootprint: vi.fn(),
  nexusBrainAnchors: vi.fn(),
  nexusWhy: vi.fn(),
  nexusImpactFull: vi.fn(),
  nexusRouteMap: vi.fn(),
  nexusShapeCheck: vi.fn(),
  nexusSearchCode: vi.fn(),
  nexusWiki: vi.fn(),
  nexusContractsShow: vi.fn(),
  nexusTaskSymbols: vi.fn(),
  nexusContractsSync: vi.fn(),
  nexusContractsLinkTasks: vi.fn(),
  nexusConduitScan: vi.fn(),
  nexusProfileView: vi.fn(),
  nexusProfileGet: vi.fn(),
  nexusProfileImport: vi.fn(),
  nexusProfileExport: vi.fn(),
  nexusProfileReinforce: vi.fn(),
  nexusProfileUpsert: vi.fn(),
  nexusProfileSupersede: vi.fn(),
  nexusSigilList: vi.fn(),
  nexusSigilSync: vi.fn(),
  // T1510 — Phase 2 engine functions
  nexusClusters: vi.fn(),
  nexusFlows: vi.fn(),
  nexusContext: vi.fn(),
  nexusProjectsList: vi.fn(),
  nexusProjectsRegister: vi.fn(),
  nexusProjectsRemove: vi.fn(),
  nexusProjectsScan: vi.fn(),
  nexusProjectsClean: vi.fn(),
  nexusRefreshBridge: vi.fn(),
  nexusDiff: vi.fn(),
  nexusQueryCte: vi.fn(),
  nexusHotPaths: vi.fn(),
  nexusHotNodes: vi.fn(),
  nexusColdSymbols: vi.fn(),
}));

import {
  nexusClusters,
  nexusColdSymbols,
  nexusContext,
  nexusDiff,
  nexusFlows,
  nexusHotNodes,
  nexusHotPaths,
  nexusProjectsClean,
  nexusProjectsList,
  nexusProjectsRegister,
  nexusProjectsRemove,
  nexusProjectsScan,
  nexusQueryCte,
  nexusRefreshBridge,
} from '@cleocode/core/internal';
import { NexusHandler } from '../nexus.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLUSTERS_FIXTURE = {
  projectId: 'mock-proj',
  repoPath: '/mock/project',
  count: 2,
  communities: [
    { id: 'c1', label: 'Auth', symbolCount: 10, cohesion: 0.75 },
    { id: 'c2', label: 'DB', symbolCount: 5, cohesion: 0.6 },
  ],
};

const FLOWS_FIXTURE = {
  projectId: 'mock-proj',
  repoPath: '/mock/project',
  count: 1,
  flows: [
    {
      id: 'flow1',
      label: 'Auth flow',
      stepCount: 3,
      processType: 'intra_community',
      entryPointId: null,
    },
  ],
};

const CONTEXT_FIXTURE = {
  query: 'dispatchFromCli',
  projectId: 'mock-proj',
  matchCount: 1,
  results: [
    {
      nodeId: 'n1',
      name: 'dispatchFromCli',
      kind: 'function',
      filePath: 'src/dispatch/adapters/cli.ts',
      startLine: 10,
      endLine: 50,
      isExported: true,
      docSummary: 'CLI dispatch adapter',
      community: null,
      callers: [],
      callees: [],
      processes: [],
    },
  ],
};

const PROJECTS_LIST_FIXTURE = {
  projects: [{ name: 'cleocode', path: '/mnt/projects/cleocode', taskCount: 100 }],
  count: 1,
};

const PROJECTS_REGISTER_FIXTURE = {
  hash: 'abc123',
  path: '/mnt/projects/cleocode',
};

const PROJECTS_REMOVE_FIXTURE = {
  removed: 'cleocode',
};

const SCAN_FIXTURE = {
  roots: ['/home/user/code'],
  unregistered: ['/home/user/code/myproject'],
  registered: [],
  tally: { total: 1, unregistered: 1, registered: 0 },
  autoRegistered: [],
  autoRegisterErrors: [],
};

const CLEAN_FIXTURE = {
  dryRun: true,
  matched: 3,
  purged: 0,
  remaining: 10,
  sample: ['/tmp/old-project'],
  totalCount: 13,
};

const REFRESH_BRIDGE_FIXTURE = {
  path: '/mock/project/.cleo/nexus-bridge.md',
  written: true,
  projectId: 'mock-proj',
  repoPath: '/mock/project',
};

const DIFF_FIXTURE = {
  beforeRef: 'HEAD~1',
  afterRef: 'HEAD',
  beforeSha: 'abc1234',
  afterSha: 'def5678',
  projectId: 'mock-proj',
  repoPath: '/mock/project',
  changedFiles: ['src/foo.ts'],
  nodesBefore: 100,
  nodesAfter: 102,
  newNodes: 2,
  removedNodes: 0,
  relationsBefore: 200,
  relationsAfter: 205,
  newRelations: 5,
  removedRelations: 0,
  healthStatus: 'RELATIONS_ADDED',
  regressions: [],
};

const QUERY_CTE_FIXTURE = {
  success: true,
  rows: [{ sourceId: 'sym1', targetId: 'sym2', type: 'calls' }],
  row_count: 1,
  execution_time_ms: 5.2,
};

const HOT_PATHS_FIXTURE = {
  paths: [
    {
      sourceId: 'src1',
      targetId: 'tgt1',
      type: 'calls',
      weight: 0.8,
      lastAccessedAt: null,
      coAccessedCount: 10,
    },
  ],
  count: 1,
};

const HOT_NODES_FIXTURE = {
  nodes: [
    {
      nodeId: 'n1',
      sourceId: 'n1',
      label: 'myFn',
      filePath: 'src/foo.ts',
      kind: 'function',
      totalWeight: 2.5,
      pathCount: 3,
    },
  ],
  count: 1,
};

const COLD_SYMBOLS_FIXTURE = {
  symbols: [
    {
      nodeId: 'n2',
      sourceId: 'n2',
      label: 'oldFn',
      filePath: 'src/old.ts',
      kind: 'function',
      lastAccessedAt: '2026-01-01T00:00:00Z',
      lastAccessed: '2026-01-01T00:00:00Z',
      ageDays: 100,
      pathCount: 1,
      maxWeight: 0.01,
    },
  ],
  count: 1,
  thresholdDays: 30,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function engineSuccess<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NexusHandler — Phase 2 T1510 operations', () => {
  let handler: NexusHandler;

  beforeEach(() => {
    handler = new NexusHandler();
    vi.clearAllMocks();
  });

  // ── Query ops ────────────────────────────────────────────────────────────

  describe('query:clusters', () => {
    it('returns LAFS envelope with community list', async () => {
      vi.mocked(nexusClusters).mockResolvedValueOnce(engineSuccess(CLUSTERS_FIXTURE));

      const result = await handler.query('clusters', {});

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ count: 2 });
      expect(nexusClusters).toHaveBeenCalledTimes(1);
    });

    it('returns unsupported for invalid op', async () => {
      const result = await handler.query('clusters-invalid' as 'clusters', {});
      expect(result.success).toBe(false);
    });
  });

  describe('query:flows', () => {
    it('returns LAFS envelope with flow list', async () => {
      vi.mocked(nexusFlows).mockResolvedValueOnce(engineSuccess(FLOWS_FIXTURE));

      const result = await handler.query('flows', {});

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ count: 1 });
      expect(nexusFlows).toHaveBeenCalledTimes(1);
    });
  });

  describe('query:context', () => {
    it('returns LAFS envelope with symbol context', async () => {
      vi.mocked(nexusContext).mockResolvedValueOnce(engineSuccess(CONTEXT_FIXTURE));

      const result = await handler.query('context', { symbol: 'dispatchFromCli' });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ matchCount: 1 });
      expect(nexusContext).toHaveBeenCalledWith(
        'dispatchFromCli',
        expect.any(String),
        expect.any(String),
        20,
        false,
      );
    });

    it('returns error when symbol param missing', async () => {
      const result = await handler.query('context', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  describe('query:projects.list', () => {
    it('returns LAFS envelope with project list', async () => {
      vi.mocked(nexusProjectsList).mockResolvedValueOnce(engineSuccess(PROJECTS_LIST_FIXTURE));

      const result = await handler.query('projects.list', {});

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ count: 1 });
      expect(nexusProjectsList).toHaveBeenCalledTimes(1);
    });
  });

  describe('query:diff', () => {
    it('returns LAFS envelope with diff result', async () => {
      vi.mocked(nexusDiff).mockResolvedValueOnce(engineSuccess(DIFF_FIXTURE));

      const result = await handler.query('diff', {});

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ healthStatus: 'RELATIONS_ADDED' });
      expect(nexusDiff).toHaveBeenCalledWith(expect.any(String), undefined, undefined, undefined);
    });

    it('passes beforeRef and afterRef params', async () => {
      vi.mocked(nexusDiff).mockResolvedValueOnce(engineSuccess(DIFF_FIXTURE));

      await handler.query('diff', { beforeRef: 'HEAD~3', afterRef: 'HEAD' });

      expect(nexusDiff).toHaveBeenCalledWith(expect.any(String), 'HEAD~3', 'HEAD', undefined);
    });
  });

  describe('query:query-cte', () => {
    it('returns LAFS envelope with CTE result', async () => {
      vi.mocked(nexusQueryCte).mockResolvedValueOnce(engineSuccess(QUERY_CTE_FIXTURE));

      const result = await handler.query('query-cte', { cte: 'callers-of', params: ['sym1'] });

      expect(result.success).toBe(true);
      expect(nexusQueryCte).toHaveBeenCalledWith('callers-of', ['sym1']);
    });

    it('returns error when cte param missing', async () => {
      const result = await handler.query('query-cte', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  describe('query:hot-paths', () => {
    it('returns LAFS envelope with hot paths', async () => {
      vi.mocked(nexusHotPaths).mockResolvedValueOnce(engineSuccess(HOT_PATHS_FIXTURE));

      const result = await handler.query('hot-paths', { limit: 10 });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ count: 1 });
      expect(nexusHotPaths).toHaveBeenCalledWith(expect.any(String), 10);
    });

    it('defaults limit to 20', async () => {
      vi.mocked(nexusHotPaths).mockResolvedValueOnce(engineSuccess(HOT_PATHS_FIXTURE));

      await handler.query('hot-paths', {});

      expect(nexusHotPaths).toHaveBeenCalledWith(expect.any(String), 20);
    });
  });

  describe('query:hot-nodes', () => {
    it('returns LAFS envelope with hot nodes', async () => {
      vi.mocked(nexusHotNodes).mockResolvedValueOnce(engineSuccess(HOT_NODES_FIXTURE));

      const result = await handler.query('hot-nodes', { limit: 5 });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ count: 1 });
      expect(nexusHotNodes).toHaveBeenCalledWith(expect.any(String), 5);
    });
  });

  describe('query:cold-symbols', () => {
    it('returns LAFS envelope with cold symbols', async () => {
      vi.mocked(nexusColdSymbols).mockResolvedValueOnce(engineSuccess(COLD_SYMBOLS_FIXTURE));

      const result = await handler.query('cold-symbols', { days: 30 });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ count: 1, thresholdDays: 30 });
      expect(nexusColdSymbols).toHaveBeenCalledWith(expect.any(String), 30);
    });

    it('defaults days to 30', async () => {
      vi.mocked(nexusColdSymbols).mockResolvedValueOnce(engineSuccess(COLD_SYMBOLS_FIXTURE));

      await handler.query('cold-symbols', {});

      expect(nexusColdSymbols).toHaveBeenCalledWith(expect.any(String), 30);
    });
  });

  // ── Mutate ops ────────────────────────────────────────────────────────────

  describe('mutate:projects.register', () => {
    it('returns LAFS envelope with hash and path', async () => {
      vi.mocked(nexusProjectsRegister).mockResolvedValueOnce(
        engineSuccess(PROJECTS_REGISTER_FIXTURE),
      );

      const result = await handler.mutate('projects.register', { path: '/mnt/projects/cleocode' });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ hash: 'abc123' });
      expect(nexusProjectsRegister).toHaveBeenCalledWith('/mnt/projects/cleocode', undefined);
    });

    it('returns error when path param missing', async () => {
      const result = await handler.mutate('projects.register', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  describe('mutate:projects.remove', () => {
    it('returns LAFS envelope with removed project name', async () => {
      vi.mocked(nexusProjectsRemove).mockResolvedValueOnce(engineSuccess(PROJECTS_REMOVE_FIXTURE));

      const result = await handler.mutate('projects.remove', { nameOrHash: 'cleocode' });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ removed: 'cleocode' });
      expect(nexusProjectsRemove).toHaveBeenCalledWith('cleocode');
    });

    it('returns error when nameOrHash param missing', async () => {
      const result = await handler.mutate('projects.remove', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });
  });

  describe('mutate:projects.scan', () => {
    it('returns LAFS envelope with scan result', async () => {
      vi.mocked(nexusProjectsScan).mockResolvedValueOnce(engineSuccess(SCAN_FIXTURE));

      const result = await handler.mutate('projects.scan', { autoRegister: false });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ tally: { total: 1 } });
      expect(nexusProjectsScan).toHaveBeenCalledWith(
        expect.objectContaining({ autoRegister: false }),
      );
    });
  });

  describe('mutate:projects.clean', () => {
    it('returns LAFS envelope with clean result', async () => {
      vi.mocked(nexusProjectsClean).mockResolvedValueOnce(engineSuccess(CLEAN_FIXTURE));

      const result = await handler.mutate('projects.clean', { dryRun: true, includeTemp: true });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ matched: 3 });
      expect(nexusProjectsClean).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true, includeTemp: true }),
      );
    });
  });

  describe('mutate:refresh-bridge', () => {
    it('returns LAFS envelope with bridge result', async () => {
      vi.mocked(nexusRefreshBridge).mockResolvedValueOnce(engineSuccess(REFRESH_BRIDGE_FIXTURE));

      const result = await handler.mutate('refresh-bridge', {});

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ written: true });
      expect(nexusRefreshBridge).toHaveBeenCalledWith(expect.any(String), undefined);
    });
  });

  // ── getSupportedOperations ────────────────────────────────────────────────

  describe('getSupportedOperations', () => {
    it('includes all T1510 query ops', () => {
      const { query } = handler.getSupportedOperations();
      expect(query).toContain('clusters');
      expect(query).toContain('flows');
      expect(query).toContain('context');
      expect(query).toContain('projects.list');
      expect(query).toContain('diff');
      expect(query).toContain('query-cte');
      expect(query).toContain('hot-paths');
      expect(query).toContain('hot-nodes');
      expect(query).toContain('cold-symbols');
    });

    it('includes all T1510 mutate ops', () => {
      const { mutate } = handler.getSupportedOperations();
      expect(mutate).toContain('projects.register');
      expect(mutate).toContain('projects.remove');
      expect(mutate).toContain('projects.scan');
      expect(mutate).toContain('projects.clean');
      expect(mutate).toContain('refresh-bridge');
    });
  });
});
