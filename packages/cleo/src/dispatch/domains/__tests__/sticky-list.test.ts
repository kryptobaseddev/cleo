import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../core/src/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
    '../../../../../core/src/paths.js',
  );
  return {
    ...actual,
    getProjectRoot: vi.fn(() => '/mock/project'),
  };
});

vi.mock('../../../../../core/src/logger.js', () => ({
  getLogger: vi.fn(() => ({
    error: vi.fn(),
  })),
}));

vi.mock('../../engines/sticky-engine.js', () => ({
  stickyAdd: vi.fn(),
  stickyList: vi.fn(),
  stickyListFiltered: vi.fn(),
  stickyShow: vi.fn(),
  stickyConvertToTask: vi.fn(),
  stickyConvertToMemory: vi.fn(),
  stickyConvertToTaskNote: vi.fn(),
  stickyConvertToSessionNote: vi.fn(),
  stickyArchive: vi.fn(),
  stickyPurge: vi.fn(),
}));

import { stickyListFiltered } from '../../engines/sticky-engine.js';
import { StickyHandler } from '../sticky.js';

describe('StickyHandler list compliance', () => {
  let handler: StickyHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new StickyHandler();
  });

  it('returns canonical sticky list envelope with pagination', async () => {
    // stickyListFiltered now handles dual-query + pagination inside the engine
    vi.mocked(stickyListFiltered).mockResolvedValueOnce({
      success: true,
      data: {
        stickies: [{ id: 'SN-2', content: 'second' }],
        total: 4,
        filtered: 2,
      },
      page: { mode: 'offset', limit: 1, offset: 1, hasMore: false, total: 2 },
    } as never);

    const result = await handler.query('list', { status: 'active', limit: 1, offset: 1 });

    expect(result.success).toBe(true);
    expect(stickyListFiltered).toHaveBeenCalledWith(
      '/mock/project',
      { status: 'active', color: undefined, priority: undefined, tags: undefined },
      1,
      1,
    );
    expect(result.data).toEqual({
      stickies: [{ id: 'SN-2', content: 'second' }],
      total: 4,
      filtered: 2,
    });
    expect(result.page).toEqual({ mode: 'offset', limit: 1, offset: 1, hasMore: false, total: 2 });
  });
});
