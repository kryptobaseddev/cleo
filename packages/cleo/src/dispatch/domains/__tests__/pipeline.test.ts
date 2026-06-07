import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cleocode/core/internal', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
  getLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
  getAccessor: vi.fn(async () => ({})),
  getTaskAccessor: vi.fn(async () => ({})),
  resolveChannelFromBranch: vi.fn(() => 'stable'),
  channelToDistTag: vi.fn(() => 'latest'),
  describeChannel: vi.fn(() => 'Stable channel'),
  paginate: vi.fn((items: unknown[], limit?: number, offset?: number) => {
    const l = limit ?? items.length;
    const o = offset ?? 0;
    const sliced = items.slice(o, o + l);
    return {
      items: sliced,
      page: {
        mode: l < items.length || o > 0 ? 'offset' : 'none',
        limit: l,
        offset: o,
        hasMore: o + l < items.length,
        total: items.length,
      },
    };
  }),
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
  // releaseShip removed in T9540 (Phase 6 of T9499) — legacy monolith deleted
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

import { phaseList, releaseList } from '../../lib/engine.js';
import { PipelineHandler } from '../pipeline.js';

describe('PipelineHandler operations', () => {
  let handler: PipelineHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new PipelineHandler();
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
