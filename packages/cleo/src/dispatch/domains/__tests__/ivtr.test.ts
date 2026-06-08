/**
 * Integration tests for the IvtrHandler dispatch domain.
 *
 * Validates LAFS envelope shape, routing, and error cases.
 *
 * After the T11764 state-machine collapse (T11896) the IVTR phase walk lives on
 * the cantbook runtime — the manual `start`/`next`/`release`/`loop-back` mutate
 * ops are DEPRECATED and now return a typed `E_DEPRECATED_USE_PLAYBOOK`
 * migration envelope (ADR-086). The `status` query still reads the retained
 * `ivtr_state` column via `getIvtrState`.
 *
 * @epic T810
 * @task T811
 * @task T11896 — mutate ops redirected onto the cantbook runtime
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock core/internal — must be hoisted before imports
// ---------------------------------------------------------------------------

// Mock the orchestrate engine to prevent live DB calls when OrchestrateHandler is imported
vi.mock('../../lib/engine.js', () => ({
  orchestrateStatus: vi.fn(),
  orchestrateAnalyze: vi.fn(),
  orchestrateReady: vi.fn(),
  orchestrateNext: vi.fn(),
  orchestrateWaves: vi.fn(),
  orchestrateContext: vi.fn(),
  orchestrateBootstrap: vi.fn(),
  orchestrateUnblockOpportunities: vi.fn(),
  orchestrateCriticalPath: vi.fn(),
  orchestrateStartup: vi.fn(),
  orchestrateSpawn: vi.fn(),
  orchestrateHandoff: vi.fn(),
  orchestrateSpawnExecute: vi.fn(),
  orchestrateValidate: vi.fn(),
  orchestrateParallelStart: vi.fn(),
  orchestrateParallelEnd: vi.fn(),
  orchestrateCheck: vi.fn(),
}));

// The handler now imports only the read path + logging/paths from core/internal
// (the walk functions were deleted in T11896 — the mutate ops are deprecated).
vi.mock('@cleocode/core/internal', () => ({
  getIvtrState: vi.fn(),
  getProjectRoot: vi.fn(() => '/mock/project'),
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getIvtrState } from '@cleocode/core/internal';

import { E_DEPRECATED_USE_PLAYBOOK, IvtrHandler } from '../ivtr.js';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const mockState = {
  taskId: 'T999',
  currentPhase: 'implement' as const,
  phaseHistory: [
    {
      phase: 'implement' as const,
      agentIdentity: null,
      startedAt: '2026-04-16T00:00:00.000Z',
      completedAt: null,
      passed: null,
      evidenceRefs: [],
    },
  ],
  startedAt: '2026-04-16T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IvtrHandler', () => {
  let handler: IvtrHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new IvtrHandler();
  });

  // -----------------------------------------------------------------------
  // getSupportedOperations
  // -----------------------------------------------------------------------

  it('declares expected query and mutate operations', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('status');
    expect(ops.mutate).toContain('start');
    expect(ops.mutate).toContain('next');
    expect(ops.mutate).toContain('release');
    expect(ops.mutate).toContain('loop-back');
  });

  // -----------------------------------------------------------------------
  // query: status
  // -----------------------------------------------------------------------

  describe('query("status")', () => {
    it('returns E_INVALID_INPUT when taskId is missing', async () => {
      const result = await handler.query('status', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('returns started:false when no IVTR state exists', async () => {
      vi.mocked(getIvtrState).mockResolvedValue(null);

      const result = await handler.query('status', { taskId: 'T999' });
      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)['started']).toBe(false);
      expect((result.data as Record<string, unknown>)['currentPhase']).toBeNull();
    });

    it('returns full state when IVTR loop is active', async () => {
      vi.mocked(getIvtrState).mockResolvedValue(mockState);

      const result = await handler.query('status', { taskId: 'T999' });
      expect(result.success).toBe(true);

      const data = result.data as Record<string, unknown>;
      expect(data['started']).toBe(true);
      expect(data['currentPhase']).toBe('implement');
      expect(data['phaseHistory']).toHaveLength(1);
      expect(data['evidenceCount']).toBe(0);
    });

    it('meta envelope has correct domain and operation', async () => {
      vi.mocked(getIvtrState).mockResolvedValue(null);

      const result = await handler.query('status', { taskId: 'T999' });
      expect(result.meta.domain).toBe('ivtr');
      expect(result.meta.operation).toBe('status');
    });
  });

  // -----------------------------------------------------------------------
  // mutate ops — DEPRECATED (T11896 · cantbook-runtime collapse)
  //
  // start/next/release/loop-back no longer drive the hand-rolled phase walk.
  // Each returns the typed E_DEPRECATED_USE_PLAYBOOK migration envelope with an
  // ADR-086 hint (fix + details.migration + alternatives). No core walk
  // function is invoked — the behaviour is intentionally removed, not weakened.
  // -----------------------------------------------------------------------

  describe.each([
    'start',
    'next',
    'release',
    'loop-back',
  ] as const)('mutate("%s") is deprecated', (op) => {
    it(`returns ${E_DEPRECATED_USE_PLAYBOOK} with a migration hint`, async () => {
      const result = await handler.mutate(op, { taskId: 'T999' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(E_DEPRECATED_USE_PLAYBOOK);
      // The message routes the caller onto the cantbook runtime.
      expect(result.error?.message).toContain('cleo go');
      expect(result.error?.message).toContain('cleo playbook run ivtr');
    });

    it('carries the ADR-086 fix + details.migration + alternatives payload', async () => {
      const result = await handler.mutate(op, { taskId: 'T999' });

      // Copy-paste fix (the manual single-run command, woven with taskId).
      expect(result.error?.fix).toContain('cleo playbook run ivtr');
      expect(result.error?.fix).toContain('T999');

      // Structured migration details (machine-routable per ADR-086).
      const migration = (result.error?.details as Record<string, unknown> | undefined)?.[
        'migration'
      ] as Record<string, unknown> | undefined;
      expect(migration?.['deprecatedBy']).toBe('T11764-state-machine-collapse');
      expect(migration?.['deprecatedOp']).toBe(op);
      expect(migration?.['taskId']).toBe('T999');
      expect(migration?.['autonomous']).toBe('cleo go');

      // Alternatives forwarded onto the dispatch error.
      const alternatives = result.error?.alternatives;
      expect(Array.isArray(alternatives)).toBe(true);
      expect(alternatives?.map((a) => a.command)).toContain('cleo go');
    });

    it('conforms to the LAFS mutate envelope shape', async () => {
      const result = await handler.mutate(op, { taskId: 'T999' });

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('meta');
      expect(result.meta.domain).toBe('ivtr');
      expect(result.meta.gateway).toBe('mutate');
    });

    it('does NOT invoke any core IVTR walk function', async () => {
      await handler.mutate(op, { taskId: 'T999' });
      // getIvtrState is the only retained core read — the deprecated mutate
      // path never touches it (or any deleted walk function).
      expect(getIvtrState).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // OrchestrateHandler ivtr.* routing (smoke test)
  // -----------------------------------------------------------------------

  describe('OrchestrateHandler ivtr.* routing', () => {
    it('OrchestrateHandler declares ivtr operations in getSupportedOperations', async () => {
      const { OrchestrateHandler } = await import('../orchestrate.js');
      const orchHandler = new OrchestrateHandler();
      const ops = orchHandler.getSupportedOperations();

      expect(ops.query).toContain('ivtr.status');
      expect(ops.mutate).toContain('ivtr.start');
      expect(ops.mutate).toContain('ivtr.next');
      expect(ops.mutate).toContain('ivtr.release');
      expect(ops.mutate).toContain('ivtr.loop-back');
    });
  });
});
