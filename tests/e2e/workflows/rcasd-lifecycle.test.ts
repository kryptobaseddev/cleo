/**
 * E2E RCASD-IVTR+C Lifecycle Stage Transition Tests
 *
 * Tests the full RCASD-IVTR+C lifecycle pipeline through the dispatch layer.
 * All 9 stages: Research → Consensus → Architecture Decision → Specification →
 * Decomposition → Implementation → Validation → Testing → Release
 *
 * @task T5205
 * @epic T5194
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchRaw, resetCliDispatcher } from '../../../src/dispatch/adapters/cli.js';

// Mock paths
vi.mock('../../../src/core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/paths.js')>();
  return {
    ...actual,
    getProjectRoot: vi.fn(() => '/mock/project'),
  };
});

// Mock lifecycle engine (sync functions)
vi.mock('../../../src/dispatch/engines/lifecycle-engine.js', () => ({
  lifecycleStatus: vi.fn(() => ({ success: true, data: { currentStage: 'research', stages: {} } })),
  lifecycleHistory: vi.fn(() => ({ success: true, data: { history: [] } })),
  lifecycleGates: vi.fn(() => ({ success: true, data: { gates: [] } })),
  lifecyclePrerequisites: vi.fn(() => ({ success: true, data: { prerequisites: [] } })),
  lifecycleCheck: vi.fn(() => ({ success: true, data: { canProgress: true } })),
  lifecycleProgress: vi.fn(() => ({ success: true, data: { recorded: true } })),
  lifecycleSkip: vi.fn(() => ({ success: true, data: { skipped: true } })),
  lifecycleReset: vi.fn(() => ({ success: true, data: { reset: true } })),
  lifecycleGatePass: vi.fn(() => ({ success: true, data: { passed: true } })),
  lifecycleGateFail: vi.fn(() => ({ success: true, data: { failed: true } })),
}));

import {
  lifecycleCheck,
  lifecycleGateFail,
  lifecycleProgress,
  lifecycleStatus,
} from '../../../src/dispatch/engines/lifecycle-engine.js';

describe('RCASD-IVTR+C Lifecycle Stage Transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCliDispatcher();
  });

  // =========================================================================
  // Helper Functions
  // =========================================================================

  function assertResponseEnvelope(
    response: any,
    expectedGateway: string,
    expectedOperation: string,
  ) {
    expect(response._meta).toBeDefined();
    expect(response._meta.gateway).toBe(expectedGateway);
    expect(response._meta.domain).toBe('pipeline');
    expect(response._meta.operation).toBe(expectedOperation);
    expect(response._meta.timestamp).toBeDefined();
    expect(typeof response._meta.duration_ms).toBe('number');
    expect(typeof response.success).toBe('boolean');
  }

  function assertSuccessResponse(response: any) {
    expect(response.success).toBe(true);
    expect(response.data).toBeDefined();
    expect(response.error).toBeUndefined();
  }

  function assertErrorResponse(response: any, expectedCode?: string) {
    expect(response.success).toBe(false);
    expect(response.error).toBeDefined();
    if (expectedCode) {
      expect(response.error.code).toBe(expectedCode);
    }
  }

  // =========================================================================
  // Stage 1: Research
  // =========================================================================

  describe('Stage 1: Research', () => {
    it('should query research stage status', async () => {
      vi.mocked(lifecycleStatus).mockReturnValue({
        success: true,
        data: {
          epicId: 'T5000',
          currentStage: 'research',
          stages: {
            research: { status: 'in_progress', startedAt: new Date().toISOString() },
          },
        },
      } as any);

      const result = await dispatchRaw('query', 'pipeline', 'stage.status', {
        epicId: 'T5000',
      });

      assertResponseEnvelope(result, 'query', 'stage.status');
      assertSuccessResponse(result);
      expect((result.data as any).currentStage).toBe('research');
    });

    it('should record research completion', async () => {
      vi.mocked(lifecycleProgress).mockReturnValue({
        success: true,
        data: {
          recorded: true,
          stage: 'research',
          status: 'completed',
        },
      } as any);

      const result = await dispatchRaw('mutate', 'pipeline', 'stage.record', {
        taskId: 'T5000',
        stage: 'research',
        status: 'completed',
        notes: 'Research findings documented',
      });

      assertResponseEnvelope(result, 'mutate', 'stage.record');
      assertSuccessResponse(result);
      expect((result.data as any).recorded).toBe(true);
    });
  });

  // =========================================================================
  // Stage 2: Consensus
  // =========================================================================

  describe('Stage 2: Consensus', () => {
    it('should transition to consensus stage', async () => {
      vi.mocked(lifecycleStatus).mockReturnValue({
        success: true,
        data: {
          epicId: 'T5000',
          currentStage: 'consensus',
          stages: {
            research: { status: 'completed' },
            consensus: { status: 'in_progress' },
          },
        },
      } as any);

      const result = await dispatchRaw('query', 'pipeline', 'stage.status', {
        epicId: 'T5000',
      });

      assertSuccessResponse(result);
      expect((result.data as any).currentStage).toBe('consensus');
    });

    it('should validate consensus prerequisites', async () => {
      vi.mocked(lifecycleCheck).mockReturnValue({
        success: true,
        data: {
          canProgress: true,
          prerequisitesMet: true,
          requiredStages: ['research'],
        },
      } as any);

      const result = await dispatchRaw('query', 'pipeline', 'stage.validate', {
        epicId: 'T5000',
        targetStage: 'consensus',
      });

      assertResponseEnvelope(result, 'query', 'stage.validate');
      assertSuccessResponse(result);
      expect((result.data as any).canProgress).toBe(true);
    });
  });

  // =========================================================================
  // Stage 3: Architecture Decision
  // =========================================================================

  describe('Stage 3: Architecture Decision (ADR)', () => {
    it('should record ADR creation', async () => {
      vi.mocked(lifecycleProgress).mockReturnValue({
        success: true,
        data: {
          recorded: true,
          stage: 'architecture_decision',
          status: 'completed',
          adrId: 'ADR-001',
        },
      } as any);

      const result = await dispatchRaw('mutate', 'pipeline', 'stage.record', {
        taskId: 'T5000',
        stage: 'architecture_decision',
        status: 'completed',
        notes: 'ADR-001: Use SQLite for persistence',
      });

      assertSuccessResponse(result);
      expect((result.data as any).recorded).toBe(true);
    });
  });

  // =========================================================================
  // Stage 4: Specification
  // =========================================================================

  describe('Stage 4: Specification', () => {
    it('should check specification prerequisites', async () => {
      vi.mocked(lifecycleCheck).mockReturnValue({
        success: true,
        data: {
          canProgress: true,
          prerequisitesMet: true,
          requiredStages: ['research', 'consensus', 'architecture_decision'],
        },
      } as any);

      const result = await dispatchRaw('query', 'pipeline', 'stage.validate', {
        epicId: 'T5000',
        targetStage: 'specification',
      });

      assertSuccessResponse(result);
      expect((result.data as any).prerequisitesMet).toBe(true);
    });
  });

  // =========================================================================
  // Stage 5: Decomposition
  // =========================================================================

  describe('Stage 5: Decomposition', () => {
    it('should record decomposition with subtasks', async () => {
      vi.mocked(lifecycleProgress).mockReturnValue({
        success: true,
        data: {
          recorded: true,
          stage: 'decomposition',
          status: 'completed',
          subtasks: ['T5001', 'T5002', 'T5003'],
        },
      } as any);

      const result = await dispatchRaw('mutate', 'pipeline', 'stage.record', {
        taskId: 'T5000',
        stage: 'decomposition',
        status: 'completed',
        notes: 'Decomposed into 3 subtasks: T5001, T5002, T5003',
      });

      assertSuccessResponse(result);
      expect((result.data as any).subtasks).toHaveLength(3);
    });
  });

  // =========================================================================
  // Stage 6: Implementation
  // =========================================================================

  describe('Stage 6: Implementation', () => {
    it('should track implementation progress', async () => {
      vi.mocked(lifecycleStatus).mockReturnValue({
        success: true,
        data: {
          epicId: 'T5000',
          currentStage: 'implementation',
          stages: {
            research: { status: 'completed' },
            consensus: { status: 'completed' },
            architecture_decision: { status: 'completed' },
            specification: { status: 'completed' },
            decomposition: { status: 'completed' },
            implementation: { status: 'in_progress', progress: 75 },
          },
        },
      } as any);

      const result = await dispatchRaw('query', 'pipeline', 'stage.status', {
        epicId: 'T5000',
      });

      assertSuccessResponse(result);
      expect((result.data as any).stages.implementation.status).toBe('in_progress');
    });
  });

  // =========================================================================
  // Stage 7: Validation
  // =========================================================================

  describe('Stage 7: Validation', () => {
    it('should pass validation gates', async () => {
      vi.mocked(lifecycleProgress).mockReturnValue({
        success: true,
        data: {
          recorded: true,
          stage: 'validation',
          status: 'completed',
          validatedBy: 'agent-1',
          validationResult: 'pass',
        },
      } as any);

      const result = await dispatchRaw('mutate', 'pipeline', 'stage.record', {
        taskId: 'T5000',
        stage: 'validation',
        status: 'completed',
        notes: 'Validated against specification ADR-001',
      });

      assertSuccessResponse(result);
      expect((result.data as any).validationResult).toBe('pass');
    });
  });

  // =========================================================================
  // Stage 8: Testing
  // =========================================================================

  describe('Stage 8: Testing', () => {
    it('should record test results', async () => {
      vi.mocked(lifecycleProgress).mockReturnValue({
        success: true,
        data: {
          recorded: true,
          stage: 'testing',
          status: 'completed',
          testResults: {
            passed: 42,
            failed: 0,
            skipped: 2,
            coverage: 87.5,
          },
        },
      } as any);

      const result = await dispatchRaw('mutate', 'pipeline', 'stage.record', {
        taskId: 'T5000',
        stage: 'testing',
        status: 'completed',
        notes: 'All tests passing, 87.5% coverage',
      });

      assertSuccessResponse(result);
      expect((result.data as any).testResults.passed).toBe(42);
      expect((result.data as any).testResults.coverage).toBe(87.5);
    });
  });

  // =========================================================================
  // Stage 9: Release
  // =========================================================================

  describe('Stage 9: Release', () => {
    it('should complete release stage', async () => {
      vi.mocked(lifecycleProgress).mockReturnValue({
        success: true,
        data: {
          recorded: true,
          stage: 'release',
          status: 'completed',
          version: '1.0.0',
          releaseDate: new Date().toISOString(),
        },
      } as any);

      const result = await dispatchRaw('mutate', 'pipeline', 'stage.record', {
        taskId: 'T5000',
        stage: 'release',
        status: 'completed',
        notes: 'Released v1.0.0',
      });

      assertSuccessResponse(result);
      expect((result.data as any).version).toBe('1.0.0');
    });
  });

  // =========================================================================
  // Gate Enforcement Tests
  // =========================================================================

  describe('Gate Enforcement', () => {
    it('should block transition when prerequisites not met', async () => {
      vi.mocked(lifecycleCheck).mockReturnValue({
        success: false,
        error: {
          code: 'E_LIFECYCLE_GATE_FAILED',
          message: 'Prerequisites not met for implementation',
          exitCode: 80,
        },
      } as any);

      const result = await dispatchRaw('query', 'pipeline', 'stage.validate', {
        epicId: 'T5000',
        targetStage: 'implementation',
      });

      assertErrorResponse(result, 'E_LIFECYCLE_GATE_FAILED');
    });

    it('should record gate failure', async () => {
      vi.mocked(lifecycleGateFail).mockReturnValue({
        success: true,
        data: {
          failed: true,
          gateName: 'spec-review',
          reason: 'Missing acceptance criteria',
          timestamp: new Date().toISOString(),
        },
      } as any);

      const result = await dispatchRaw('mutate', 'pipeline', 'stage.gate.fail', {
        taskId: 'T5000',
        gateName: 'spec-review',
        reason: 'Missing acceptance criteria',
      });

      assertSuccessResponse(result);
      expect((result.data as any).failed).toBe(true);
    });

    it('should get gate status for all stages', async () => {
      const result = await dispatchRaw('query', 'pipeline', 'stage.gates', {
        taskId: 'T5000',
      });

      assertResponseEnvelope(result, 'query', 'stage.gates');
      // Mock returns success, actual gates data structure depends on implementation
      expect(result.success).toBe(true);
    });
  });

  // =========================================================================
  // Cross-Cutting: Contribution Protocol
  // =========================================================================

  describe('Cross-Cutting: Contribution Protocol', () => {
    it('should get stage prerequisites', async () => {
      const result = await dispatchRaw('query', 'pipeline', 'stage.prerequisites', {
        targetStage: 'implementation',
      });

      assertResponseEnvelope(result, 'query', 'stage.prerequisites');
      assertSuccessResponse(result);
    });

    it('should get stage transition history', async () => {
      const result = await dispatchRaw('query', 'pipeline', 'stage.history', {
        taskId: 'T5000',
      });

      assertResponseEnvelope(result, 'query', 'stage.history');
      assertSuccessResponse(result);
    });
  });
});
