/**
 * `cleo done` resolves tool commands in the execution root (T12964).
 *
 * `validateTool` reads package.json scripts and tsconfig where the code under
 * test lives (T12633). The `cleo done` runner resolved against the store root
 * only, so a worktree's own scripts were ignored and the command it ran could
 * differ from the one `cleo verify` ran for the same atom.
 *
 * @task T12964
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveToolCommand = vi.fn();
const runToolCached = vi.fn();

vi.mock('../tool-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tool-resolver.js')>()),
  resolveToolCommand: (...args: unknown[]) => resolveToolCommand(...args),
}));
vi.mock('../tool-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tool-cache.js')>()),
  runToolCached: (...args: unknown[]) => runToolCached(...args),
}));

import { defaultRunTool } from '../done-record.js';

describe('done-record default tool runner (T12964)', () => {
  beforeEach(() => {
    resolveToolCommand.mockReset();
    runToolCached.mockReset();
  });

  it('passes the execution root to resolveToolCommand and runToolCached', async () => {
    const command = {
      canonical: 'lint',
      displayName: 'lint',
      cmd: 'pnpm',
      args: ['run', 'lint'],
      source: 'package-script',
    };
    resolveToolCommand.mockReturnValue({ ok: true, command });
    runToolCached.mockResolvedValue({
      exitCode: 0,
      cacheHit: false,
      durationMs: 5,
      timedOut: false,
      stdoutTail: 'ok',
      stderrTail: '',
    });

    const r = await defaultRunTool('lint', '/store', '/worktree');

    expect(resolveToolCommand).toHaveBeenCalledWith('lint', '/store', {
      executionRoot: '/worktree',
    });
    expect(runToolCached).toHaveBeenCalledWith(command, '/store', { executionRoot: '/worktree' });
    expect(r.exitCode).toBe(0);
  });

  it('reports an unresolvable tool without running anything', async () => {
    resolveToolCommand.mockReturnValue({
      ok: false,
      reason: 'no lint',
      codeName: 'E_TOOL_UNKNOWN',
    });
    const r = await defaultRunTool('lint', '/store', '/worktree');
    expect(r.exitCode).toBeNull();
    expect(r.tail).toBe('no lint');
    expect(runToolCached).not.toHaveBeenCalled();
  });
});
