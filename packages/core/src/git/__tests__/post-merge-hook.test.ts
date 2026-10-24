/**
 * The shipped `post-merge` hook (T14010) starts nothing unless the
 * `cleo.nexusReindexOnMerge` git marker is set AND HEAD is on the base
 * branch: a disabled project or another branch pays no process start.
 * A stub `cleo` on PATH records whether it was called.
 *
 * @task T14010
 */

import { execFileSync, spawnSync } from 'node:child_process';
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'templates',
  'git-hooks',
  'post-merge',
);

let dir: string;
let repo: string;
let called: string;
let bin: string;

const git = (args: string[]): void => {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-post-merge-hook-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 't']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'init']);
  called = join(dir, 'called');
  bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'cleo'), `#!/bin/sh\necho "$*" >> "${called}"\n`);
  chmodSync(join(bin, 'cleo'), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the hook in the repo with the stub cleo first on PATH; true when cleo was started. */
async function runHook(): Promise<boolean> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` };
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  const result = spawnSync('/bin/sh', [HOOK], { cwd: repo, env, encoding: 'utf-8' });
  expect(result.status).toBe(0);
  // The hook backgrounds cleo; give a started process a moment to write.
  for (let i = 0; i < 20 && !existsSync(called); i++) await new Promise((r) => setTimeout(r, 50));
  return existsSync(called);
}

describe('post-merge hook (T14010)', () => {
  it('starts nothing when the marker is unset', async () => {
    expect(await runHook()).toBe(false);
  });

  it('starts nothing on a branch other than the base branch', async () => {
    git(['config', 'cleo.nexusReindexOnMerge', 'true']);
    git(['switch', '-q', '-c', 'feature']);
    expect(await runHook()).toBe(false);
  });

  it('starts the reindex when enabled on the base branch', async () => {
    git(['config', 'cleo.nexusReindexOnMerge', 'true']);
    expect(await runHook()).toBe(true);
    expect(readFileSync(called, 'utf-8')).toContain('nexus reindex-on-merge');
  });
});
