/**
 * T12619 — the opencode prompt is delivered through a file, never argv.
 *
 * The prompt used to be the last positional argument of `opencode run`. On
 * Windows opencode is a `.cmd` shim launched through cmd.exe, which cannot
 * carry a line break (E_UNSAFE_BATCH_ARG) and caps the line at 8191 chars,
 * so every real multi-line prompt failed there. It now goes to a private temp
 * file attached with `--file`, on every platform; argv carries no prompt text.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
        isExecutable: (p) => p === 'C:\\npm\\opencode.cmd',
      }),
  };
});
vi.mock('node:child_process', { spy: true });

import { spawn } from 'node:child_process';
import { OpenCodeSpawnProvider } from '../spawn.js';

const PROMPT = 'Implement T1.\n\nSteps:\n  1. read "spec" & run tests\n  2. 100% done ^_^';
const realPlatform = process.platform;
let cwd: string;
let child: EventEmitter;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

/** The `--file` value from the spawned argv (POSIX form). */
function promptFileFrom(args: readonly string[]): string {
  const i = args.indexOf('--file');
  expect(i).toBeGreaterThan(-1);
  return args[i + 1] as string;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'opencode-spawn-'));
  child = new EventEmitter();
  Object.assign(child, { pid: 4242, unref: () => undefined });
  vi.mocked(spawn).mockReturnValue(child as ChildProcess);
});
afterEach(() => {
  setPlatform(realPlatform);
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  rmSync(cwd, { recursive: true, force: true });
});

describe('opencode prompt delivery (T12619)', () => {
  it('POSIX: prompt goes to an attached file, intact, and never into argv', async () => {
    setPlatform('linux');
    const result = await new OpenCodeSpawnProvider().spawn({
      taskId: 'T1',
      prompt: PROMPT,
      workingDirectory: cwd,
    });
    expect(result.status).toBe('running');
    const [, args] = vi.mocked(spawn).mock.calls[0] ?? [];
    const argv = (args ?? []) as readonly string[];
    expect(argv.some((a) => a.includes('Implement T1') || a.includes('\n'))).toBe(false);
    const file = promptFileFrom(argv);
    expect(readFileSync(file, 'utf-8')).toBe(PROMPT);

    child.emit('exit', 0);
    await vi.waitFor(() => expect(existsSync(file)).toBe(false));
  });

  it('win32: a multi-line prompt spawns through cmd.exe (no E_UNSAFE_BATCH_ARG)', async () => {
    setPlatform('win32');
    vi.stubEnv('PATH', 'C:\\npm');
    vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');
    vi.stubEnv('ComSpec', 'C:\\Windows\\system32\\cmd.exe');
    const result = await new OpenCodeSpawnProvider().spawn({
      taskId: 'T1',
      prompt: PROMPT,
      workingDirectory: cwd,
    });
    expect(result.status).toBe('running');
    const [file, args, opts] = vi.mocked(spawn).mock.calls[0] ?? [];
    expect(file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(opts).toMatchObject({ windowsVerbatimArguments: true });
    const line = ((args ?? []) as readonly string[])[3] ?? '';
    expect(line).toContain('C:\\npm\\opencode.cmd');
    expect(line).not.toContain('Implement');
    expect(line).toContain('--file');
  });
});
