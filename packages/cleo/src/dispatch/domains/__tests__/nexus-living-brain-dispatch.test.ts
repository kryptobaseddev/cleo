/**
 * Dispatch shape-parity tests for the T1115 Living Brain primitives.
 *
 * Verifies that each of the 5 new `query:nexus.*` operations correctly wires
 * to the corresponding engine function and returns a LAFS-compliant envelope
 * matching the same shape the CLI handler produces.
 *
 * @task T1115
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock core internals used by the handler
// Mock the nexus-engine — only need the 5 new functions + existing stubs
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
  // T1115 — 5 new Living Brain engine functions
  nexusFullContext: vi.fn(),
  nexusTaskFootprint: vi.fn(),
  nexusBrainAnchors: vi.fn(),
  nexusWhy: vi.fn(),
  nexusImpactFull: vi.fn(),
}));

import {
  nexusBrainAnchors,
  nexusFullContext,
  nexusImpactFull,
  nexusTaskFootprint,
  nexusWhy,
} from '@cleocode/core/internal';
import { NexusHandler } from '../nexus.js';

// ---------------------------------------------------------------------------
// Fixtures — minimal shape-parity objects matching contract interfaces
// ---------------------------------------------------------------------------

const SYMBOL_FULL_CONTEXT_FIXTURE = {
  symbolId: 'handleTopEntries',
  nexus: {
    symbolId: 'handleTopEntries',
    label: 'handleTopEntries',
    filePath: 'packages/cleo/src/dispatch/domains/nexus.ts',
    kind: 'function',
    communityId: null,
    callers: [],
    callees: [],
    processes: [],
  },
  brainMemories: [],
  tasks: [],
  sentientProposals: [],
  conduitThreads: [],
  plasticityWeight: { totalWeight: 0, edgeCount: 0 },
};

const TASK_CODE_IMPACT_FIXTURE = {
  taskId: 'T1115',
  files: ['packages/cleo/src/dispatch/domains/nexus.ts'],
  symbols: [],
  blastRadius: { totalAffected: 0, maxRisk: 'NONE' as const, symbolsAnalyzed: 0 },
  brainObservations: [],
  decisions: [],
  riskScore: 'NONE' as const,
};

const CODE_ANCHOR_RESULT_FIXTURE = {
  entryId: 'observation:abc123',
  nexusNodes: [],
  tasksForNodes: [],
  plasticitySignal: 0,
};

const CODE_REASON_TRACE_FIXTURE = {
  symbolId: 'nexusAugment',
  narrative: 'No brain context found for this symbol.',
  chain: [],
};

const IMPACT_FULL_REPORT_FIXTURE = {
  symbolId: 'nexusAugment',
  structural: {
    directCallers: 0,
    likelyAffected: 0,
    mayNeedTesting: 0,
    totalAffected: 0,
    riskLevel: 'NONE' as const,
  },
  openTasks: [],
  brainRiskNotes: [],
  mergedRiskScore: 'NONE' as const,
  narrative: 'No cross-substrate risk signals found.',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NexusHandler — T1115 Living Brain primitives', () => {
  let handler: NexusHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new NexusHandler();
  });

  // -------------------------------------------------------------------------
  // nexus.full-context
  // -------------------------------------------------------------------------

  describe('query: full-context', () => {
    it('returns LAFS envelope with SymbolFullContext data on success', async () => {
      vi.mocked(nexusFullContext).mockResolvedValue({
        success: true,
        data: SYMBOL_FULL_CONTEXT_FIXTURE,
      });

      const result = await handler.query('full-context', { symbol: 'handleTopEntries' });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        symbolId: 'handleTopEntries',
        plasticityWeight: { totalWeight: 0, edgeCount: 0 },
      });
      expect(vi.mocked(nexusFullContext)).toHaveBeenCalledWith('handleTopEntries', '/mock/project');
    });

    it('returns E_INVALID_INPUT when symbol param is missing', async () => {
      const result = await handler.query('full-context', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(vi.mocked(nexusFullContext)).not.toHaveBeenCalled();
    });

    it('propagates engine error to LAFS envelope', async () => {
      vi.mocked(nexusFullContext).mockResolvedValue({
        success: false,
        error: { code: 'E_INTERNAL', message: 'nexus.db not initialized' },
      });

      const result = await handler.query('full-context', { symbol: 'foo' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
    });
  });

  // -------------------------------------------------------------------------
  // nexus.task-footprint
  // -------------------------------------------------------------------------

  describe('query: task-footprint', () => {
    it('returns LAFS envelope with TaskCodeImpact data on success', async () => {
      vi.mocked(nexusTaskFootprint).mockResolvedValue({
        success: true,
        data: TASK_CODE_IMPACT_FIXTURE,
      });

      const result = await handler.query('task-footprint', { taskId: 'T1115' });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        taskId: 'T1115',
        riskScore: 'NONE',
      });
      expect(vi.mocked(nexusTaskFootprint)).toHaveBeenCalledWith('T1115', '/mock/project');
    });

    it('returns E_INVALID_INPUT when taskId param is missing', async () => {
      const result = await handler.query('task-footprint', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(vi.mocked(nexusTaskFootprint)).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // nexus.brain-anchors
  // -------------------------------------------------------------------------

  describe('query: brain-anchors', () => {
    it('returns LAFS envelope with CodeAnchorResult data on success', async () => {
      vi.mocked(nexusBrainAnchors).mockResolvedValue({
        success: true,
        data: CODE_ANCHOR_RESULT_FIXTURE,
      });

      const result = await handler.query('brain-anchors', { entryId: 'observation:abc123' });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        entryId: 'observation:abc123',
        plasticitySignal: 0,
      });
      expect(vi.mocked(nexusBrainAnchors)).toHaveBeenCalledWith(
        'observation:abc123',
        '/mock/project',
      );
    });

    it('returns E_INVALID_INPUT when entryId param is missing', async () => {
      const result = await handler.query('brain-anchors', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(vi.mocked(nexusBrainAnchors)).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // nexus.why
  // -------------------------------------------------------------------------

  describe('query: why', () => {
    it('returns LAFS envelope with CodeReasonTrace data on success', async () => {
      vi.mocked(nexusWhy).mockResolvedValue({
        success: true,
        data: CODE_REASON_TRACE_FIXTURE,
      });

      const result = await handler.query('why', { symbol: 'nexusAugment' });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        symbolId: 'nexusAugment',
        chain: [],
      });
      expect(vi.mocked(nexusWhy)).toHaveBeenCalledWith('nexusAugment', '/mock/project');
    });

    it('returns E_INVALID_INPUT when symbol param is missing', async () => {
      const result = await handler.query('why', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(vi.mocked(nexusWhy)).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // nexus.impact-full
  // -------------------------------------------------------------------------

  describe('query: impact-full', () => {
    it('returns LAFS envelope with ImpactFullReport data on success', async () => {
      vi.mocked(nexusImpactFull).mockResolvedValue({
        success: true,
        data: IMPACT_FULL_REPORT_FIXTURE,
      });

      const result = await handler.query('impact-full', { symbol: 'nexusAugment' });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        symbolId: 'nexusAugment',
        mergedRiskScore: 'NONE',
      });
      expect(vi.mocked(nexusImpactFull)).toHaveBeenCalledWith('nexusAugment', '/mock/project');
    });

    it('returns E_INVALID_INPUT when symbol param is missing', async () => {
      const result = await handler.query('impact-full', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(vi.mocked(nexusImpactFull)).not.toHaveBeenCalled();
    });

    it('propagates engine error to LAFS envelope', async () => {
      vi.mocked(nexusImpactFull).mockResolvedValue({
        success: false,
        error: { code: 'E_INTERNAL', message: 'living-brain.js not found' },
      });

      const result = await handler.query('impact-full', { symbol: 'foo' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
    });
  });
});
