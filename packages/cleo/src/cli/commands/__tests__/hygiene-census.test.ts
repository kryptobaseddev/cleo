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
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('cancels on %s and removes its listeners', async (signal, code) => {
    const listeners = process.listenerCount(signal);
    const previousCode = process.exitCode;
    reportCensus.mockImplementation(async (_opts, abortSignal) => {
      process.emit(signal);
      expect(abortSignal.aborted).toBe(true);
      return { skipped: 'cancelled fixture' };
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
