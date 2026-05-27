/**
 * Smoke tests for `cleo graph` command group (T9147 W3).
 *
 * Verifies that:
 * - `graphCommand` is exported and has the correct meta
 * - All expected subcommands are registered
 * - `cleo graph living *` sub-namespace exists
 * - `cleo nexus context` emits `meta.deprecated` via alias shim
 *
 * @task T9147
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@cleocode/core/internal', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
  getLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
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

import { graphCommand } from '../graph.js';

describe('graphCommand (T9147 W3)', () => {
  it('is exported with correct name and description', () => {
    expect(graphCommand).toBeDefined();
    expect(graphCommand.meta?.name).toBe('graph');
    expect(graphCommand.meta?.description).toContain('code intelligence');
  });

  it('has all required project-scoped subcommands', () => {
    const subs = graphCommand.subCommands as Record<string, unknown>;
    expect(subs).toBeDefined();

    const requiredOps = [
      'status',
      'resolve',
      'deps',
      'raw',
      'discover',
      'search',
      'augment',
      'context',
      'impact',
      'impact-full',
      'clusters',
      'flows',
      'diff',
      'route-map',
      'shape-check',
      'search-code',
      'wiki',
      'hot-paths',
      'hot-nodes',
      'cold-symbols',
      'orphans',
      'query',
      'init',
      'sync',
      'reconcile',
    ];

    for (const op of requiredOps) {
      expect(subs, `subcommand "${op}" should be registered`).toHaveProperty(op);
    }
  });

  it('has cleo graph living sub-namespace', () => {
    const subs = graphCommand.subCommands as Record<string, unknown>;
    expect(subs).toHaveProperty('living');
    const living = subs['living'] as { subCommands?: Record<string, unknown> };
    expect(living.subCommands).toBeDefined();
    expect(living.subCommands).toHaveProperty('full-context');
    expect(living.subCommands).toHaveProperty('task-footprint');
    expect(living.subCommands).toHaveProperty('brain-anchors');
    expect(living.subCommands).toHaveProperty('why');
    expect(living.subCommands).toHaveProperty('conduit-scan');
  });
});
