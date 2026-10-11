/**
 * `cleo self-update` runs post-update maintenance in the CLI it just installed,
 * never in its own process (T13489).
 *
 * The running process imported the previous version's core before
 * `npm install -g` replaced it. Calling that in-memory `runUpgrade` ran the OLD
 * maintenance on 10.5 → 10.6 and rewrote tracked project files the new version
 * leaves alone.
 *
 * @task T13489
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'citty';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunUpgrade = vi.fn();
const mockSpawn = vi.fn();
const npmCalls: string[][] = [];
const cleoHome = mkdtempSync(join(tmpdir(), 'self-update-child-'));

vi.mock('@cleocode/core/internal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core/internal')>()),
  runUpgrade: (...a: unknown[]) => mockRunUpgrade(...a),
  getCleoHome: () => cleoHome,
  getRuntimeDiagnostics: async () => ({
    channel: 'stable',
    invocation: { script: '/usr/lib/node_modules/@cleocode/cleo/bin/cleo.js' },
  }),
  checkAllRegisteredProjects: async () => ({ summary: {}, global: {}, projects: [] }),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: async (cmd: string, args: string[]) => {
      npmCalls.push([cmd, ...args]);
      if (args[0] === 'ls') {
        return {
          stdout: JSON.stringify({ dependencies: { '@cleocode/cleo': { version: '2026.10.5' } } }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    },
  });
  return { ...actual, execFile, spawn: (...a: unknown[]) => mockSpawn(...a) };
});

vi.mock('../../renderers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../renderers/index.js')>()),
  cliOutput: vi.fn(),
  cliError: vi.fn(),
  humanInfo: vi.fn(),
  humanWarn: vi.fn(),
}));

import { selfUpdateCommand } from '../self-update.js';

async function run(argv: string[]): Promise<void> {
  const def = selfUpdateCommand as unknown as {
    args: Parameters<typeof parseArgs>[1];
    run: (ctx: { args: unknown; rawArgs: string[]; cmd: unknown }) => Promise<void>;
  };
  await def.run({ args: parseArgs(argv, def.args), rawArgs: argv, cmd: def });
}

beforeEach(() => {
  mockRunUpgrade.mockReset();
  mockSpawn.mockReset();
  npmCalls.length = 0;
  mockSpawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
});

describe('cleo self-update after installing a new version (T13489)', () => {
  it('runs post-update maintenance in the installed CLI, not this process', async () => {
    await run(['--version', '2026.10.7', '--no-check-projects', '--json']);

    expect(npmCalls).toContainEqual(['npm', 'install', '-g', '@cleocode/cleo@2026.10.7']);
    expect(mockRunUpgrade).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, argv] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(bin).toBe(process.execPath);
    expect(argv.slice(1)).toEqual([
      'self-update',
      '--post-update',
      '--no-check-projects',
      '--json',
    ]);
  });

  it('forwards --no-auto-upgrade to the installed CLI', async () => {
    await run(['--version', '2026.10.7', '--no-auto-upgrade', '--json']);
    const [, argv] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(argv).toContain('--no-auto-upgrade');
    expect(mockRunUpgrade).not.toHaveBeenCalled();
  });
});
