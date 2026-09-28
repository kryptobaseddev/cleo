/**
 * T12618 — provider CLIs are spawned through their resolved path on win32,
 * with npm `.cmd` shims routed through cmd.exe. Node refuses to spawn a
 * `.cmd` directly and its bare-name lookup never finds one, so before this
 * every adapter spawn failed on Windows.
 *
 * Platform and PATH are injected; the real resolver runs with a stubbed
 * filesystem predicate so the test is host-independent.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PRESENT = new Set(['C:\\npm\\claude.cmd', 'C:\\npm\\codex.cmd', 'C:\\bin\\pi.exe']);

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
import {
  _forceSystemdRunAvailable,
  buildAgentSpawnArgs,
} from '../providers/shared/agent-spawn-wrapper.js';
import { spawnCli } from '../providers/shared/cli-spawn.js';

const realPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  vi.stubEnv('PATH', 'C:\\npm;C:\\bin');
  vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');
  vi.stubEnv('ComSpec', 'C:\\Windows\\system32\\cmd.exe');
  vi.mocked(spawn).mockReturnValue(new EventEmitter() as ChildProcess);
});
afterEach(() => {
  setPlatform(realPlatform);
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  _forceSystemdRunAvailable(false);
});

describe('buildAgentSpawnArgs on win32 (claude-code)', () => {
  it('routes the claude.cmd shim through cmd.exe with verbatim quoting', () => {
    setPlatform('win32');
    _forceSystemdRunAvailable(false);
    const built = buildAgentSpawnArgs('claude', ['--print', 'C:\\Temp\\p q.txt'], 'T1');
    expect(built.command).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(built.windowsVerbatimArguments).toBe(true);
    expect(built.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(built.args[3]).toContain('C:\\npm\\claude.cmd');
  });

  it('POSIX keeps the sh/ulimit wrapper and never sets the verbatim flag', () => {
    setPlatform('linux');
    _forceSystemdRunAvailable(false);
    const built = buildAgentSpawnArgs('claude', ['--print'], 'T1');
    expect(built.command).toBe('sh');
    expect(built.windowsVerbatimArguments).toBeUndefined();
  });
});

describe('spawnCli (codex, gemini, opencode, pi)', () => {
  it('.cmd on win32: spawns cmd.exe with windowsVerbatimArguments', () => {
    setPlatform('win32');
    spawnCli('codex', ['--full-auto', 'a & b'], { detached: true, stdio: 'ignore' });
    const [file, args, opts] = vi.mocked(spawn).mock.calls[0] ?? [];
    expect(file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(args?.[3]).toContain('C:\\npm\\codex.cmd');
    expect(args?.[3]).not.toMatch(/[^^]&/);
    expect(opts).toMatchObject({ detached: true, windowsVerbatimArguments: true });
  });

  it('.exe on win32: spawns the absolute path directly', () => {
    setPlatform('win32');
    spawnCli('pi', ['prompt.txt'], { stdio: 'ignore' });
    expect(vi.mocked(spawn).mock.calls[0]).toEqual([
      'C:\\bin\\pi.exe',
      ['prompt.txt'],
      { stdio: 'ignore' },
    ]);
  });

  it('POSIX: unchanged bare-name spawn', () => {
    setPlatform('darwin');
    spawnCli('codex', ['x'], { stdio: 'ignore' });
    expect(vi.mocked(spawn).mock.calls[0]).toEqual(['codex', ['x'], { stdio: 'ignore' }]);
  });
});
