/**
 * T13524 — worktree provisioning ran `pnpm install` outside the machine-wide
 * heavy queue with no opt-out. `skipInstall` provisions without installing,
 * `admitInstall` gates the install (null → deferred to the worker).
 *
 * A fake `pnpm` on PATH records each run, so "runs no pnpm" is observed, not assumed.
 *
 * @task T13524
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, workerInstallCommand } from '../worktree-create.js';
import { configureWorktreePnpmStore } from '../worktree-pnpm.js';

describe('createWorktree dependency install (T13524)', () => {
  let projectRoot: string;
  let cleoHome: string;
  let binDir: string;
  let marker: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-wt-install-'));
    cleoHome = mkdtempSync(join(tmpdir(), 'cleo-home-'));
    binDir = mkdtempSync(join(tmpdir(), 'fake-pnpm-'));
    marker = join(binDir, 'pnpm-ran');
    // Fake pnpm: record the run and create node_modules where it was invoked.
    writeFileSync(
      join(binDir, 'pnpm'),
      `#!/bin/sh\necho "$@" >> '${marker}'\nmkdir -p node_modules\n`,
    );
    chmodSync(join(binDir, 'pnpm'), 0o755);
    for (const k of ['CLEO_HOME', 'PATH']) saved[k] = process.env[k];
    process.env['CLEO_HOME'] = cleoHome;
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`;

    const git = (args: string[]) => execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe' });
    git(['init', '-q', '--initial-branch=main']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    writeFileSync(join(projectRoot, 'package.json'), '{"name":"p","version":"1.0.0"}\n');
    writeFileSync(join(projectRoot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of [projectRoot, cleoHome, binDir]) rmSync(d, { recursive: true, force: true });
  });

  it('skipInstall provisions without node_modules, runs no pnpm, and says so', async () => {
    const r = await createWorktree(projectRoot, {
      taskId: 'T9201',
      lockWorktree: false,
      skipInstall: true,
    });
    expect(existsSync(join(r.path, 'node_modules'))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(r.install).toEqual({
      status: 'skipped',
      reason: '--no-install',
      command: workerInstallCommand(r.path),
    });
    expect(r.preamble).toContain(workerInstallCommand(r.path));
    // The worker installs into the worktree's own store, never the shared one (T13538).
    expect(r.install?.command).toContain(`--store-dir '${join(r.path, '.pnpm-store')}'`);
    expect(readFileSync(join(r.path, '.npmrc'), 'utf-8')).toContain(
      `store-dir=${join(r.path, '.pnpm-store')}`,
    );
  });

  it('a busy budget (admitInstall → null) defers the install to the worker', async () => {
    const r = await createWorktree(projectRoot, {
      taskId: 'T9202',
      lockWorktree: false,
      admitInstall: async () => null,
    });
    expect(existsSync(marker)).toBe(false);
    expect(r.install?.status).toBe('deferred');
    // The worktree's pnpm already points at its own store, so a later install never shares one (T13538).
    expect(readFileSync(join(r.path, '.npmrc'), 'utf-8')).toBe(
      `store-dir=${join(r.path, '.pnpm-store')}\n`,
    );
    // `git add -A` in the worktree picks up neither the .npmrc nor the store.
    mkdirSync(join(r.path, '.pnpm-store'), { recursive: true });
    writeFileSync(join(r.path, '.pnpm-store', 'x'), 'x');
    const untracked = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: r.path,
      encoding: 'utf-8',
    });
    expect(untracked).not.toContain('.pnpm-store');
    // `.npmrc` is NOT excluded: info/exclude is the common .git's, and would hide
    // a new .npmrc in the main checkout too (T13541).
    const excludePath = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: r.path,
      encoding: 'utf-8',
    }).trim();
    const exclude = readFileSync(
      excludePath.startsWith('/') ? excludePath : join(r.path, excludePath),
      'utf-8',
    );
    expect(exclude).toContain('/.pnpm-store/');
    expect(exclude).not.toContain('/.npmrc');
    expect(r.install?.command).toBe(workerInstallCommand(r.path));
  });

  it('an admitted install runs pnpm, then releases the slot', async () => {
    let released = 0;
    const order: string[] = [];
    const r = await createWorktree(projectRoot, {
      taskId: 'T9203',
      lockWorktree: false,
      admitInstall: async () => {
        order.push('admit');
        return async () => {
          order.push(existsSync(marker) ? 'release-after-pnpm' : 'release-before-pnpm');
          released++;
        };
      },
    });
    expect(existsSync(marker)).toBe(true);
    expect(r.install?.status).toBe('installed');
    expect(released).toBe(1);
    // No .worktreeinclude lists pnpm-lock.yaml here (the default template omits it), so this
    // is the build-ready path: it, too, points .npmrc at the worktree store and excludes it (T13542).
    expect(readFileSync(join(r.path, '.npmrc'), 'utf-8')).toBe(
      `store-dir=${join(r.path, '.pnpm-store')}\n`,
    );
    mkdirSync(join(r.path, '.pnpm-store'), { recursive: true });
    writeFileSync(join(r.path, '.pnpm-store', 'x'), 'x');
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: r.path,
      encoding: 'utf-8',
    });
    expect(status).not.toContain('.pnpm-store');
    expect(order).toEqual(['admit', 'release-after-pnpm']);
  });

  it('configureWorktreePnpmStore keeps an existing .npmrc and replaces only store-dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'npmrc-'));
    try {
      writeFileSync(join(dir, '.npmrc'), 'auto-install-peers=true\nstore-dir=/shared/store\n');
      expect(configureWorktreePnpmStore(dir)).toBe(join(dir, '.pnpm-store'));
      expect(readFileSync(join(dir, '.npmrc'), 'utf-8')).toBe(
        `auto-install-peers=true\nstore-dir=${join(dir, '.pnpm-store')}\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tracked .npmrc is never edited: the worktree stays clean, the command carries --store-dir', async () => {
    writeFileSync(join(projectRoot, '.npmrc'), 'auto-install-peers=true\n');
    execFileSync('git', ['add', '.npmrc'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'track npmrc'], { cwd: projectRoot, stdio: 'pipe' });
    const r = await createWorktree(projectRoot, {
      taskId: 'T9206',
      lockWorktree: false,
      admitInstall: async () => null,
    });
    expect(readFileSync(join(r.path, '.npmrc'), 'utf-8')).toBe('auto-install-peers=true\n');
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '.npmrc'], {
      cwd: r.path,
      encoding: 'utf-8',
    });
    expect(dirty).toBe('');
    expect(r.install?.command).toContain('--store-dir');
    // The store is excluded; a tracked .gitignore is never touched.
    mkdirSync(join(r.path, '.pnpm-store'), { recursive: true });
    writeFileSync(join(r.path, '.pnpm-store', 'x'), 'x');
    expect(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: r.path,
        encoding: 'utf-8',
      }),
    ).toBe('');
  });

  it('a tracked .npmrc: the admitted install uses --store-dir and the preamble says so (T13541)', async () => {
    writeFileSync(join(projectRoot, '.npmrc'), 'auto-install-peers=true\n');
    execFileSync('git', ['add', '.npmrc'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'track npmrc'], { cwd: projectRoot, stdio: 'pipe' });
    const r = await createWorktree(projectRoot, {
      taskId: 'T9207',
      lockWorktree: false,
      admitInstall: async () => async () => {},
    });
    expect(r.install?.status).toBe('installed');
    const store = join(r.path, '.pnpm-store');
    // The fake pnpm logged its argv: the install went to the worktree's own store.
    expect(readFileSync(marker, 'utf-8')).toContain(`--store-dir ${store}`);
    expect(r.preamble).toContain(`pass --store-dir '${store}'`);
    expect(readFileSync(join(r.path, '.npmrc'), 'utf-8')).toBe('auto-install-peers=true\n');
  });

  it('the slot is released even when the install throws (guard)', async () => {
    // A pnpm that fails: the install reports failure, and the slot still comes back.
    writeFileSync(join(binDir, 'pnpm'), '#!/bin/sh\nexit 1\n');
    let released = 0;
    const r = await createWorktree(projectRoot, {
      taskId: 'T9205',
      lockWorktree: false,
      admitInstall: async () => async () => {
        released++;
      },
    });
    expect(r.install?.status).toBe('failed');
    expect(r.install?.command).toBe(workerInstallCommand(r.path));
    expect(released).toBe(1);
  });

  it('a worktree that needs no install never asks for admission', async () => {
    rmSync(join(projectRoot, 'pnpm-lock.yaml'));
    execFileSync('git', ['commit', '-qam', 'drop lockfile'], { cwd: projectRoot, stdio: 'pipe' });
    let asked = false;
    const r = await createWorktree(projectRoot, {
      taskId: 'T9204',
      lockWorktree: false,
      admitInstall: async () => {
        asked = true;
        return async () => {};
      },
    });
    expect(asked).toBe(false);
    expect(r.install?.status).toBe('not-needed');
  });
});
