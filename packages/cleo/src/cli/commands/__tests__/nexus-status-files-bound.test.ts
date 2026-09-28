/**
 * `cleo nexus status` output must not grow with the repository (T12560).
 *
 * The command emitted `assessment.files` whole — one row per assessed file at
 * ~635 B each — so the envelope measured 3.9 MB on this repository and 391 MB
 * for one reporter. Status is the call every agent is told to make first.
 *
 * These tests drive the real command with a 100k-file assessment and measure
 * the payload handed to `cliOutput`. On the unbounded code the default payload
 * is tens of MB and the size tracks the file count, so they fail there.
 *
 * @task T12560
 */

import type { GraphIndexAssessment, GraphIndexFileReport } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ assessment: null as GraphIndexAssessment | null }));

vi.mock('../../renderers/index.js', async (original) => ({
  ...(await original<typeof import('../../renderers/index.js')>()),
  cliOutput: vi.fn(),
  cliError: vi.fn(),
  humanWarn: vi.fn(),
}));

vi.mock('@cleocode/core/store/nexus-sqlite', async (original) => ({
  ...(await original<typeof import('@cleocode/core/store/nexus-sqlite')>()),
  getNexusDb: vi.fn(async () => ({})),
}));

vi.mock('@cleocode/nexus/pipeline', () => ({
  getIndexStats: vi.fn(async () => ({
    indexed: true,
    nodeCount: 1234,
    relationCount: 5678,
    fileCount: 100_000,
    lastIndexedAt: '2026-09-28T00:00:00.000Z',
    staleFileCount: 0,
  })),
}));

vi.mock('@cleocode/core/nexus/knowledge', async (original) => ({
  ...(await original<typeof import('@cleocode/core/nexus/knowledge')>()),
  readKnowledgeIndexAssessment: vi.fn(async () => state.assessment),
  readKnowledgeIndexReferences: vi.fn(async () => []),
}));

vi.mock('@cleocode/core/nexus/freshness.js', async (original) => ({
  ...(await original<typeof import('@cleocode/core/nexus/freshness.js')>()),
  assessNexusIndexFreshness: vi.fn(async () => ({ status: 'fresh', staleFileCount: 0 })),
}));

import { cliError, cliOutput } from '../../renderers/index.js';
import { nexusCommand } from '../nexus.js';

/** A realistic file row: path, outcome, and the change-detection fields. */
function fileRow(index: number): GraphIndexFileReport {
  const failed = index % 1000 === 0;
  return {
    path: `packages/package-${index % 50}/src/module-${String(index).padStart(6, '0')}.ts`,
    status: failed ? 'failed' : 'analyzed',
    ...(failed ? { reason: 'Parser failed on this file' } : {}),
    mtimeMs: 1_790_000_000_000 + index,
    size: 4096 + index,
    contentHash: index.toString(16).padStart(64, 'a'),
  };
}

function assessmentWith(fileCount: number): GraphIndexAssessment {
  return {
    sourceRoot: '/repo',
    assessedRevision: 'a'.repeat(40),
    assessedAt: '2026-09-28T00:00:00.000Z',
    referenceCount: 0,
    files: Array.from({ length: fileCount }, (_, index) => fileRow(index)),
  };
}

type StatusRun = (ctx: { args: Record<string, unknown> }) => Promise<void>;

/** Run `cleo nexus status` with `args`; return the payload given to cliOutput. */
async function runStatus(
  fileCount: number,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  state.assessment = assessmentWith(fileCount);
  vi.mocked(cliOutput).mockClear();
  const sub = (nexusCommand as unknown as { subCommands: Record<string, { run: StatusRun }> })
    .subCommands;
  await sub['status'].run({ args: { json: true, ...args } });
  expect(cliError).not.toHaveBeenCalled();
  expect(cliOutput).toHaveBeenCalledTimes(1);
  return vi.mocked(cliOutput).mock.calls[0][0] as Record<string, unknown>;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

describe('nexus status — bounded file report (T12560)', () => {
  beforeEach(() => {
    vi.mocked(cliError).mockClear();
    process.exitCode = undefined;
  });

  it('keeps the default payload under 16 KiB for 100k files, independent of file count', async () => {
    const small = await runStatus(1_000);
    const large = await runStatus(100_000);
    expect(bytes(large)).toBeLessThan(16 * 1024);
    // Only digit widths in counts and _withheld may differ.
    expect(Math.abs(bytes(large) - bytes(small))).toBeLessThan(64);
  });

  it('keeps freshness facts and file counts, and marks the list withheld', async () => {
    const data = await runStatus(100_000);
    expect(data).toMatchObject({
      nodeCount: 1234,
      fileCount: 100_000,
      lastIndexedAt: '2026-09-28T00:00:00.000Z',
      staleFileCount: 0,
    });
    const assessment = data['assessment'] as Record<string, unknown>;
    expect(assessment['files']).toBeUndefined();
    expect(assessment['fileCount']).toBe(100_000);
    expect(assessment['filesByStatus']).toEqual({
      analyzed: 99_900,
      excluded: 0,
      unsupported: 0,
      oversized: 0,
      failed: 100,
    });
    const full = state.assessment?.files ?? [];
    expect(assessment['_withheld']).toEqual({ files: bytes(full) });
    expect(assessment['filesPage']).toMatchObject({
      offset: 0,
      limit: 20,
      total: 100_000,
      returned: 20,
      nextOffset: 20,
    });
  });

  it('pages with --limit/--offset/--file-status', async () => {
    const data = await runStatus(100_000, { limit: '3', offset: '98', 'file-status': 'failed' });
    const page = (data['assessment'] as Record<string, unknown>)['filesPage'] as {
      rows: GraphIndexFileReport[];
    };
    expect(page).toMatchObject({ offset: 98, limit: 3, status: 'failed', total: 100, returned: 2 });
    expect(page).toMatchObject({ nextOffset: null });
    expect(page.rows.map((row) => row.path)).toEqual([fileRow(98_000).path, fileRow(99_000).path]);
  });

  it('returns the complete list only on explicit --files request', async () => {
    const data = await runStatus(2_000, { files: true });
    const assessment = data['assessment'] as Record<string, unknown>;
    expect(assessment['files']).toEqual(state.assessment?.files);
    expect(assessment['_withheld']).toBeUndefined();
    expect(assessment['filesPage']).toBeUndefined();
  });

  it('rejects a malformed --limit before reading the index', async () => {
    const sub = (nexusCommand as unknown as { subCommands: Record<string, { run: StatusRun }> })
      .subCommands;
    vi.mocked(cliOutput).mockClear();
    await sub['status'].run({ args: { json: true, limit: '10x' } });
    expect(cliError).toHaveBeenCalledTimes(1);
    expect(cliOutput).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
  });
});
