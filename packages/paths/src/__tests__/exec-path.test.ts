/**
 * Cross-platform PATH composition, executable lookup and shell resolution (T12605 · T12604).
 *
 * The win32 cases run on every host: each helper takes the platform
 * explicitly and joins with that platform's path module.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executableNames,
  findOnPath,
  pathEnvKey,
  prependPathEntry,
  shellInvocation,
  splitPathEnv,
} from '../exec-path.js';

const WIN_PATH =
  'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd;C:\\Users\\me\\AppData\\Roaming\\npm';

describe('PATH composition with a Windows-style PATH containing drive letters', () => {
  it('prepends with ";" so the first real entry survives intact', () => {
    const composed = prependPathEntry('C:\\repo\\.cleo\\bin\\git-shim', WIN_PATH, 'win32');
    expect(splitPathEnv(composed, 'win32')).toEqual([
      'C:\\repo\\.cleo\\bin\\git-shim',
      'C:\\Windows\\system32',
      'C:\\Program Files\\Git\\cmd',
      'C:\\Users\\me\\AppData\\Roaming\\npm',
    ]);
  });

  it('the old dir + ":" + PATH idiom fuses the shim dir with the first entry (red-on-broken)', () => {
    const broken = `C:\\repo\\.cleo\\bin\\git-shim:${WIN_PATH}`;
    const entries = splitPathEnv(broken, 'win32');
    expect(entries[0]).toBe('C:\\repo\\.cleo\\bin\\git-shim:C:\\Windows\\system32');
    expect(entries).not.toContain('C:\\Windows\\system32');
  });

  it('splitting a win32 PATH on ":" cuts drive letters apart; splitPathEnv does not', () => {
    expect(WIN_PATH.split(':')[0]).toBe('C');
    expect(splitPathEnv(WIN_PATH, 'win32')).toHaveLength(3);
  });

  it('keeps ":" on POSIX and returns the dir alone for an empty PATH', () => {
    expect(prependPathEntry('/shim', '/usr/bin:/bin', 'linux')).toBe('/shim:/usr/bin:/bin');
    expect(prependPathEntry('/shim', '', 'darwin')).toBe('/shim');
  });

  it('reuses the existing win32 `Path` key instead of adding a second PATH', () => {
    expect(pathEnvKey({ Path: WIN_PATH }, 'win32')).toBe('Path');
    expect(pathEnvKey({ Path: WIN_PATH }, 'linux')).toBe('PATH');
  });
});

describe('findOnPath honours PATHEXT on win32', () => {
  const env = { Path: WIN_PATH, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const present = new Set([
    win32.join('C:\\Program Files\\Git\\cmd', 'git.exe'),
    win32.join('C:\\Users\\me\\AppData\\Roaming\\npm', 'cleo-dev.cmd'),
  ]);
  const isExecutable = (p: string): boolean => present.has(p);

  it('resolves a bare name through PATHEXT', () => {
    expect(findOnPath('git', { platform: 'win32', env, isExecutable })).toBe(
      'C:\\Program Files\\Git\\cmd\\git.exe',
    );
    expect(findOnPath('cleo-dev', { platform: 'win32', env, isExecutable })).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\cleo-dev.cmd',
    );
  });

  it('the old bare-name probe misses the .cmd launcher (red-on-broken)', () => {
    const legacy = WIN_PATH.split(':')
      .filter(Boolean)
      .some((dir) => present.has(win32.join(dir, 'cleo-dev')));
    expect(legacy).toBe(false);
  });

  it('does not append PATHEXT to a name that already has one', () => {
    expect(executableNames('git.exe', { platform: 'win32', env })).toEqual(['git.exe']);
    expect(executableNames('git', { platform: 'linux', env })).toEqual(['git']);
  });

  it('returns null when absent', () => {
    expect(findOnPath('nope', { platform: 'win32', env, isExecutable })).toBeNull();
  });
});

describe('findOnPath on the real host filesystem', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('finds an executable and skips a non-executable file (POSIX)', () => {
    if (process.platform === 'win32') return;
    dir = mkdtempSync(join(tmpdir(), 'exec-path-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tool'), '#!/bin/sh\n');
    chmodSync(join(bin, 'tool'), 0o755);
    writeFileSync(join(bin, 'data'), 'x');
    const env = { PATH: `/nonexistent:${bin}` };
    expect(findOnPath('tool', { env })).toBe(join(bin, 'tool'));
    expect(findOnPath('data', { env })).toBeNull();
  });
});

describe('shellInvocation', () => {
  it('uses /bin/sh -c on POSIX', () => {
    expect(shellInvocation('pnpm build', { platform: 'darwin' })).toEqual({
      file: '/bin/sh',
      args: ['-c', 'pnpm build'],
      windowsVerbatimArguments: false,
    });
  });

  it('uses %ComSpec% /d /s /c with a verbatim quoted line on win32, never sh', () => {
    const inv = shellInvocation('pnpm build && echo ok', {
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    });
    expect(inv.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(inv.args).toEqual(['/d', '/s', '/c', '"pnpm build && echo ok"']);
    expect(inv.windowsVerbatimArguments).toBe(true);
    expect(shellInvocation('x', { platform: 'win32', env: {} }).file).toBe('cmd.exe');
  });
});
