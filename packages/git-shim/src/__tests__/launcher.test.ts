/**
 * T12605 — `git` must resolve to the shim on Windows.
 *
 * The shim was installed only as an extensionless `git` symlink. PATHEXT
 * never matches an extensionless file and unprivileged Windows cannot create
 * file symlinks, so branch protection was silently absent there.
 */

import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOnPath } from '@cleocode/paths';
import { afterEach, describe, expect, it } from 'vitest';
import { installGitShimLaunchers } from '../launcher.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function setup(): { shimDir: string; shimBin: string } {
  dir = mkdtempSync(join(tmpdir(), 'git-shim-launcher-'));
  const shimBin = join(dir, 'shim.js');
  writeFileSync(shimBin, '#!/usr/bin/env node\n');
  return { shimDir: join(dir, 'bin'), shimBin };
}

describe('installGitShimLaunchers', () => {
  it('win32: writes git.cmd (cmd/pwsh) and an sh launcher (Git Bash), no symlink', () => {
    const { shimDir, shimBin } = setup();
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const written = installGitShimLaunchers(shimDir, shimBin, {
      platform: 'win32',
      nodePath: node,
    });
    expect(written).toHaveLength(2);

    const cmd = readFileSync(join(shimDir, 'git.cmd'), 'utf-8');
    expect(cmd).toBe(`@"${node}" "${shimBin}" %*\r\n`);
    const sh = readFileSync(join(shimDir, 'git'), 'utf-8');
    expect(sh).toContain('exec "C:/Program Files/nodejs/node.exe"');
    expect(lstatSync(join(shimDir, 'git')).isSymbolicLink()).toBe(false);

    // A Windows PATH lookup for `git` with the shim dir first lands on git.cmd.
    const resolved = findOnPath('git', {
      platform: 'win32',
      env: { Path: `${shimDir};C:\\Program Files\\Git\\cmd`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      isExecutable: (p) => p === join(shimDir, 'git.cmd').replace(/\//g, '\\'),
    });
    expect(resolved?.toLowerCase().endsWith('git.cmd')).toBe(true);
  });

  it('win32: replaces a stale symlink and is idempotent', () => {
    const { shimDir, shimBin } = setup();
    installGitShimLaunchers(shimDir, shimBin, { platform: 'linux' });
    expect(lstatSync(join(shimDir, 'git')).isSymbolicLink()).toBe(true);
    installGitShimLaunchers(shimDir, shimBin, { platform: 'win32', nodePath: 'node' });
    installGitShimLaunchers(shimDir, shimBin, { platform: 'win32', nodePath: 'node' });
    expect(lstatSync(join(shimDir, 'git')).isSymbolicLink()).toBe(false);
  });

  it('POSIX: keeps the symlink to the shim binary', () => {
    const { shimDir, shimBin } = setup();
    installGitShimLaunchers(shimDir, shimBin, { platform: 'darwin' });
    expect(readlinkSync(join(shimDir, 'git'))).toBe(shimBin);
    expect(lstatSync(shimBin).mode & 0o111).not.toBe(0);
  });
});
