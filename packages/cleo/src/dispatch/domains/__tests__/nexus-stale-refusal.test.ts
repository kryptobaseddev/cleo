/**
 * Index-sensitive nexus answers carry `data.freshness` and are refused with
 * E_NEXUS_INDEX_STALE when the index trails the base branch by more than
 * `nexus.freshness.maxCommitsBehind` (default 50), or when the target is
 * missing from a stale index (T14008, T13922).
 *
 * @task T14008
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphIndexFreshness } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAssess, mockContext, root } = vi.hoisted(() => ({
  mockAssess: vi.fn(),
  mockContext: vi.fn(),
  root: { path: '' },
}));

vi.mock('@cleocode/core/nexus/freshness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core/nexus/freshness')>()),
  assessNexusFreshnessForQuery: mockAssess,
}));
vi.mock('@cleocode/core/nexus/context', () => ({ nexusContext: mockContext }));
vi.mock('@cleocode/core/nexus/registry.js', () => ({
  resolveNexusQueryProjectId: vi.fn(async (_root: string, id?: string) => id ?? 'proj'),
}));
vi.mock('@cleocode/core/project-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core/project-scope')>()),
  getProjectRoot: vi.fn(() => root.path),
}));

import { NexusHandler } from '../nexus.js';

/** An indexed project `behind` commits behind origin/main. */
function assessment(behind: number, status: GraphIndexFreshness['status'] = 'stale') {
  return {
    staleFiles: new Set<string>(),
    freshness: {
      indexed: true,
      status,
      lastIndexedAt: '2026-09-25T00:00:00.000Z',
      indexedRevision: '8ad8b52',
      baseRef: 'origin/main',
      baseRevision: 'abc1234',
      commitsBehind: behind,
      ageDays: 29,
      fileCount: 10,
      staleFileCount: status === 'stale' ? 3 : 0,
      stalePaths: [],
      refreshCommand: 'cleo nexus analyze',
      refreshEstimate: 'about 1s',
      checkMs: 0,
    } satisfies GraphIndexFreshness,
  };
}

const found = { success: true, data: { matchCount: 1, results: [{ name: 'alpha' }] } };
const none = { success: true, data: { matchCount: 0, results: [] } };

let handler: NexusHandler;

beforeEach(() => {
  root.path = mkdtempSync(join(tmpdir(), 'cleo-nexus-stale-'));
  handler = new NexusHandler();
  mockAssess.mockReset();
  mockContext.mockReset();
  delete process.env['CLEO_NEXUS_ALLOW_STALE'];
});

afterEach(() => {
  delete process.env['CLEO_NEXUS_ALLOW_STALE'];
  rmSync(root.path, { recursive: true, force: true });
});

describe('stale nexus answers (T14008)', () => {
  it('refuses an index past the threshold, naming the reindex command, without answering', async () => {
    mockAssess.mockResolvedValue(assessment(3239));
    mockContext.mockResolvedValue(found);

    const result = await handler.query('context', { symbol: 'alpha', projectId: 'proj' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NEXUS_INDEX_STALE');
    expect(result.error?.message).toContain('3239 commit(s) behind origin/main');
    expect(result.error?.fix).toContain(`cleo nexus analyze ${JSON.stringify(root.path)}`);
    expect(result.error?.details).toMatchObject({ commitsBehind: 3239, maxCommitsBehind: 50 });
    expect(mockContext).not.toHaveBeenCalled();
  });

  it('answers with data.freshness when the caller allows a stale answer', async () => {
    mockAssess.mockResolvedValue(assessment(3239));
    mockContext.mockResolvedValue(found);

    const viaParam = await handler.query('context', {
      symbol: 'alpha',
      projectId: 'proj',
      allowStale: true,
    });
    process.env['CLEO_NEXUS_ALLOW_STALE'] = '1';
    const viaEnv = await handler.query('context', { symbol: 'alpha', projectId: 'proj' });

    for (const result of [viaParam, viaEnv]) {
      expect(result.success).toBe(true);
      expect((result.data as { freshness: unknown }).freshness).toEqual({
        status: 'stale',
        indexedRevision: '8ad8b52',
        baseRef: 'origin/main',
        commitsBehind: 3239,
        ageDays: 29,
        lastIndexedAt: '2026-09-25T00:00:00.000Z',
      });
    }
  });

  it('answers within the threshold and carries the freshness block', async () => {
    mockAssess.mockResolvedValue(assessment(10));
    mockContext.mockResolvedValue(found);

    const result = await handler.query('context', { symbol: 'alpha', projectId: 'proj' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ matchCount: 1, freshness: { commitsBehind: 10 } });
  });

  it('refuses a symbol missing from a stale index, but not from a fresh one', async () => {
    mockContext.mockResolvedValue(none);
    mockAssess.mockResolvedValue(assessment(10));
    const stale = await handler.query('context', { symbol: 'newSymbol', projectId: 'proj' });
    expect(stale.error?.code).toBe('E_NEXUS_INDEX_STALE');
    expect(stale.error?.message).toContain('missing from an index that is stale');

    mockAssess.mockResolvedValue(assessment(0, 'fresh'));
    const fresh = await handler.query('context', { symbol: 'newSymbol', projectId: 'proj' });
    expect(fresh.success).toBe(true);
    expect(fresh.data).toMatchObject({ matchCount: 0, freshness: { commitsBehind: 0 } });
  });
});
