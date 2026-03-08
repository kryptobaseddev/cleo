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

import { listTesseraTemplates } from '../../../core/lifecycle/tessera-engine.js';
import { OrchestrateHandler } from '../orchestrate.js';

describe('OrchestrateHandler operations', () => {
  let handler: OrchestrateHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new OrchestrateHandler();
  });

  it('does not include chain.plan in supported query operations (removed)', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query).not.toContain('chain.plan');
    // Verify expected ops are present
    expect(ops.query).toContain('status');
    expect(ops.query).toContain('analyze');
    expect(ops.query).toContain('tessera.list');
    expect(ops.mutate).toContain('parallel');
    expect(ops.mutate).toContain('tessera.instantiate');
  });

  it('returns canonical tessera list envelope', async () => {
    vi.mocked(listTesseraTemplates).mockReturnValue([
      { id: 'tessera-1', name: 'One' },
      { id: 'tessera-2', name: 'Two' },
    ] as any);

    const result = await handler.query('tessera.list', { limit: 1, offset: 1 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      templates: [{ id: 'tessera-2', name: 'Two' }],
      count: 2,
      total: 2,
      filtered: 2,
    });
    expect(result.page).toEqual({ mode: 'offset', limit: 1, offset: 1, hasMore: false, total: 2 });
  });

  it('returns E_INVALID_OPERATION for chain.plan (removed from orchestrate)', async () => {
    const result = await handler.query('chain.plan', { chainId: 'chain-1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_OPERATION');
  });
});
