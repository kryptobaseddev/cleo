/** The census CLI stays report-only; only explicit --apply may remove worktrees. */
import { runCommand } from 'citty';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runCensus = vi.hoisted(() =>
  vi.fn<typeof import('@cleocode/core/hygiene/census').runWorktreeCensus>(),
);
const reportCensus = vi.hoisted(() =>
  vi.fn<typeof import('@cleocode/core/hygiene/census').reportWorktreeCensus>(),
);
vi.mock('@cleocode/core/hygiene/census', () => ({
  runWorktreeCensus: runCensus,
  reportWorktreeCensus: reportCensus,
}));
vi.mock('@cleocode/core/project-scope', () => ({ getProjectRoot: () => '/repo' }));
vi.mock('@cleocode/core/hygiene/validate-spawn-readiness.js', () => ({
  runSpawnReadinessHygieneCli: vi.fn(),
}));
vi.mock('../../renderers/index.js', () => ({ cliError: vi.fn(), cliOutput: vi.fn() }));

import { hygieneCommand } from '../hygiene.js';

const partialReport: Awaited<ReturnType<typeof reportCensus>> = {
  record: {
    schemaVersion: 2,
    mode: 'report',
    startedAt: '2026-11-13T00:00:00Z',
    finishedAt: '2026-11-13T00:03:00Z',
    machineRoot: '/worktrees',
    applyProjects: [],
    counts: { active: 0, redundant: 0, keep: 0, unknown: 0 },
    apparentBytes: 0,
    reclaimedApparentBytes: 0,
    dfFreeBefore: null,
    dfFreeAfter: null,
    dfDelta: null,
    kept: [],
    rows: [],
    partial: true,
    partialReason: 'Census time bound reached; scan incomplete.',
    projects: [],
    orphanFolders: [],
    pnpmStore: null,
  },
  recordPath: '/census/partial.json',
};

beforeEach(() => {
  vi.clearAllMocks();
  runCensus.mockResolvedValue({ skipped: 'test fixture' });
  reportCensus.mockResolvedValue({ skipped: 'test fixture' });
});
describe('hygiene census CLI', () => {
  it.each([
    { flags: [] },
    { flags: ['--report'] },
    { flags: ['--dry-run'] },
    { flags: ['--all-projects'] },
  ])('does not apply for %j', async ({ flags }) => {
    await runCommand(hygieneCommand, { rawArgs: ['census', ...flags] });
    expect(reportCensus).toHaveBeenCalledWith(
      expect.not.objectContaining({ apply: true }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(runCensus).not.toHaveBeenCalled();
  });
  it('applies only when explicitly requested', async () => {
    await runCommand(hygieneCommand, { rawArgs: ['census', '--apply', '--all-projects'] });
    expect(runCensus).toHaveBeenCalledWith(
      expect.objectContaining({ apply: true, allProjects: true }),
    );
  });
  it('passes the build-output allowance to the bounded report', async () => {
    await runCommand(hygieneCommand, {
      rawArgs: ['census', '--dry-run', '--include-build-output'],
    });
    expect(reportCensus).toHaveBeenCalledWith(
      expect.objectContaining({ exemptRegenerable: true }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });
  it('allows raising the report budget for a large repository', async () => {
    const started = Date.now();
    await runCommand(hygieneCommand, { rawArgs: ['census', '--budget-ms', '600000'] });
    expect(reportCensus).toHaveBeenCalledWith(
      expect.objectContaining({ deadline: expect.any(Number) }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    const deadline = reportCensus.mock.calls[0]?.[0].deadline;
    expect(deadline).toBeGreaterThanOrEqual(started + 600_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 600_000);
  });
  it.each([
    '0',
    '-1',
    '1.5',
    'NaN',
    'Infinity',
    '2147483648',
  ])('rejects an invalid budget %s before scanning', async (value) => {
    const previous = process.exitCode;
    try {
      await runCommand(hygieneCommand, { rawArgs: ['census', `--budget-ms=${value}`] });
      expect(process.exitCode).toBe(2);
      expect(reportCensus).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previous;
    }
  });
  it('rejects a report-only budget on an apply command', async () => {
    const previous = process.exitCode;
    try {
      await runCommand(hygieneCommand, { rawArgs: ['census', '--apply', '--budget-ms', '600000'] });
      expect(process.exitCode).toBe(2);
      expect(runCensus).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previous;
    }
  });
  it('exits 124 for a partial report', async () => {
    const previous = process.exitCode;
    reportCensus.mockResolvedValue(partialReport);
    try {
      await runCommand(hygieneCommand, { rawArgs: ['census', '--dry-run'] });
      expect(process.exitCode).toBe(124);
    } finally {
      process.exitCode = previous;
    }
  });
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('cancels on %s and removes its listeners', async (signal, code) => {
    const listeners = process.listenerCount(signal);
    const previousCode = process.exitCode;
    reportCensus.mockImplementation(async (_opts, abortSignal) => {
      process.emit(signal);
      expect(abortSignal.aborted).toBe(true);
      return partialReport;
    });
    try {
      await runCommand(hygieneCommand, { rawArgs: ['census', '--dry-run'] });
      expect(process.exitCode).toBe(code);
      expect(process.listenerCount(signal)).toBe(listeners);
    } finally {
      process.exitCode = previousCode;
    }
  });
});
