/**
 * `cleo nexus impact` (the direct CLI path, not dispatch) refuses a stale index
 * with exit 111 and the reindex fix, answers a fresh index on a branch far
 * behind main, and treats a target missing from a stale index as stale
 * (T14008, T13922).
 *
 * @task T14008
 */

import type { GraphIndexFreshness } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAssess, mockImpact, mockCliError, mockCliOutput } = vi.hoisted(() => ({
  mockAssess: vi.fn(),
  mockImpact: vi.fn(),
  mockCliError: vi.fn(),
  mockCliOutput: vi.fn(),
}));

vi.mock('@cleocode/core/nexus/freshness.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core/nexus/freshness.js')>()),
  assessNexusFreshnessForQuery: mockAssess,
  readNexusStalePolicy: vi.fn(async (_root: string, options: { allowStale?: boolean }) => ({
    maxCommitsBehind: 50,
    allowStale: options.allowStale === true,
  })),
}));
vi.mock('@cleocode/core/nexus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core/nexus')>()),
  getSymbolImpact: mockImpact,
}));
vi.mock('@cleocode/core/nexus/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core/nexus/registry.js')>()),
  resolveNexusQueryProjectId: vi.fn(async () => 'proj'),
}));
vi.mock('@cleocode/core/project-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core/project-scope')>()),
  getProjectRoot: vi.fn(() => '/repo'),
}));
vi.mock('../../renderers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../renderers/index.js')>()),
  cliError: mockCliError,
  cliOutput: mockCliOutput,
}));

import { nexusCommand } from '../nexus.js';

/** Freshness `behindHead` commits behind HEAD and `behindBase` behind origin/main. */
function assessment(behindHead: number, behindBase: number, status: GraphIndexFreshness['status']) {
  return {
    staleFiles: new Set<string>(),
    freshness: {
      indexed: true,
      status,
      lastIndexedAt: '2026-10-24T00:00:00.000Z',
      indexedRevision: 'abc1234',
      baseRef: 'origin/main',
      baseRevision: 'def5678',
      commitsBehind: behindBase,
      commitsBehindHead: behindHead,
      ageDays: 0,
      fileCount: 10,
      staleFileCount: status === 'stale' ? 2 : 0,
      stalePaths: [],
      refreshCommand: 'cleo nexus analyze',
      refreshEstimate: 'about 1s',
      checkMs: 0,
    } satisfies GraphIndexFreshness,
  };
}

/** Run `cleo nexus impact <symbol>` with extra flags. */
async function impact(extra: Record<string, unknown> = {}): Promise<void> {
  const sub = nexusCommand.subCommands?.['impact'];
  if (!sub || typeof sub !== 'object' || !('run' in sub) || !sub.run) throw new Error('no impact');
  await sub.run({
    args: { _: [], symbol: 'alpha', depth: '3', ...extra },
    rawArgs: [],
    cmd: sub,
  } as Parameters<NonNullable<typeof sub.run>>[0]);
}

const affected = {
  query: 'alpha',
  projectId: 'proj',
  targetNodeId: 'src/a.ts::alpha',
  targetLabel: 'alpha',
  riskLevel: 'LOW',
  totalImpact: 0,
  maxDepth: 3,
  affected: [],
};

beforeEach(() => {
  mockAssess.mockReset();
  mockImpact.mockReset();
  mockCliError.mockReset();
  mockCliOutput.mockReset();
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe('cleo nexus impact on a stale index (T14008)', () => {
  it('refuses an index far behind HEAD with exit 111 and the reindex command', async () => {
    mockAssess.mockResolvedValue(assessment(3239, 3239, 'stale'));

    await impact();

    expect(mockImpact).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(111);
    const [message, code, error] = mockCliError.mock.calls[0] ?? [];
    expect(message).toContain('3239 commit(s) behind the checked-out HEAD');
    expect(code).toBe(111);
    expect(error).toMatchObject({ name: 'E_NEXUS_INDEX_STALE' });
    expect(String(error?.fix)).toContain('cleo nexus analyze "/repo"');
  });

  it('answers a fresh index on a branch far behind main, with the freshness block', async () => {
    mockAssess.mockResolvedValue(assessment(0, 3239, 'fresh'));
    mockImpact.mockResolvedValue(affected);

    await impact();

    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockCliOutput.mock.calls[0]?.[0]).toMatchObject({
      targetNodeId: 'src/a.ts::alpha',
      freshness: { commitsBehindHead: 0, commitsBehind: 3239 },
    });
  });

  it('refuses a target missing from a stale index, not from a fresh one (T13922)', async () => {
    mockImpact.mockResolvedValue({ ...affected, targetNodeId: null, riskLevel: 'UNKNOWN' });
    mockAssess.mockResolvedValue(assessment(3, 3, 'stale'));
    await impact();
    expect(process.exitCode).toBe(111);
    expect(mockCliError.mock.calls[0]?.[2]).toMatchObject({ name: 'E_NEXUS_INDEX_STALE' });

    mockCliError.mockReset();
    process.exitCode = 0;
    mockAssess.mockResolvedValue(assessment(0, 3, 'fresh'));
    await impact();
    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockCliOutput).toHaveBeenCalled();
  });

  it('--allow-stale answers the stale index', async () => {
    mockAssess.mockResolvedValue(assessment(3239, 3239, 'stale'));
    mockImpact.mockResolvedValue(affected);

    await impact({ 'allow-stale': true });

    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockCliOutput.mock.calls[0]?.[0]).toMatchObject({
      freshness: { commitsBehindHead: 3239 },
    });
  });
});
