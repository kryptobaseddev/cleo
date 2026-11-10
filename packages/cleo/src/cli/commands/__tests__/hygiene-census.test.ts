/** The census CLI stays report-only; only explicit --apply may remove worktrees. */
import { runCommand } from 'citty';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runCensus = vi.hoisted(() =>
  vi.fn<typeof import('@cleocode/core/hygiene/census').runWorktreeCensus>(),
);
vi.mock('@cleocode/core/hygiene/census', () => ({ runWorktreeCensus: runCensus }));
vi.mock('@cleocode/core/project-scope', () => ({ getProjectRoot: () => '/repo' }));
vi.mock('@cleocode/core/hygiene/validate-spawn-readiness.js', () => ({
  runSpawnReadinessHygieneCli: vi.fn(),
}));
vi.mock('../../renderers/index.js', () => ({ cliError: vi.fn(), cliOutput: vi.fn() }));

import { hygieneCommand } from '../hygiene.js';

beforeEach(() => {
  vi.clearAllMocks();
  runCensus.mockResolvedValue({ skipped: 'test fixture' });
});
describe('hygiene census CLI', () => {
  it.each([
    { flags: [] },
    { flags: ['--report'] },
    { flags: ['--dry-run'] },
    { flags: ['--all-projects'] },
  ])('does not apply for %j', async ({ flags }) => {
    await runCommand(hygieneCommand, { rawArgs: ['census', ...flags] });
    expect(runCensus).toHaveBeenCalledWith(expect.objectContaining({ apply: false }));
  });
  it('applies only when explicitly requested', async () => {
    await runCommand(hygieneCommand, { rawArgs: ['census', '--apply', '--all-projects'] });
    expect(runCensus).toHaveBeenCalledWith(
      expect.objectContaining({ apply: true, allProjects: true }),
    );
  });
});
