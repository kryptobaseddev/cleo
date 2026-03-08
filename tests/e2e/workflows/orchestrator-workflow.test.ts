import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchRaw, resetCliDispatcher } from '../../../src/dispatch/adapters/cli.js';

// Mock paths FIRST (before engine mock)
vi.mock('../../../src/core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/paths.js')>();
  return {
    ...actual,
    getProjectRoot: vi.fn(() => '/mock/project'),
  };
});

// Mock CLI output
vi.mock('../../../src/cli/renderers/index.js', () => ({
  cliOutput: vi.fn(),
  cliError: vi.fn(),
}));

// Mock security module
vi.mock('../../../src/mcp/lib/security.js', () => ({
  sanitizeParams: vi.fn((p: Record<string, unknown>) => p),
}));

// Mock orchestrate engine (used by orchestrate domain)
vi.mock('../../../src/dispatch/engines/orchestrate-engine.js', () => ({
  orchestrateStartup: vi.fn(),
  orchestrateSpawn: vi.fn(),
}));

// Mock lifecycle engine (used by pipeline domain for stage.* operations)
vi.mock('../../../src/dispatch/engines/lifecycle-engine.js', () => ({
  lifecycleStatus: vi.fn(() => ({
    success: true,
    data: {
      epicId: 'T2400',
      currentStage: 'implementation',
      stages: [
        { stage: 'research', status: 'completed' },
        { stage: 'consensus', status: 'skipped' },
        { stage: 'specification', status: 'completed' },
        { stage: 'implementation', status: 'in_progress' },
      ],
      nextStage: 'validation',
      blockedOn: [],
    },
  })),
  lifecycleCheck: vi.fn(() => ({ success: true, data: { canProgress: true } })),
}));

// Mock validate engine (used by check domain)
vi.mock('../../../src/dispatch/engines/validate-engine.js', () => ({
  validateComplianceSummary: vi.fn(() => ({
    success: true,
    data: { compliant: true, score: 0.95, violations: [] },
  })),
}));

import { lifecycleCheck, lifecycleStatus } from '../../../src/dispatch/engines/lifecycle-engine.js';
// Import mocked functions AFTER vi.mock calls
import {
  orchestrateSpawn,
  orchestrateStartup,
} from '../../../src/dispatch/engines/orchestrate-engine.js';
import { validateComplianceSummary } from '../../../src/dispatch/engines/validate-engine.js';

