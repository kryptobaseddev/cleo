/** Native payload normalization and fail-open boundaries without heavy-command rewrites. */

import type { HookExecutor, HookOutcome } from '@cleocode/contracts/project-hooks.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookIo } from '../hook-entry.js';
import { runProjectHookCli } from '../project-hook-entry.js';

const execute = vi.hoisted(() => vi.fn<HookExecutor['execute']>());
vi.mock('@cleocode/core/hooks/project-state', () => ({
  resolveProjectHookContext: (cwd: string) => ({
    projectRoot: cwd,
    gitCommonDir: cwd + '/.git',
    stateDir: cwd + '/.git/private',
    hooksDir: cwd + '/.git/hooks',
  }),
}));
vi.mock('@cleocode/core/hooks/project-runner', () => ({ executeProjectHooks: execute }));
function io(body: string): HookIo {
  return {
    cwd: '/project with spaces',
    env: {},
    readStdin: vi.fn(async () => body),
    writeStdout: vi.fn(),
    writeStderr: vi.fn(),
  };
}
const block: HookOutcome = {
  id: 'migration',
  status: 'block',
  blocks: true,
  code: 'PROJECT_BLOCK',
  exitCode: 0,
  signal: null,
  durationMs: 1,
};
beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValue([block]);
});
describe('native shared hook entry', () => {
  it('probes without reading stdin or loading a checker', async () => {
    const streams = io('');
    expect(await runProjectHookCli(['--probe'], streams)).toBe(0);
    expect(streams.writeStdout).toHaveBeenCalledWith('CLEO_PROJECT_HOOK_V1\n');
    expect(streams.readStdin).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps agents advisory and returns no permission decision or updated input', async () => {
    const streams = io('{"cwd":"/checkout/nested","tool_input":{"command":"pwd"}}');
    expect(await runProjectHookCli(['--provider', 'codex'], streams)).toBe(0);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent',
        projectRoot: '/checkout/nested',
        toolInput: { command: 'pwd' },
      }),
      undefined,
      undefined,
      expect.any(AbortSignal),
    );
    const answer = vi.mocked(streams.writeStdout).mock.calls[0]?.[0] ?? '';
    expect(answer).toContain('additionalContext');
    expect(answer).not.toContain('permissionDecision');
    expect(answer).not.toContain('updatedInput');
  });
  it('blocks a Git project verdict and preserves actual non-HEAD pushed refs', async () => {
    const oid = 'a'.repeat(40),
      zero = '0'.repeat(40);
    const streams = io('refs/heads/other ' + oid + ' refs/heads/other ' + zero + '\n');
    expect(
      await runProjectHookCli(['--source', 'git', '--', 'origin', '/remote path'], streams),
    ).toBe(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: { name: 'origin', location: '/remote path' },
        refs: [
          {
            localRef: 'refs/heads/other',
            localOid: oid,
            remoteRef: 'refs/heads/other',
            remoteOid: zero,
          },
        ],
      }),
      undefined,
      undefined,
      expect.any(AbortSignal),
    );
  });
  it('allows Git on runner infrastructure failure and reports the fault', async () => {
    execute.mockRejectedValue(new Error('unavailable'));
    const streams = io('');
    expect(await runProjectHookCli(['--source', 'git'], streams)).toBe(0);
    expect(streams.writeStderr).toHaveBeenCalledWith(expect.stringContaining('operation allowed'));
  });
  it('does not execute a checker on malformed native input', async () => {
    const streams = io('invalid');
    expect(await runProjectHookCli(['--source', 'agent'], streams)).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(streams.writeStdout).not.toHaveBeenCalled();
  });
});
