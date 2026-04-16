/**
 * Integration tests for the IvtrHandler dispatch domain.
 *
 * Validates LAFS envelope shape, routing, and error cases.
 * Core state machine logic is tested in ivtr-loop.test.ts.
 *
 * @epic T810
 * @task T811
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

vi.mock('@cleocode/core/internal', () => ({
  startIvtr: vi.fn(),
  advanceIvtr: vi.fn(),
  loopBackIvtr: vi.fn(),
  releaseIvtr: vi.fn(),
  getIvtrState: vi.fn(),
  resolvePhasePrompt: vi.fn(),
  getTask: vi.fn(),
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

import {
  advanceIvtr,
  getIvtrState,
  getTask,
  loopBackIvtr,
  releaseIvtr,
  resolvePhasePrompt,
  startIvtr,
} from '@cleocode/core/internal';

import { IvtrHandler } from '../ivtr.js';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const mockTask = {
  id: 'T999',
  title: 'Test Task',
  description: 'Do the thing',
  status: 'in_progress' as const,
  priority: 'medium' as const,
  depends: [],
};

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
  // mutate: start
  // -----------------------------------------------------------------------

  describe('mutate("start")', () => {
    it('returns E_INVALID_INPUT when taskId is missing', async () => {
      const result = await handler.mutate('start', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('returns E_NOT_FOUND when task does not exist', async () => {
      vi.mocked(getTask).mockResolvedValue(null);

      const result = await handler.mutate('start', { taskId: 'T999' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });

    it('returns resolved prompt on successful start', async () => {
      vi.mocked(getTask).mockResolvedValue(mockTask);
      vi.mocked(startIvtr).mockResolvedValue(mockState);
      vi.mocked(resolvePhasePrompt).mockReturnValue('# IVTR Agent Prompt — implement');

      const result = await handler.mutate('start', { taskId: 'T999' });
      expect(result.success).toBe(true);

      const data = result.data as Record<string, unknown>;
      expect(data['taskId']).toBe('T999');
      expect(data['currentPhase']).toBe('implement');
      expect(data['resolvedPrompt']).toContain('implement');

      expect(startIvtr).toHaveBeenCalledWith(
        'T999',
        expect.objectContaining({ cwd: '/mock/project' }),
      );
    });

    it('conforms to LAFS envelope shape', async () => {
      vi.mocked(getTask).mockResolvedValue(mockTask);
      vi.mocked(startIvtr).mockResolvedValue(mockState);
      vi.mocked(resolvePhasePrompt).mockReturnValue('prompt');

      const result = await handler.mutate('start', { taskId: 'T999' });

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('meta');
      expect(result.meta).toHaveProperty('operation');
      expect(result.meta).toHaveProperty('domain');
      expect(result.meta.domain).toBe('ivtr');
      expect(result.meta.gateway).toBe('mutate');
    });
  });

  // -----------------------------------------------------------------------
  // mutate: next
  // -----------------------------------------------------------------------

  describe('mutate("next")', () => {
    it('advances phase and returns new prompt', async () => {
      const advancedState = {
        ...mockState,
        currentPhase: 'validate' as const,
        phaseHistory: [
          {
            ...mockState.phaseHistory[0]!,
            passed: true,
            completedAt: '2026-04-16T01:00:00.000Z',
          },
          {
            phase: 'validate' as const,
            agentIdentity: null,
            startedAt: '2026-04-16T01:00:00.000Z',
            completedAt: null,
            passed: null,
            evidenceRefs: [],
          },
        ],
      };

      vi.mocked(getTask).mockResolvedValue(mockTask);
      vi.mocked(advanceIvtr).mockResolvedValue(advancedState);
      vi.mocked(resolvePhasePrompt).mockReturnValue('# Validate prompt');

      const result = await handler.mutate('next', {
        taskId: 'T999',
        evidence: 'sha-abc,sha-def',
      });

      expect(result.success).toBe(true);

      const data = result.data as Record<string, unknown>;
      expect(data['currentPhase']).toBe('validate');
      expect(data['resolvedPrompt']).toBe('# Validate prompt');
      expect(advanceIvtr).toHaveBeenCalledWith('T999', ['sha-abc', 'sha-def'], expect.any(Object));
    });
  });

  // -----------------------------------------------------------------------
  // mutate: release
  // -----------------------------------------------------------------------

  describe('mutate("release")', () => {
    it('returns success when gate passes', async () => {
      vi.mocked(releaseIvtr).mockResolvedValue({ released: true });

      const result = await handler.mutate('release', { taskId: 'T999' });
      expect(result.success).toBe(true);

      const data = result.data as Record<string, unknown>;
      expect(data['released']).toBe(true);
    });

    it('returns error envelope when gate fails', async () => {
      vi.mocked(releaseIvtr).mockResolvedValue({
        released: false,
        failures: ["Phase 'test' has no passing entry"],
      });

      const result = await handler.mutate('release', { taskId: 'T999' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_IVTR_GATE_FAILED');
      expect(result.error?.message).toContain("Phase 'test'");
    });
  });

  // -----------------------------------------------------------------------
  // mutate: loop-back
  // -----------------------------------------------------------------------

  describe('mutate("loop-back")', () => {
    it('returns E_INVALID_INPUT when phase is missing or invalid', async () => {
      const result = await handler.mutate('loop-back', {
        taskId: 'T999',
        reason: 'broke',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('--phase must be one of');
    });

    it('returns E_INVALID_INPUT when reason is missing', async () => {
      const result = await handler.mutate('loop-back', {
        taskId: 'T999',
        phase: 'implement',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('--reason is required');
    });

    it('rewinds phase and returns prompt on success', async () => {
      const rewoundState = { ...mockState, currentPhase: 'implement' as const };

      vi.mocked(getTask).mockResolvedValue(mockTask);
      vi.mocked(loopBackIvtr).mockResolvedValue(rewoundState);
      vi.mocked(resolvePhasePrompt).mockReturnValue('# Implement again');

      const result = await handler.mutate('loop-back', {
        taskId: 'T999',
        phase: 'implement',
        reason: 'Tests failed',
        evidence: 'fail-sha',
      });

      expect(result.success).toBe(true);

      const data = result.data as Record<string, unknown>;
      expect(data['loopedBackTo']).toBe('implement');
      expect(data['reason']).toBe('Tests failed');
      expect(data['resolvedPrompt']).toBe('# Implement again');

      expect(loopBackIvtr).toHaveBeenCalledWith(
        'T999',
        'implement',
        'Tests failed',
        ['fail-sha'],
        expect.any(Object),
      );
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
