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
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, WORKER_INSTALL_COMMAND } from '../worktree-create.js';

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
      command: WORKER_INSTALL_COMMAND,
    });
    expect(r.preamble).toContain(WORKER_INSTALL_COMMAND);
  });

  it('a busy budget (admitInstall → null) defers the install to the worker', async () => {
    const r = await createWorktree(projectRoot, {
      taskId: 'T9202',
      lockWorktree: false,
      admitInstall: async () => null,
    });
    expect(existsSync(marker)).toBe(false);
    expect(r.install?.status).toBe('deferred');
    expect(r.install?.command).toBe(WORKER_INSTALL_COMMAND);
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
    expect(order).toEqual(['admit', 'release-after-pnpm']);
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
