/**
 * Typed-gate git reads ignore an inherited `GIT_DIR`/`GIT_WORK_TREE`
 * (T13695): the cache state's HEAD and dirty fingerprint come from the
 * resolved tree, never from a repository the environment happens to point at.
 *
 * @task T13695
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { captureGateCacheState } from '../gate-result-cache.js';
import { resolveTypedGateRoot } from '../gate-runner.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'typed-gate-ambient-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...args], {
    cwd,
    env,
    encoding: 'utf-8',
  }).trim();
}

function repo(name: string, content: string): string {
  const dir = join(base, name);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), content);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', name);
  return dir;
}

const main = repo('main', 'main\n');
const wt = join(base, 'wt');
git(main, 'worktree', 'add', '-q', '-b', 'task', wt);
writeFileSync(join(wt, 'a.txt'), 'worktree\n');
git(wt, 'commit', '-q', '-am', 'worktree commit');
const other = repo('other', 'other\n');

describe('typed-gate git reads ignore ambient GIT_DIR/GIT_WORK_TREE (T13695)', () => {
  it('GIT_DIR exported to another repository does not move the cache state of the resolved tree', async () => {
    vi.stubEnv('GIT_DIR', join(other, '.git'));
    vi.stubEnv('GIT_WORK_TREE', other);
    // An uncommitted tracked edit in `other` would move its fingerprint, not wt's.
    writeFileSync(join(other, 'a.txt'), 'dirty other\n');
    const state = await captureGateCacheState(wt);
    expect(state?.head).toBe(git(wt, 'rev-parse', 'HEAD'));
    expect(state?.head).not.toBe(git(other, 'rev-parse', 'HEAD'));
    vi.unstubAllEnvs();
    const clean = await captureGateCacheState(wt);
    expect(state?.dirtyFingerprint).toBe(clean?.dirtyFingerprint);
  });

  it("axiom's workaround (GIT_DIR and GIT_WORK_TREE exported to the worktree) still resolves and keys to it", async () => {
    vi.stubEnv('GIT_DIR', git(wt, 'rev-parse', '--absolute-git-dir'));
    vi.stubEnv('GIT_WORK_TREE', wt);
    const tree = resolveTypedGateRoot(main, main);
    expect(tree).toBe(realpathSync(wt));
    expect((await captureGateCacheState(tree))?.head).toBe(git(wt, 'rev-parse', 'HEAD'));
  });
});
