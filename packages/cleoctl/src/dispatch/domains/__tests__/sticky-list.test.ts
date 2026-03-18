import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

vi.mock('../../../core/logger.js', () => ({
  getLogger: vi.fn(() => ({
    error: vi.fn(),
  })),
}));

vi.mock('../../engines/sticky-engine.js', () => ({
  stickyAdd: vi.fn(),
  stickyList: vi.fn(),
  stickyShow: vi.fn(),
  stickyConvertToTask: vi.fn(),
  stickyConvertToMemory: vi.fn(),
  stickyConvertToTaskNote: vi.fn(),
  stickyConvertToSessionNote: vi.fn(),
  stickyArchive: vi.fn(),
  stickyPurge: vi.fn(),
}));

import { stickyList } from '../../engines/sticky-engine.js';
import { StickyHandler } from '../sticky.js';

describe('StickyHandler list compliance', () => {
  let handler: StickyHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new StickyHandler();
  });

  it('returns canonical sticky list envelope with pagination', async () => {
    vi.mocked(stickyList)
      .mockResolvedValueOnce({
        success: true,
        data: {
          stickies: [
            { id: 'SN-3', content: 'third' },
            { id: 'SN-2', content: 'second' },
          ],
          total: 2,
        },
      } as never)
      .mockResolvedValueOnce({
        success: true,
        data: {
          stickies: [
            { id: 'SN-4', content: 'fourth' },
            { id: 'SN-3', content: 'third' },
            { id: 'SN-2', content: 'second' },
            { id: 'SN-1', content: 'first' },
          ],
          total: 4,
        },
      } as never);

    const result = await handler.query('list', { status: 'active', limit: 1, offset: 1 });

    expect(result.success).toBe(true);
    expect(stickyList).toHaveBeenNthCalledWith(1, '/mock/project', {
      status: 'active',
      color: undefined,
      priority: undefined,
    });
    expect(stickyList).toHaveBeenNthCalledWith(2, '/mock/project', {});
    expect(result.data).toEqual({
      stickies: [{ id: 'SN-2', content: 'second' }],
      total: 4,
      filtered: 2,
    });
    expect(result.page).toEqual({ mode: 'offset', limit: 1, offset: 1, hasMore: false, total: 2 });
  });
});
