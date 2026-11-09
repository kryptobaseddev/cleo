/**
 * `cleo nexus hooks install|uninstall` (T12349) in real temp git repos: the
 * install is idempotent and chains a hook already there, a commit starts a
 * detached `cleo nexus auto-reindex` that git never waits for, and uninstall
 * restores every previous hook exactly. A stub `cleo` first on PATH records
 * its calls, so no real analysis starts.
 *
 * @task T12349
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCleoHooks } from '../../git/hooks-install.js';
import { setNexusHooks } from '../reindex-on-merge.js';

let dir: string;
let repo: string;
let hooks: string;
let called: string;
let bin: string;

/** Env for a git run with the stub cleo on PATH and the refresh not forced off. */
function hookEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` };
  delete env['CLEO_NEXUS_AUTO_REINDEX'];
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  return env;
}

const git = (args: string[], input?: string): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: hookEnv(), input }).trim();

/** Wait for the detached stub to record a call; the lines it recorded. */
async function calls(): Promise<string[]> {
  for (let i = 0; i < 40 && !existsSync(called); i++) await new Promise((r) => setTimeout(r, 50));
  return existsSync(called) ? readFileSync(called, 'utf-8').trim().split('\n') : [];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-nexus-hooks-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  for (const [k, v] of [
    ['user.name', 't'],
    ['user.email', 't@example.com'],
    ['commit.gpgsign', 'false'],
  ])
    execFileSync('git', ['config', k, v], { cwd: repo });
  hooks = join(repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  called = join(dir, 'called');
  bin = join(dir, 'bin');
  mkdirSync(bin);
  // Sleeps long after recording, so a git that waited for it would be slow.
  writeFileSync(join(bin, 'cleo'), `#!/bin/sh\necho "$*" >> "${called}"\nsleep 5\n`);
  chmodSync(join(bin, 'cleo'), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('nexus hooks (T12349)', () => {
  it('install is idempotent and chains an existing hook, which still runs with its stdin', async () => {
    const ran = join(dir, 'foreign-ran');
    const foreign = `#!/bin/sh\necho "post-rewrite $1 $(cat)" >> "${ran}"\n`;
    writeFileSync(join(hooks, 'post-rewrite'), foreign, { mode: 0o755 });

    const first = await setNexusHooks(repo, true);
    expect(first.installed).toEqual(['post-commit', 'post-checkout', 'post-rewrite']);
    expect(readFileSync(join(hooks, 'post-rewrite.cleo-chained'), 'utf-8')).toBe(foreign);
    const installed = readFileSync(join(hooks, 'post-rewrite'), 'utf-8');
    const second = await setNexusHooks(repo, true);
    expect(second.skipped).toEqual([]);
    expect(readFileSync(join(hooks, 'post-rewrite'), 'utf-8')).toBe(installed);
    expect(readFileSync(join(hooks, 'post-rewrite.cleo-chained'), 'utf-8')).toBe(foreign);

    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-m', 'init']);
    git(['commit', '-q', '--amend', '-m', 'amended']);
    // The chained hook got post-rewrite's argument and its stdin (old new sha pairs).
    expect(readFileSync(ran, 'utf-8')).toMatch(/^post-rewrite amend [0-9a-f]{40} [0-9a-f]{40}/);
  });

  it('a commit starts a detached incremental reindex that never delays git', async () => {
    await setNexusHooks(repo, true);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(['add', 'a.txt']);
    const started = Date.now();
    const result = spawnSync('git', ['commit', '-q', '-m', 'init'], {
      cwd: repo,
      env: hookEnv(),
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    // The stub sleeps 5s after recording: git returned without waiting for it.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await calls()).toContain('nexus auto-reindex');
  });

  it('starts nothing when turned off or in a linked worktree', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-m', 'init']);
    await installCleoHooks(repo, { names: ['post-commit'] });
    git(['worktree', 'add', '-q', '-b', 'side', join(dir, 'linked')]);
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'linked'], {
      cwd: join(dir, 'linked'),
      env: hookEnv(),
    });
    git(['config', 'cleo.nexusAutoReindex', 'false']);
    git(['commit', '-q', '--allow-empty', '-m', 'off']);
    expect(await calls()).toEqual([]);
  });

  it('uninstall restores every previous hook exactly, and init/upgrade then leave them alone', async () => {
    // A non-executable foreign hook: chained by moving it, restored with its mode.
    const foreign = '#!/bin/sh\n# team hook\n';
    writeFileSync(join(hooks, 'post-checkout'), foreign, { mode: 0o644 });
    chmodSync(join(hooks, 'post-checkout'), 0o644);

    await setNexusHooks(repo, true);
    await setNexusHooks(repo, true);
    const removed = await setNexusHooks(repo, false);
    expect(removed.installed.sort()).toEqual(['post-checkout', 'post-commit', 'post-rewrite']);
    expect(readFileSync(join(hooks, 'post-checkout'), 'utf-8')).toBe(foreign);
    expect(statSync(join(hooks, 'post-checkout')).mode & 0o777).toBe(0o644);
    expect(existsSync(join(hooks, 'post-checkout.cleo-chained'))).toBe(false);
    expect(existsSync(join(hooks, 'post-commit'))).toBe(false);
    expect(existsSync(join(hooks, 'post-rewrite'))).toBe(false);
    expect(git(['config', '--bool', '--get', 'cleo.nexusAutoReindex'])).toBe('false');

    // The default install (cleo init / upgrade) respects the opt-out.
    const reinstall = await installCleoHooks(repo);
    expect(reinstall.installed).not.toContain('post-commit');
    expect(readFileSync(join(hooks, 'post-checkout'), 'utf-8')).toBe(foreign);
  });

  it('uninstall preserves a hook changed since installation', async () => {
    await setNexusHooks(repo, true);
    writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\n# edited by hand\n');
    const removed = await setNexusHooks(repo, false);
    expect(removed.skipped).toEqual(['post-commit']);
    expect(readFileSync(join(hooks, 'post-commit'), 'utf-8')).toContain('edited by hand');
  });
});
