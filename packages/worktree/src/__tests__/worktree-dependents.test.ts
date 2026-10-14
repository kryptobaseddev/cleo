/**
 * `destroyWorktree` — the removal `cleo cancel` runs — and the batch
 * `pruneWorktrees` keep a worktree another checkout links into (T13696).
 *
 * @task T13696
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeProjectHash } from '../paths.js';
import { destroyWorktree } from '../worktree-destroy.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

const prevCleoHome = process.env['CLEO_HOME'];
let base: string;
let repo: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'wt-dependents-')));
  process.env['CLEO_HOME'] = base;
  repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'user.email', 't@e.x']);
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
  root = join(base, 'worktrees', computeProjectHash(repo));
});

afterEach(() => {
  if (prevCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevCleoHome;
  rmSync(base, { recursive: true, force: true });
});

describe('destroyWorktree disposal guard (T13696)', () => {
  it('keeps a worktree a sibling links into through node_modules/.pnpm', async () => {
    const owner = join(root, 'T971');
    const sibling = join(root, 'T972');
    git(repo, ['worktree', 'add', '-q', '-b', 'task/T971', owner]);
    git(repo, ['worktree', 'add', '-q', '-b', 'task/T972', sibling]);
    mkdirSync(join(owner, 'node_modules', '.pnpm', 'dep@1.0.0'), { recursive: true });
    writeFileSync(join(owner, 'node_modules', '.pnpm', 'dep@1.0.0', 'x.js'), 'x\n');
    mkdirSync(join(sibling, 'node_modules', '.pnpm'), { recursive: true });
    const link = join(sibling, 'node_modules', '.pnpm', 'dep@1.0.0');
    symlinkSync(join(owner, 'node_modules', '.pnpm', 'dep@1.0.0'), link);

    const result = await destroyWorktree(repo, { taskId: 'T971', force: true });

    expect(result.worktreeRemoved).toBe(false);
    expect(result.branchDeleted).toBe(false);
    expect(result.kept?.dependents).toEqual([link]);
    expect(existsSync(owner)).toBe(true);
    expect(readFileSync(join(link, 'x.js'), 'utf-8')).toBe('x\n');
  });
});
