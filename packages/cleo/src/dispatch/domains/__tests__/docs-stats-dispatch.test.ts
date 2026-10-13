/**
 * Verify `cleo docs stats` reaches the core metrics computation through
 * dispatch and returns the canonical envelope (T13363).
 * Code placed in `packages/cleo/` per Package-Boundary Check — verified against AGENTS.md.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { computeDocsStats } = vi.hoisted(() => ({
  computeDocsStats: vi.fn(),
}));
vi.mock('@cleocode/core/internal', () => ({
  getProjectRoot: () => '/fixture/docs-stats',
}));
vi.mock('@cleocode/core/project-scope', async (importOriginal) => {
  const barrel = await import('@cleocode/core/internal');
  return {
    ...(await importOriginal<object>()),
    getProjectRoot: barrel.getProjectRoot,
  };
});
vi.mock('@cleocode/core/docs/stats', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeDocsStats,
}));

import { Dispatcher } from '../../dispatcher.js';
import { DocsHandler } from '../docs.js';

beforeEach(() => {
  vi.clearAllMocks();
  computeDocsStats.mockReset();
});

describe('docs.stats runtime dispatch (T13363)', () => {
  it('routes the registered query to the core metrics computation and wraps the envelope', async () => {
    computeDocsStats.mockResolvedValue({
      addUpdate: { adds: 30, updates: 3, ratio: 10 },
      looseMarkdown: {
        count: 751,
        scannedDirs: ['docs', 'src'],
        excludedDirs: ['node_modules', '.git', '.cleo'],
      },
      wikilinksEdges: 42,
      decisionsLinked: 7,
      generatedAt: '2026-10-12T00:00:00.000Z',
      summary:
        'adds 30 / updates 3 (ratio 10.00); 751 loose markdown files; 42 wikilinks edges; 7 decisions linked',
    });
    const dispatcher = new Dispatcher({ handlers: new Map([['docs', new DocsHandler()]]) });
    const response = await dispatcher.dispatch({
      gateway: 'query',
      domain: 'docs',
      operation: 'stats',
      params: {},
    });
    expect(response.success).toBe(true);
    expect(computeDocsStats).toHaveBeenCalledExactlyOnceWith({
      projectRoot: '/fixture/docs-stats',
    });
    const data = response.data as {
      addUpdate: { adds: number; updates: number; ratio: number | null };
      looseMarkdown: { count: number; scannedDirs: string[]; excludedDirs: string[] };
      wikilinksEdges: number;
      decisionsLinked: number;
    };
    expect(data.addUpdate).toEqual({ adds: 30, updates: 3, ratio: 10 });
    expect(data.looseMarkdown.count).toBe(751);
    expect(data.wikilinksEdges).toBe(42);
    expect(data.decisionsLinked).toBe(7);
    expect(response.meta?.operation).toBe('stats');
  });

  it('preserves metrics computation failures instead of reporting fabricated metrics', async () => {
    computeDocsStats.mockRejectedValue(new Error('fixture audit log unavailable'));
    const dispatcher = new Dispatcher({ handlers: new Map([['docs', new DocsHandler()]]) });
    const response = await dispatcher.dispatch({
      gateway: 'query',
      domain: 'docs',
      operation: 'stats',
      params: {},
    });
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_INTERNAL');
    expect(response.error?.message).toContain('fixture audit log unavailable');
  });
});
