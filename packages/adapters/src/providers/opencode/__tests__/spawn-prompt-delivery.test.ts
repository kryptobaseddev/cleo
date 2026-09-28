/**
 * T12619 — the opencode prompt is delivered on stdin, never argv.
 *
 * The prompt used to be the last positional argument of `opencode run`. On
 * Windows opencode is a `.cmd` shim launched through cmd.exe, which cannot
 * carry a line break (E_UNSAFE_BATCH_ARG) and caps the line at 8191 chars,
 * so every real multi-line prompt failed there. `--file` would only attach
 * it behind a pointer message; `opencode run` uses piped stdin AS the message
 * when no positional is given, so the prompt is piped on every platform.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
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
let stdinText: () => string;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

/** Temp dirs the old `--file` delivery created. */
function promptDirs(): string[] {
  return readdirSync(tmpdir()).filter((d) => d.startsWith('cleo-opencode-spawn-'));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'opencode-spawn-'));
  child = new EventEmitter();
  const stdin = new PassThrough();
  const chunks: Buffer[] = [];
  stdin.on('data', (c: Buffer) => chunks.push(c));
  stdinText = () => Buffer.concat(chunks).toString('utf-8');
  Object.assign(child, { pid: 4242, unref: () => undefined, stdin });
  vi.mocked(spawn).mockReturnValue(child as ChildProcess);
});
afterEach(() => {
  setPlatform(realPlatform);
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  rmSync(cwd, { recursive: true, force: true });
});

describe('opencode prompt delivery (T12619)', () => {
  it('POSIX: prompt is piped on stdin byte-exact; argv has no prompt; no temp file', async () => {
    setPlatform('linux');
    const before = promptDirs();
    const result = await new OpenCodeSpawnProvider().spawn({
      taskId: 'T1',
      prompt: PROMPT,
      workingDirectory: cwd,
    });
    expect(result.status).toBe('running');
    const [, args, opts] = vi.mocked(spawn).mock.calls[0] ?? [];
    const argv = (args ?? []) as readonly string[];
    expect(opts).toMatchObject({ stdio: ['pipe', 'ignore', 'ignore'] });
    await vi.waitFor(() => expect(stdinText()).toBe(PROMPT));
    expect(argv.some((a) => a.includes('Implement') || a.includes('\n'))).toBe(false);
    expect(argv).not.toContain('--file');
    // No positional message: argv ends at the title, so stdin IS the message.
    expect(argv.at(-1)).toBe('CLEO T1');
    expect(promptDirs()).toEqual(before);
  });

  it('win32: a multi-line prompt spawns through cmd.exe and is piped on stdin', async () => {
    setPlatform('win32');
    vi.stubEnv('PATH', 'C:\\npm');
    vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');
    vi.stubEnv('ComSpec', 'C:\\Windows\\system32\\cmd.exe');
    const before = promptDirs();
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
    expect(line).not.toContain('--file');
    await vi.waitFor(() => expect(stdinText()).toBe(PROMPT));
    expect(promptDirs()).toEqual(before);
  });

  it('a spawn error (no exit) does not leave the instance tracked', async () => {
    setPlatform('linux');
    const provider = new OpenCodeSpawnProvider();
    await provider.spawn({ taskId: 'T1', prompt: PROMPT, workingDirectory: cwd });
    child.emit('error', Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' }));
    expect(await provider.listRunning()).toEqual([]);
  });
});
