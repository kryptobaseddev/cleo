/**
 * Windows spawn behaviour of the pgid fallback.
 *
 * T12604: `buildSpawnArgs` used to wrap every command as
 * `sh -c 'ulimit -c 0; exec "$@"'` whenever systemd-run was absent (all of
 * macOS and Windows). Windows has no `sh`, so every heavy-tool evidence run
 * died with ENOENT.
 *
 * T12618: on Windows `pnpm`/`npx` are `.cmd` shims, which Node neither finds
 * by bare name nor spawns without a shell; they now go through cmd.exe with
 * injection-safe quoting and `windowsVerbatimArguments`.
 *
 * The platform is injected by redefining `process.platform`, and the real
 * resolver runs with a stubbed filesystem predicate, so this runs on any host.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PRESENT = new Set(['C:\\node\\pnpm.cmd']);

vi.mock('@cleocode/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/paths')>();
  return {
    ...actual,
    resolveSpawnInvocation: (
      command: string,
      args: readonly string[],
      opts: import('@cleocode/paths').ExecPathOptions = {},
    ) =>
      actual.resolveSpawnInvocation(command, args, {
        ...opts,
        isExecutable: (p) => PRESENT.has(p),
      }),
  };
});
vi.mock('node:child_process', { spy: true });

import { spawn } from 'node:child_process';
import { _forceSystemdRunAvailable, buildSpawnArgs, spawnWrapped } from '../spawn-wrapper.js';

const realPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  _forceSystemdRunAvailable(undefined);
});

describe('buildSpawnArgs pgid fallback per platform (T12604)', () => {
  it('spawns the command directly on win32 even with noCoreFile=true (the default)', () => {
    setPlatform('win32');
    _forceSystemdRunAvailable(false);
    const built = buildSpawnArgs('node', ['--version']);
    expect(built).toEqual({ command: 'node', args: ['--version'], mode: 'pgid' });
  });

  it('keeps ulimit core suppression on POSIX', () => {
    setPlatform('darwin');
    _forceSystemdRunAvailable(false);
    const built = buildSpawnArgs('node', ['--version']);
    expect(built.command).toBe('sh');
    expect(built.args).toEqual(['-c', 'ulimit -c 0; exec "$@"', 'sh', 'node', '--version']);
  });
});

describe('win32 .cmd tools go through cmd.exe (T12618)', () => {
  it('buildSpawnArgs resolves pnpm to pnpm.cmd behind %ComSpec%', () => {
    setPlatform('win32');
    _forceSystemdRunAvailable(false);
    vi.stubEnv('PATH', 'C:\\node');
    vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');
    vi.stubEnv('ComSpec', 'C:\\Windows\\system32\\cmd.exe');
    const built = buildSpawnArgs('pnpm', ['run', 'test', '--', '-t', 'a & b']);
    expect(built.command).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(built.windowsVerbatimArguments).toBe(true);
    expect(built.args[3]).toContain('C:\\node\\pnpm.cmd');
  });

  it('spawnWrapped passes windowsVerbatimArguments to spawn', () => {
    setPlatform('win32');
    _forceSystemdRunAvailable(false);
    vi.stubEnv('PATH', 'C:\\node');
    vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');
    vi.mocked(spawn).mockReturnValue(new EventEmitter() as ChildProcess);
    spawnWrapped('pnpm', ['test'], { stdio: 'ignore' });
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    });
  });
});
