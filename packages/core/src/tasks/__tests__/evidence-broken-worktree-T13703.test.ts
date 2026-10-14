/**
 * A bind root git cannot open with the inherited repo pointers ignored is
 * refused, never judged (T13703), and a stale verdict names the reflog it read
 * (T13702).
 *
 * @task T13703
 * @task T13702
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { brokenWorkTreeReason } from '../../git/work-tree.js';
import { validateAtom } from '../evidence.js';
import { reportFreshness } from '../test-run-binding.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'evidence-broken-wt-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const clean = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  return env;
};
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = clean()): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...args], {
    cwd,
    env,
    encoding: 'utf-8',
  }).trim();
}
function repo(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'A']);
  return dir;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A typecheck receipt that started at `startTime`. */
function receipt(dir: string, startTime: number): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'qa.json');
  writeFileSync(
    path,
    JSON.stringify({
      kind: 'typecheck',
      command: ['tsc', '--noEmit'],
      exitCode: 0,
      diagnostics: { errors: 0 },
      roots: ['.'],
      startTime,
    }),
  );
  return path;
}

describe('a worktree git cannot open on its own is refused, not judged (T13703)', () => {
  it('a broken .git link with GIT_DIR exported refuses a stale receipt with E_EVIDENCE_GIT_ROOT', async () => {
    const main = repo('main');
    const wt = join(base, 'wt');
    git(main, ['worktree', 'add', '-q', '-b', 'task', wt]);
    const moved = join(base, 'main-moved');
    renameSync(main, moved); // wt/.git now points nowhere
    const env = { ...clean(), GIT_DIR: join(moved, '.git', 'worktrees', 'wt'), GIT_WORK_TREE: wt };
    const ranAt = Date.now() - 5_000;
    const path = receipt(join(wt, 'tmp'), ranAt);
    // HEAD moves after the run, through the exported pointers only.
    writeFileSync(join(wt, 'a.ts'), 'export const a = 2;\n');
    git(wt, ['commit', '-q', '-am', 'after the run'], env);
    vi.stubEnv('GIT_DIR', env.GIT_DIR);
    vi.stubEnv('GIT_WORK_TREE', wt);
    vi.stubEnv('CLEO_EVIDENCE_GIT_ROOT', wt);
    expect(brokenWorkTreeReason(wt)).toMatch(/git worktree repair/);
    const result = await validateAtom({ kind: 'qa-run', path }, moved);
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: false,
      codeName: 'E_EVIDENCE_GIT_ROOT',
      reason: expect.stringMatching(
        /its \.git does not resolve.*GIT_DIR and GIT_WORK_TREE are exported.*does not make it usable.*git worktree repair.*CLEO_EVIDENCE_GIT_ROOT.*evidence\.gitRoot/,
      ),
    });
  });

  it('a declared evidence.gitRoot wins: a non-git store root with GIT_DIR exported binds to the declared checkout', async () => {
    const store = join(base, 'store');
    mkdirSync(join(store, '.cleo'), { recursive: true });
    writeFileSync(
      join(store, '.cleo', 'project-context.json'),
      JSON.stringify({ evidence: { gitRoot: 'repo' } }),
    );
    const sub = join(store, 'repo');
    mkdirSync(sub);
    git(sub, ['init', '-q', '-b', 'main']);
    writeFileSync(join(sub, 'a.ts'), 'export const a = 1;\n');
    git(sub, ['add', '.']);
    git(sub, ['commit', '-q', '-m', 'A']);
    vi.stubEnv('GIT_DIR', join(base, 'nowhere', '.git'));
    expect(brokenWorkTreeReason(store)).toMatch(/GIT_DIR is exported/);
    const path = receipt(join(sub, 'tmp'), Date.now());
    const result = await validateAtom({ kind: 'qa-run', path }, store);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok && result.atom.kind === 'qa-run')
      expect(result.atom.headSha).toBe(git(sub, ['rev-parse', 'HEAD']));
  });

  it('a genuine non-git root keeps its no-binding behaviour', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    expect(brokenWorkTreeReason(plain, {})).toBeNull();
    const path = receipt(join(plain, 'tmp'), Date.now());
    const result = await validateAtom({ kind: 'qa-run', path }, plain);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});

describe('a stale verdict names the reflog it read (T13702)', () => {
  it('a receipt copied into a newer worktree names that worktree and its reflog', async () => {
    const main = repo('main2');
    const wt1 = join(base, 'wt1');
    git(main, ['worktree', 'add', '-q', '-b', 'run', wt1]);
    await sleep(2_100);
    const ranAt = Date.now();
    await sleep(2_100);
    // After the run: wt1's HEAD moves, and a newer worktree is created.
    git(wt1, ['commit', '-q', '--allow-empty', '-m', 'after the run']);
    const wt2 = join(base, 'wt2');
    git(main, ['worktree', 'add', '-q', '-b', 'verify', wt2]);
    const copied = receipt(join(wt2, 'tmp'), ranAt);
    const fresh = reportFreshness(ranAt, copied, wt1, 'qa-run');
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) {
      expect(fresh.reason).toContain(`not in the reflog of ${realpathSync(wt2)}`);
      expect(fresh.reason).toMatch(/worktrees\/wt2\/logs\/HEAD/);
      expect(fresh.reason).toMatch(/keep a receipt in the worktree it ran in/);
    }
  });
});
