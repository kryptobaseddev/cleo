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

/**
 * An indexed project `behindHead` commits behind its checked-out HEAD, and
 * `behindBase` (default the same) behind origin/main.
 */
function assessment(
  behindHead: number,
  status: GraphIndexFreshness['status'] = 'stale',
  behindBase = behindHead,
) {
  return {
    staleFiles: new Set<string>(),
    freshness: {
      indexed: true,
      status,
      lastIndexedAt: '2026-09-25T00:00:00.000Z',
      indexedRevision: '8ad8b52',
      baseRef: 'origin/main',
      baseRevision: 'abc1234',
      commitsBehind: behindBase,
      commitsBehindHead: behindHead,
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
    expect(result.error?.message).toContain('3239 commit(s) behind the checked-out HEAD');
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
        commitsBehindHead: 3239,
        changedFilesSinceIndex: null,
        refreshCooldownUntil: null,
        ageDays: 29,
        lastIndexedAt: '2026-09-25T00:00:00.000Z',
        missingFileCount: null,
        missingPaths: [],
      });
    }
  });

  it('carries indexed files gone from disk in data.freshness (T14021)', async () => {
    const withMissing = assessment(10);
    mockAssess.mockResolvedValue({
      ...withMissing,
      freshness: {
        ...withMissing.freshness,
        missingFileCount: 2,
        missingPaths: ['clone/a.ts', 'clone/b.ts'],
      },
    });
    mockContext.mockResolvedValue(found);

    const result = await handler.query('context', { symbol: 'alpha', projectId: 'proj' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      freshness: { missingFileCount: 2, missingPaths: ['clone/a.ts', 'clone/b.ts'] },
    });
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
    expect(stale.error?.message).toContain('missing from an index that is stale for this checkout');

    // Fresh for this checkout, though its branch is far behind main: a genuine no-match.
    mockAssess.mockResolvedValue(assessment(0, 'fresh', 3239));
    const fresh = await handler.query('context', { symbol: 'newSymbol', projectId: 'proj' });
    expect(fresh.success).toBe(true);
    expect(fresh.data).toMatchObject({
      matchCount: 0,
      freshness: { commitsBehindHead: 0, commitsBehind: 3239 },
    });
  });

  it('a fresh index on a branch or worktree far behind main answers normally', async () => {
    // Reindexed where it stands after main moved on: nothing to refuse.
    mockAssess.mockResolvedValue(assessment(0, 'fresh', 3239));
    mockContext.mockResolvedValue(found);

    const result = await handler.query('context', { symbol: 'alpha', projectId: 'proj' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ matchCount: 1, freshness: { commitsBehind: 3239 } });
  });
});
