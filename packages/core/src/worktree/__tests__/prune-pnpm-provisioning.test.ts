/**
 * `cleo worktree prune --orphaned` (`pruneOrphanedWorktreesByStatus`) end to
 * end with no mocks (T14552): real git, the real listing and the real
 * disposal proof. A finished, merged worktree whose only extra content is the
 * pnpm provisioning spawn wrote (the store-dir `.npmrc` and the worktree's
 * `.pnpm-store/`) is removed; one that also holds a real untracked file is kept.
 *
 * @task T14552
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureWorktreePnpmStore } from '@cleocode/worktree';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listWorktrees } from '../list.js';
import { pruneOrphanedWorktreesByStatus } from '../prune.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

const prevCleoHome = process.env['CLEO_HOME'];
let base: string;
let repo: string;

/**
 * A finished worktree: provisioned as spawn does, one commit merged into main
 * with `--no-ff`. Branch and directory name no task, so no task store is read;
 * a zero-day stale window makes it a disposal candidate.
 */
function finishedWorktree(name: string): string {
  const wt = join(base, 'worktrees', name);
  git(repo, 'worktree', 'add', '-q', '-b', `work/${name}`, wt);
  expect(configureWorktreePnpmStore(wt)).toBe(join(wt, '.pnpm-store'));
  const files = join(wt, '.pnpm-store', 'v10', 'files', '0a');
  mkdirSync(files, { recursive: true });
  writeFileSync(join(files, '57539c3ea497'), 'cached\n');
  writeFileSync(join(wt, `${name}.ts`), `export const ${name} = 1;\n`);
  git(wt, 'add', `${name}.ts`);
  git(wt, 'commit', '-q', '-m', `add ${name}`);
  git(repo, 'merge', '-q', '--no-ff', '-m', `merge ${name}`, `work/${name}`);
  return wt;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'prune-pnpm-')));
  process.env['CLEO_HOME'] = join(base, 'cleo-home');
  repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@e.x');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  if (prevCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevCleoHome;
  rmSync(base, { recursive: true, force: true });
});

describe('cleo worktree prune --orphaned with CLEO pnpm provisioning (T14552)', () => {
  it('removes the merged worktree holding only the generated .npmrc and store, keeps real work', async () => {
    const clean = finishedWorktree('done');
    const dirty = finishedWorktree('wip');
    writeFileSync(join(dirty, 'notes.md'), 'unsaved work\n');
    expect(readFileSync(join(clean, '.npmrc'), 'utf-8')).toBe(
      `store-dir=${join(clean, '.pnpm-store')}\n`,
    );
    expect(git(clean, 'status', '--porcelain')).toBe('');

    const listed = await listWorktrees({ projectRoot: repo, staleDays: 0 });
    expect(listed.success).toBe(true);
    const byPath = new Map((listed.success ? listed.data.worktrees : []).map((w) => [w.path, w]));
    expect(byPath.get(clean)).toMatchObject({ isMerged: true, statusCategory: 'redundant' });
    expect(byPath.get(dirty)?.statusCategory).toBe('keep');

    const result = await pruneOrphanedWorktreesByStatus({
      projectRoot: repo,
      staleDays: 0,
      auditLogPath: join(base, 'audit.jsonl'),
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.prunedCount).toBe(1);
    expect(existsSync(clean)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(clean);
    // The worktree with a real untracked file is never removed.
    expect(existsSync(join(dirty, 'notes.md'))).toBe(true);
  });
});
