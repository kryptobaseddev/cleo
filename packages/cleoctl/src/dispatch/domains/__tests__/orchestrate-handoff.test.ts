import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

import { orchestrateHandoff } from '../../lib/engine.js';
import { OrchestrateHandler } from '../orchestrate.js';

describe('OrchestrateHandler handoff', () => {
  let handler: OrchestrateHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new OrchestrateHandler();
  });

  it('includes handoff in supported mutate operations', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.mutate).toContain('handoff');
  });

  it('delegates handoff to engine with expected params', async () => {
    vi.mocked(orchestrateHandoff).mockResolvedValue({
      success: true,
      data: { taskId: 'T102', endedSessionId: 'S123' },
    });

    const result = await handler.mutate('handoff', {
      taskId: 'T102',
      protocolType: 'implementation',
      note: 'handoff note',
      nextAction: 'continue',
      variant: 'compact',
      tier: 1,
      idempotencyKey: 'h1',
    });

    expect(result.success).toBe(true);
    expect(orchestrateHandoff).toHaveBeenCalledWith(
      {
        taskId: 'T102',
        protocolType: 'implementation',
        note: 'handoff note',
        nextAction: 'continue',
        variant: 'compact',
        tier: 1,
        idempotencyKey: 'h1',
      },
      '/mock/project',
    );
  });

  it('rejects handoff when protocolType is missing', async () => {
    const result = await handler.mutate('handoff', { taskId: 'T102' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
  });
});
