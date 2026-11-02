/**
 * T14189 — `git -C <path>` does NOT override an inherited `GIT_DIR`: inside a
 * git hook (or a sweep it started) every merged-cleanup check would read, and
 * every removal act on, the hook's repository. The cleanup's git runner must
 * act on `<path>`'s own repository.
 *
 * Real git, scratch repositories under a temp dir.
 *
 * @task T14189
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoveryEnv } from '../../git/work-tree.js';
import { cleanupGit } from '../merged-cleanup.js';

let base: string;
let target: string;
let hookRepo: string;

/** A repository with one commit on `branch`. */
function repo(name: string, branch: string): string {
  const dir = join(base, name);
  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: base, env: discoveryEnv(), stdio: 'ignore' });
  run('init', '-q', '-b', branch, dir);
  run(
    '-C',
    dir,
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
  return dir;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cleo-t14189-cleanup-'));
  target = repo('target', 'target-branch');
  hookRepo = repo('hook', 'hook-branch');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

describe('T14189: merged-cleanup git ignores an inherited GIT_DIR', () => {
  it('reads the repository named by -C, where plain git -C would read the hook’s', () => {
    vi.stubEnv('GIT_DIR', join(hookRepo, '.git'));
    const head = ['rev-parse', '--abbrev-ref', 'HEAD'];
    // The hazard: with an inherited GIT_DIR, `git -C target` answers for the hook's repository.
    const plain = execFileSync('git', ['-C', target, ...head], { encoding: 'utf8' }).trim();
    expect(plain).toBe('hook-branch');
    // The cleanup's runner answers for target.
    expect(cleanupGit(target, head)).toBe('target-branch');
  });
});
