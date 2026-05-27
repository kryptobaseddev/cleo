/**
 * Integration tests for the nexus-decorator (T9146 W2).
 *
 * Verifies that every nexus-domain response that goes through the NexusHandler
 * query/mutate path receives a `meta._nexus` block with a valid scope and
 * the correct bindingSource.
 *
 * Also tests the exported helpers: `validateSuggestedNext` (typed-registry
 * gate) and `formatSuggestedNext` (display-string formatter).
 *
 * @task T9146
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @cleocode/core/internal so NexusHandler can be imported without a real DB.
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

import type { NexusScopeMeta } from '@cleocode/contracts';
import {
  nexusContext,
  nexusInitialize,
  nexusListProjects,
  nexusStatus,
} from '@cleocode/core/internal';
import { formatSuggestedNext, validateSuggestedNext } from '../../nexus-decorator.js';
import { NexusHandler } from '../nexus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nexusMeta(response: Awaited<ReturnType<NexusHandler['query']>>): NexusScopeMeta {
  return response.meta['_nexus'] as NexusScopeMeta;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('nexus-decorator (T9146 W2)', () => {
  let handler: NexusHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new NexusHandler();
  });

  // ── meta._nexus presence ──────────────────────────────────────────────────

  describe('meta._nexus is stamped on every query response', () => {
    it('stamps meta._nexus on status (project scope)', async () => {
      vi.mocked(nexusStatus).mockResolvedValue({
        success: true,
        data: { initialized: true, projectCount: 1, lastUpdated: null },
      });

      const result = await handler.query('status', { projectId: 'myproj' });

      expect(result.meta['_nexus']).toBeDefined();
      const m = nexusMeta(result);
      expect(m.scope).toBe('project');
      expect(m.effect).toBe('read');
      expect(m.bindingSource).toBe('arg-project-id');
      expect(m.canonicalCommand).toBe('cleo nexus status');
    });

    it('stamps meta._nexus on list (global scope, no projectId)', async () => {
      vi.mocked(nexusListProjects).mockResolvedValue({
        success: true,
        data: { projects: [] },
      });

      const result = await handler.query('list');

      const m = nexusMeta(result);
      expect(m.scope).toBe('global');
      expect(m.effect).toBe('read');
      expect(m.bindingSource).toBe('none');
      expect(m.projectId).toBeUndefined();
    });

    it('stamps meta._nexus on context (indexSensitive op) with indexFreshness', async () => {
      vi.mocked(nexusContext).mockResolvedValue({
        success: true,
        data: { nodeCount: 100, relationCount: 200, freshness: 'fresh' },
      });

      const result = await handler.query('context', { projectId: 'proj1' });

      const m = nexusMeta(result);
      expect(m.scope).toBe('project');
      expect(m.bindingSource).toBe('arg-project-id');
      // indexSensitive=true — indexFreshness must be present
      expect(m.indexFreshness).toBeDefined();
      expect(['fresh', 'stale', 'unknown']).toContain(m.indexFreshness);
    });
  });

  describe('meta._nexus is stamped on every mutate response', () => {
    it('stamps meta._nexus on init (admin op)', async () => {
      vi.mocked(nexusInitialize).mockResolvedValue({
        success: true,
        data: { initialized: true },
      });

      const result = await handler.mutate('init', { projectId: 'myproj', path: '/some/path' });

      const m = nexusMeta(result);
      expect(m.scope).toBe('project');
      expect(m.effect).toBe('admin');
      expect(m.canonicalCommand).toBe('cleo nexus init');
    });
  });

  // ── bindingSource resolution ───────────────────────────────────────────────

  describe('bindingSource', () => {
    it('resolves to arg-project-id when projectId param is present', async () => {
      vi.mocked(nexusStatus).mockResolvedValue({ success: true, data: {} });
      const result = await handler.query('status', { projectId: 'explicit-id' });
      expect(nexusMeta(result).bindingSource).toBe('arg-project-id');
    });

    it('resolves to arg-path when path param is present but projectId is absent', async () => {
      vi.mocked(nexusStatus).mockResolvedValue({ success: true, data: {} });
      const result = await handler.query('status', { path: '/some/path' });
      expect(nexusMeta(result).bindingSource).toBe('arg-path');
    });

    it('resolves to none for global-scope ops', async () => {
      vi.mocked(nexusListProjects).mockResolvedValue({ success: true, data: { projects: [] } });
      const result = await handler.query('list', {});
      expect(nexusMeta(result).bindingSource).toBe('none');
    });
  });

  // ── canonicalCommand ──────────────────────────────────────────────────────

  describe('canonicalCommand', () => {
    it('always follows cleo nexus <op> pattern', async () => {
      vi.mocked(nexusStatus).mockResolvedValue({ success: true, data: {} });
      const result = await handler.query('status');
      expect(nexusMeta(result).canonicalCommand).toBe('cleo nexus status');
    });
  });

  // ── validateSuggestedNext — typed-registry gate ───────────────────────────

  describe('validateSuggestedNext', () => {
    it('passes for known ops', () => {
      expect(() =>
        validateSuggestedNext([
          {
            op: 'context',
            args: { projectId: 'p1' },
            scope: 'project',
            effect: 'read',
            requiresConfirmation: false,
            reason: 'Check freshness',
          },
        ]),
      ).not.toThrow();
    });

    it('throws TypeError for unknown ops (registry gate)', () => {
      expect(() =>
        validateSuggestedNext([
          {
            op: 'totally-made-up-op',
            args: {},
            scope: 'project',
            effect: 'read',
            requiresConfirmation: false,
            reason: 'test',
          },
        ]),
      ).toThrow(TypeError);
    });
  });

  // ── formatSuggestedNext — display-string formatter ────────────────────────

  describe('formatSuggestedNext', () => {
    it('derives a display string from a structured SuggestedNextOp', () => {
      const s = {
        op: 'context',
        args: { projectId: 'myproj' },
        scope: 'project' as const,
        effect: 'read' as const,
        requiresConfirmation: false,
        reason: 'Verify index freshness',
      };
      const display = formatSuggestedNext(s);
      expect(display).toContain('cleo nexus context');
      expect(display).toContain('--projectId myproj');
      expect(display).toContain('no confirmation needed');
      expect(display).toContain('Verify index freshness');
    });

    it('includes confirm notice when requiresConfirmation=true', () => {
      const s = {
        op: 'sync',
        args: {},
        scope: 'project' as const,
        effect: 'write' as const,
        requiresConfirmation: true,
        reason: 'Will re-index',
      };
      const display = formatSuggestedNext(s);
      expect(display).toContain('confirm before running');
    });
  });
});
