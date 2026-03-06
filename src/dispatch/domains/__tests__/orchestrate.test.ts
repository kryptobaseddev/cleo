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

vi.mock('../../../core/lifecycle/tessera-engine.js', () => ({
  showTessera: vi.fn(),
  listTesseraTemplates: vi.fn(() => []),
  instantiateTessera: vi.fn(),
}));

vi.mock('../../../core/lifecycle/chain-store.js', () => ({
  showChain: vi.fn(),
}));

import { OrchestrateHandler } from '../orchestrate.js';
import { showChain } from '../../../core/lifecycle/chain-store.js';

describe('OrchestrateHandler chain plan operations', () => {
  let handler: OrchestrateHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new OrchestrateHandler();
  });

  it('includes chain.plan in supported query operations', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('chain.plan');
  });

  it('builds wave plan for chain topology', async () => {
    vi.mocked(showChain).mockResolvedValue({
      id: 'chain-1',
      shape: {
        stages: [
          { id: 's1', name: 's1', category: 'research', skippable: false },
          { id: 's2', name: 's2', category: 'implementation', skippable: false },
          { id: 's3', name: 's3', category: 'validation', skippable: false },
        ],
        links: [
          { from: 's1', to: 's2', type: 'linear' },
          { from: 's2', to: 's3', type: 'linear' },
        ],
        entryPoint: 's1',
        exitPoints: ['s3'],
      },
      gates: [{ id: 'g-1' }],
    } as any);

    const result = await handler.query('chain.plan', { chainId: 'chain-1' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      chainId: 'chain-1',
      totalStages: 3,
      totalGates: 1,
      waves: [
        { wave: 1, stageIds: ['s1'] },
        { wave: 2, stageIds: ['s2'] },
        { wave: 3, stageIds: ['s3'] },
      ],
    });
  });

  it('returns invalid input for chain.plan without chainId', async () => {
    const result = await handler.query('chain.plan', {});

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'E_INVALID_INPUT',
      message: 'chainId is required',
    });
    expect(showChain).not.toHaveBeenCalled();
  });

  it('returns not found for chain.plan when chain does not exist', async () => {
    vi.mocked(showChain).mockResolvedValue(null);

    const result = await handler.query('chain.plan', { chainId: 'missing-chain' });

    expect(result.success).toBe(false);
    expect(showChain).toHaveBeenCalledWith('missing-chain', '/mock/project');
    expect(result.error).toMatchObject({
      code: 'E_NOT_FOUND',
      message: 'Chain "missing-chain" not found',
    });
  });
});