describe('11.2 Orchestrator Workflow', () => {
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
    expectedDomain: string,
    expectedOperation: string,
  ) {
    expect(response._meta).toBeDefined();
    expect(response._meta.gateway).toBe(expectedGateway);
    expect(response._meta.domain).toBe(expectedDomain);
    expect(response._meta.operation).toBe(expectedOperation);
    expect(response._meta.timestamp).toBeDefined();
    expect(typeof response._meta.duration_ms).toBe('number');
    expect(response._meta.duration_ms).toBeGreaterThanOrEqual(0);
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
    expect(response.error!.code).toBeDefined();
    expect(response.error!.message).toBeDefined();
    if (expectedCode) {
      expect(response.error!.code).toBe(expectedCode);
    }
  }

  // =========================================================================
  // Test 1: Full Orchestrator Workflow
  // =========================================================================

  it('should execute full orchestrator workflow: start -> status -> spawn -> protocol', async () => {
    // Step 1: Initialize orchestration (cleo_mutate orchestrate start)
    vi.mocked(orchestrateStartup).mockResolvedValueOnce({
      success: true,
      data: {
        epicId: 'T2400',
        sessionId: 'session_orch_1',
        state: 'running',
        initialWave: 1,
      },
    });

    const startupResult = await dispatchRaw('mutate', 'orchestrate', 'start', {
      epicId: 'T2400',
    });

    assertResponseEnvelope(startupResult, 'mutate', 'orchestrate', 'start');
    assertSuccessResponse(startupResult);
    expect((startupResult.data as any).epicId).toBe('T2400');
    expect((startupResult.data as any).state).toBe('running');

    // Step 2: Check lifecycle prerequisites (query pipeline stage status)
    vi.mocked(lifecycleStatus).mockReturnValueOnce({
      success: true,
      data: {
        epicId: 'T2400',
        currentStage: 'implementation',
        stages: [
          { stage: 'research', status: 'completed' },
          { stage: 'consensus', status: 'skipped' },
          { stage: 'specification', status: 'completed' },
          { stage: 'implementation', status: 'in_progress' },
        ],
        nextStage: 'validation',
        blockedOn: [],
      },
    });

    const lifecycleResult = await dispatchRaw('query', 'pipeline', 'stage.status', {
      epicId: 'T2400',
    });

    assertResponseEnvelope(lifecycleResult, 'query', 'pipeline', 'stage.status');
    assertSuccessResponse(lifecycleResult);
    expect((lifecycleResult.data as any).currentStage).toBe('implementation');

    // Step 3: Spawn subagent (cleo_mutate orchestrate spawn)
    vi.mocked(orchestrateSpawn).mockResolvedValueOnce({
      success: true,
      data: {
        taskId: 'T2405',
        skill: 'ct-task-executor',
        prompt: 'Execute implementation task T2405...',
        metadata: {
          epicId: 'T2400',
          wave: 1,
          tokensResolved: true,
        },
      },
    });

    const spawnResult = await dispatchRaw('mutate', 'orchestrate', 'spawn', {
      taskId: 'T2405',
      skill: 'ct-task-executor',
    });

    assertResponseEnvelope(spawnResult, 'mutate', 'orchestrate', 'spawn');
    assertSuccessResponse(spawnResult);
    expect((spawnResult.data as any).taskId).toBe('T2405');
    expect((spawnResult.data as any).metadata.tokensResolved).toBe(true);

    // Step 4: Validate protocol compliance (query check compliance.summary)
    vi.mocked(validateComplianceSummary).mockReturnValueOnce({
      success: true,
      data: {
        compliant: true,
        score: 0.95,
        violations: [],
      },
    });

    const validationResult = await dispatchRaw('query', 'check', 'compliance.summary', {
      protocolType: 'implementation',
      severity: 'error',
    });

    assertResponseEnvelope(validationResult, 'query', 'check', 'compliance.summary');
    assertSuccessResponse(validationResult);
    expect((validationResult.data as any).compliant).toBe(true);

    // Verify all engine functions were called
    expect(orchestrateStartup).toHaveBeenCalledTimes(1);
    expect(lifecycleStatus).toHaveBeenCalledTimes(1);
    expect(orchestrateSpawn).toHaveBeenCalledTimes(1);
    expect(validateComplianceSummary).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // Test 2: Lifecycle Gate Failure
  // =========================================================================

  it('should handle lifecycle gate failure during orchestration', async () => {
    // Start succeeds
    vi.mocked(orchestrateStartup).mockResolvedValueOnce({
      success: true,
      data: {
        epicId: 'T2400',
        state: 'running',
      },
    });

    await dispatchRaw('mutate', 'orchestrate', 'start', {
      epicId: 'T2400',
    });

    // Stage validation reveals missing prerequisites
    vi.mocked(lifecycleCheck).mockReturnValueOnce({
      success: false,
      error: {
        code: 'E_LIFECYCLE_GATE_FAILED',
        message: 'Research stage not completed for epic T2400',
        exitCode: 80,
      },
    });

    const stageResult = await dispatchRaw('query', 'pipeline', 'stage.validate', {
      epicId: 'T2400',
      targetStage: 'implementation',
    });

    assertResponseEnvelope(stageResult, 'query', 'pipeline', 'stage.validate');
    assertErrorResponse(stageResult);
    expect(stageResult.error!.code).toBeDefined();
  });

  // =========================================================================
  // Test 3: epicId Required
  // =========================================================================

  it('should require epicId for orchestrator start', async () => {
    vi.mocked(orchestrateStartup).mockResolvedValueOnce({
      success: false,
      error: {
        code: 'E_INVALID_INPUT',
        message: 'Missing required parameter: epicId',
      },
    });

    const result = await dispatchRaw('mutate', 'orchestrate', 'start', {});

    assertErrorResponse(result, 'E_INVALID_INPUT');
  });
});
