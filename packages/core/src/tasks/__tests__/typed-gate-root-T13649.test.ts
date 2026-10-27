/**
 * The typed-gate tree honours the evidence declaration (T13649): with
 * `CLEO_EVIDENCE_GIT_ROOT` naming a linked worktree, typed gates run in and key
 * their cache to that worktree's HEAD, even when the cwd is the store root.
 *
 * @task T13649
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { captureGateCacheState } from '../gate-result-cache.js';
import { resolveTypedGateRoot } from '../gate-runner.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'typed-gate-root-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...args], {
    cwd,
    env,
    encoding: 'utf-8',
  }).trim();
}

function repo(name: string): string {
  const dir = join(base, name);
  execFileSync('mkdir', ['-p', dir]);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), `${name}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const main = repo('main');
const wt = join(base, 'wt');
git(main, 'worktree', 'add', '-q', '-b', 'task', wt);
writeFileSync(join(wt, 'a.txt'), 'changed in the worktree\n');
git(wt, 'commit', '-q', '-am', 'worktree commit');
const other = repo('other');

describe('resolveTypedGateRoot honours the evidence declaration (T13649)', () => {
  it('a declared linked worktree wins over a store-root cwd, and the cache keys to its HEAD', async () => {
    const tree = resolveTypedGateRoot(main, main, { CLEO_EVIDENCE_GIT_ROOT: wt });
    expect(tree).toBe(realpathSync(wt));
    const state = await captureGateCacheState(tree);
    expect(state?.head).toBe(git(wt, 'rev-parse', 'HEAD'));
    expect(state?.head).not.toBe(git(main, 'rev-parse', 'HEAD'));
    // GIT_WORK_TREE is the same declaration (resolveDeclaredEvidenceGitRoot).
    expect(resolveTypedGateRoot(main, main, { GIT_WORK_TREE: wt })).toBe(realpathSync(wt));
  });

  it('without a declaration the cwd decides, as before', () => {
    expect(resolveTypedGateRoot(main, main, {})).toBe(main);
    expect(resolveTypedGateRoot(main, wt, {})).toBe(realpathSync(wt));
  });

  it('a declaration of another repository is ignored, and one naming the store root is honoured', () => {
    expect(resolveTypedGateRoot(main, main, { CLEO_EVIDENCE_GIT_ROOT: other })).toBe(main);
    expect(resolveTypedGateRoot(main, main, { CLEO_EVIDENCE_GIT_ROOT: main })).toBe(main);
    // T14058: the declaration names the repository; the cwd's linked worktree of it wins.
    expect(resolveTypedGateRoot(main, wt, { CLEO_EVIDENCE_GIT_ROOT: main })).toBe(realpathSync(wt));
  });
});
