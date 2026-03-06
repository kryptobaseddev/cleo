import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

vi.mock('../../lib/engine.js', () => ({
  lifecycleStatus: vi.fn(),
  lifecycleHistory: vi.fn(),
  lifecycleGates: vi.fn(),
  lifecyclePrerequisites: vi.fn(),
  lifecycleCheck: vi.fn(),
  lifecycleProgress: vi.fn(),
  lifecycleSkip: vi.fn(),
  lifecycleReset: vi.fn(),
  lifecycleGatePass: vi.fn(),
  lifecycleGateFail: vi.fn(),
  releasePrepare: vi.fn(),
  releaseChangelog: vi.fn(),
  releaseCommit: vi.fn(),
  releaseTag: vi.fn(),
  releasePush: vi.fn(),
  releaseGatesRun: vi.fn(),
  releaseRollback: vi.fn(),
}));

vi.mock('../../../core/pipeline/phase.js', () => ({
  showPhase: vi.fn(),
  listPhases: vi.fn(),
}));

vi.mock('../../../core/phases/index.js', () => ({
  setPhase: vi.fn(),
  startPhase: vi.fn(),
  completePhase: vi.fn(),
  advancePhase: vi.fn(),
  renamePhase: vi.fn(),
  deletePhase: vi.fn(),
}));

vi.mock('../../../core/memory/pipeline-manifest-compat.js', () => ({
  pipelineManifestShow: vi.fn(),
  pipelineManifestList: vi.fn(),
  pipelineManifestFind: vi.fn(),
  pipelineManifestPending: vi.fn(),
  pipelineManifestStats: vi.fn(),
  pipelineManifestAppend: vi.fn(),
  pipelineManifestArchive: vi.fn(),
}));

vi.mock('../../../core/lifecycle/chain-store.js', () => ({
  showChain: vi.fn(),
  listChains: vi.fn(),
  findChains: vi.fn(),
  addChain: vi.fn(),
  createInstance: vi.fn(),
  showInstance: vi.fn(),
  advanceInstance: vi.fn(),
}));

import { PipelineHandler } from '../pipeline.js';
import {
  showChain,
  listChains,
  findChains,
  addChain,
  createInstance,
  showInstance,
  advanceInstance,
} from '../../../core/lifecycle/chain-store.js';

describe('PipelineHandler chain operations', () => {
  let handler: PipelineHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new PipelineHandler();
  });

  it('includes chain.find in supported query operations', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('chain.find');
    expect(ops.query).toContain('chain.show');
    expect(ops.query).toContain('chain.list');
    expect(ops.mutate).toContain('chain.add');
    expect(ops.mutate).toContain('chain.gate.pass');
    expect(ops.mutate).toContain('chain.gate.fail');
  });

  it('routes chain.find filters to findChains', async () => {
    vi.mocked(findChains).mockResolvedValue([{ id: 'alpha-chain' }] as any);

    const result = await handler.query('chain.find', {
      query: 'alpha',
      category: 'implementation',
      tessera: 'tessera-alpha',
      archetype: 'lifecycle',
      limit: 5,
    });

    expect(result.success).toBe(true);
    expect(findChains).toHaveBeenCalledWith({
      query: 'alpha',
      category: 'implementation',
      tessera: 'tessera-alpha',
      archetype: 'lifecycle',
      limit: 5,
    }, '/mock/project');
    expect((result.data as Array<{ id: string }>)[0]?.id).toBe('alpha-chain');
  });

  it('keeps chain.list behavior intact', async () => {
    vi.mocked(listChains).mockResolvedValue([{ id: 'chain-1' }, { id: 'chain-2' }] as any);

    const result = await handler.query('chain.list');
    expect(result.success).toBe(true);
    expect(listChains).toHaveBeenCalledWith('/mock/project');
    expect((result.data as Array<{ id: string }>).map((chain) => chain.id)).toEqual(['chain-1', 'chain-2']);
  });

  it('keeps chain.show behavior intact', async () => {
    vi.mocked(showChain).mockResolvedValue({ id: 'chain-1' } as any);

    const result = await handler.query('chain.show', { chainId: 'chain-1' });
    expect(result.success).toBe(true);
    expect(showChain).toHaveBeenCalledWith('chain-1', '/mock/project');
  });

  it('keeps chain.add behavior intact', async () => {
    const chain = {
      id: 'chain-1',
      name: 'Chain 1',
      version: '1.0.0',
      description: 'desc',
      shape: { stages: [], links: [], entryPoint: 'a', exitPoints: ['a'] },
      gates: [],
    };

    const result = await handler.mutate('chain.add', { chain });
    expect(result.success).toBe(true);
    expect(addChain).toHaveBeenCalledWith(chain, '/mock/project');
  });

  it('translates FK constraint errors for chain.instantiate', async () => {
    vi.mocked(createInstance).mockRejectedValue(new Error('SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed'));

    const result = await handler.mutate('chain.instantiate', {
      chainId: 'chain-404',
      epicId: 'T1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'E_NOT_FOUND',
      message: 'Chain "chain-404" not found',
    });
  });

  it('records gate pass for chain instance', async () => {
    vi.mocked(showInstance).mockResolvedValue({
      id: 'wci-1',
      chainId: 'chain-1',
      epicId: 'T1',
      variables: {},
      stageToTask: {},
      status: 'active',
      currentStage: 'implementation',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'system',
    } as any);
    vi.mocked(advanceInstance).mockResolvedValue({
      id: 'wci-1',
      currentStage: 'implementation',
      status: 'active',
    } as any);

    const result = await handler.mutate('chain.gate.pass', {
      instanceId: 'wci-1',
      gateId: 'g-1',
      message: 'passed',
    });

    expect(result.success).toBe(true);
    expect(showInstance).toHaveBeenCalledWith('wci-1', '/mock/project');
    expect(advanceInstance).toHaveBeenCalledWith(
      'wci-1',
      'implementation',
      expect.arrayContaining([
        expect.objectContaining({ gateId: 'g-1', passed: true }),
      ]),
      '/mock/project',
    );
  });

  it('records gate fail for chain instance', async () => {
    vi.mocked(showInstance).mockResolvedValue({
      id: 'wci-1',
      chainId: 'chain-1',
      epicId: 'T1',
      variables: {},
      stageToTask: {},
      status: 'active',
      currentStage: 'implementation',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'system',
    } as any);
    vi.mocked(advanceInstance).mockResolvedValue({
      id: 'wci-1',
      currentStage: 'implementation',
      status: 'active',
    } as any);

    const result = await handler.mutate('chain.gate.fail', {
      instanceId: 'wci-1',
      gateId: 'g-1',
      message: 'failed',
    });

    expect(result.success).toBe(true);
    expect(advanceInstance).toHaveBeenCalledWith(
      'wci-1',
      'implementation',
      expect.arrayContaining([
        expect.objectContaining({ gateId: 'g-1', passed: false }),
      ]),
      '/mock/project',
    );
  });
});
