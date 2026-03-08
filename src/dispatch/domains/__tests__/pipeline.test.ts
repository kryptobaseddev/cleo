import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

vi.mock('../../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(async () => ({})),
}));

vi.mock('../../lib/engine.js', () => ({
  lifecycleStatus: vi.fn(),
  lifecycleHistory: vi.fn(),
  lifecycleCheck: vi.fn(),
  lifecycleProgress: vi.fn(),
  lifecycleSkip: vi.fn(),
  lifecycleReset: vi.fn(),
  lifecycleGatePass: vi.fn(),
  lifecycleGateFail: vi.fn(),
  releaseRollback: vi.fn(),
  releaseShip: vi.fn(),
  releaseList: vi.fn(),
  releaseShow: vi.fn(),
  releaseCancel: vi.fn(),
  phaseList: vi.fn(),
  phaseShow: vi.fn(),
  phaseSet: vi.fn(),
  phaseStart: vi.fn(),
  phaseComplete: vi.fn(),
  phaseAdvance: vi.fn(),
  phaseRename: vi.fn(),
  phaseDelete: vi.fn(),
  pipelineManifestShow: vi.fn(),
  pipelineManifestList: vi.fn(),
  pipelineManifestFind: vi.fn(),
  pipelineManifestStats: vi.fn(),
  pipelineManifestAppend: vi.fn(),
  pipelineManifestArchive: vi.fn(),
}));

// Mock release channel functions
vi.mock('../../../core/release/channel.js', () => ({
  resolveChannelFromBranch: vi.fn(() => 'stable'),
  channelToDistTag: vi.fn(() => 'latest'),
  describeChannel: vi.fn(() => 'Stable channel'),
}));

vi.mock('../../../core/lifecycle/chain-store.js', () => ({
  showChain: vi.fn(),
  listChains: vi.fn(),
  addChain: vi.fn(),
  createInstance: vi.fn(),
  advanceInstance: vi.fn(),
}));

import {
  addChain,
  createInstance,
  listChains,
  showChain,
} from '../../../core/lifecycle/chain-store.js';
import { phaseList, releaseList } from '../../lib/engine.js';
import { PipelineHandler } from '../pipeline.js';

describe('PipelineHandler chain operations', () => {
  let handler: PipelineHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new PipelineHandler();
  });

  it('includes chain operations in supported operations', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('chain.show');
    expect(ops.query).toContain('chain.list');
    expect(ops.mutate).toContain('chain.add');
    expect(ops.mutate).toContain('chain.instantiate');
    expect(ops.mutate).toContain('chain.advance');
  });

  it('keeps chain.list behavior intact', async () => {
    vi.mocked(listChains).mockResolvedValue([{ id: 'chain-1' }, { id: 'chain-2' }] as any);

    const result = await handler.query('chain.list', { limit: 1, offset: 1 });
    expect(result.success).toBe(true);
    expect(listChains).toHaveBeenCalledWith('/mock/project');
    expect(result.data).toEqual({
      chains: [{ id: 'chain-2' }],
      total: 2,
      filtered: 2,
    });
    expect(result.page).toEqual({ mode: 'offset', limit: 1, offset: 1, hasMore: false, total: 2 });
  });

  it('keeps chain.show behavior intact', async () => {
    vi.mocked(showChain).mockResolvedValue({ id: 'chain-1' } as any);

    const result = await handler.query('chain.show', { chainId: 'chain-1' });
    expect(result.success).toBe(true);
    expect(showChain).toHaveBeenCalledWith('chain-1', '/mock/project');
  });

  it('returns canonical phase.list envelope while preserving summary', async () => {
    vi.mocked(phaseList).mockResolvedValue({
      success: true,
      data: {
        currentPhase: 'implementation',
        phases: [
          {
            slug: 'research',
            name: 'Research',
            order: 1,
            status: 'completed',
            startedAt: null,
            completedAt: null,
            isCurrent: false,
          },
          {
            slug: 'implementation',
            name: 'Implementation',
            order: 2,
            status: 'active',
            startedAt: null,
            completedAt: null,
            isCurrent: true,
          },
        ],
        summary: {
          total: 2,
          pending: 0,
          active: 1,
          completed: 1,
        },
      },
    } as any);

    const result = await handler.query('phase.list', { limit: 1, offset: 1 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      currentPhase: 'implementation',
      phases: [
        {
          slug: 'implementation',
          name: 'Implementation',
          order: 2,
          status: 'active',
          startedAt: null,
          completedAt: null,
          isCurrent: true,
        },
      ],
      summary: {
        total: 2,
        pending: 0,
        active: 1,
        completed: 1,
      },
      total: 2,
      filtered: 2,
    });
    expect(result.page).toEqual({ mode: 'offset', limit: 1, offset: 1, hasMore: false, total: 2 });
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
    vi.mocked(createInstance).mockRejectedValue(
      new Error('SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed'),
    );

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

  it('surfaces release.list page metadata and filters', async () => {
    vi.mocked(releaseList).mockResolvedValue({
      success: true,
      data: {
        releases: [{ version: 'v1.0.0' }],
        total: 2,
        filtered: 1,
        latest: 'v1.0.0',
      },
      page: { mode: 'offset', limit: 1, offset: 0, hasMore: false, total: 1 },
    } as any);

    const result = await handler.query('release.list', { status: 'prepared', limit: 1 });

    expect(result.success).toBe(true);
    expect(releaseList).toHaveBeenCalledWith(
      { status: 'prepared', limit: 1, offset: undefined },
      '/mock/project',
    );
    expect((result.data as { filtered: number }).filtered).toBe(1);
    expect(result.page).toEqual({ mode: 'offset', limit: 1, offset: 0, hasMore: false, total: 1 });
  });
});
