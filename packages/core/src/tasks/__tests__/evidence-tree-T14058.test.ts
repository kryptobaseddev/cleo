/**
 * One evidence-tree resolver for change-set binding and typed gates (T14058).
 *
 * Layout: the main checkout (the CLEO store root), the task's `task/<id>`
 * worktree, and a separate clean verification worktree detached at the task
 * tip. In each layout the change-set root and the typed-gate root are the same
 * tree, with the expected source tag.
 *
 * @task T14058
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveChangeSetRoot } from '../change-set.js';
import { resolveEvidenceTree } from '../evidence-tree.js';
import { resolveTypedGateRoot } from '../gate-runner.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'evidence-tree-')));
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

const TASK = 'T950';
const main = join(base, 'main');
execFileSync('mkdir', ['-p', main]);
git(main, 'init', '-q', '-b', 'main');
writeFileSync(join(main, 'a.txt'), 'main\n');
git(main, 'add', '.');
git(main, 'commit', '-q', '-m', 'init');
const taskWt = join(base, 'wt-task');
git(main, 'worktree', 'add', '-q', '-b', `task/${TASK}`, taskWt);
writeFileSync(join(taskWt, 'a.txt'), 'task change\n');
git(taskWt, 'commit', '-q', '-am', `${TASK}: change`);
// The separate clean verification checkout, detached at the task tip.
const verifyWt = join(base, 'wt-verify');
git(main, 'worktree', 'add', '-q', '--detach', verifyWt, `task/${TASK}`);

/** Both paths for one invocation: they must agree. */
function both(cwd: string, declared: string): { binding: string; source: string; typed: string } {
  const env = { CLEO_EVIDENCE_GIT_ROOT: declared };
  const cs = resolveChangeSetRoot(main, TASK, cwd, env);
  return {
    binding: realpathSync(cs.root),
    source: cs.source,
    typed: realpathSync(resolveTypedGateRoot(main, cwd, env, TASK)),
  };
}

describe('typed gates and change-set binding share one resolver (T14058)', () => {
  it('declared = cwd = a linked worktree: that worktree, even though a task/<id> worktree exists (AC2)', () => {
    const r = both(verifyWt, verifyWt);
    expect(r).toEqual({
      binding: realpathSync(verifyWt),
      source: 'invocation-worktree',
      typed: realpathSync(verifyWt),
    });
  });

  it('declared = main checkout, cwd = a linked worktree: both pick the cwd worktree (AC3)', () => {
    const r = both(verifyWt, main);
    expect(r).toEqual({
      binding: realpathSync(verifyWt),
      source: 'invocation-worktree',
      typed: realpathSync(verifyWt),
    });
  });

  it('invoked from the main checkout with a declaration: both pick the task worktree (AC4, T13926)', () => {
    const r = both(main, main);
    expect(r).toEqual({
      binding: realpathSync(taskWt),
      source: 'task-worktree',
      typed: realpathSync(taskWt),
    });
  });

  it('the change-set root is the shared resolver verbatim (AC1)', () => {
    for (const [cwd, declared] of [
      [verifyWt, verifyWt],
      [verifyWt, main],
      [main, main],
    ] as const) {
      const env = { CLEO_EVIDENCE_GIT_ROOT: declared };
      expect(resolveChangeSetRoot(main, TASK, cwd, env)).toEqual(
        resolveEvidenceTree(main, TASK, cwd, env),
      );
    }
  });

  it('typed gates skip a candidate outside this project, as before', () => {
    const other = join(base, 'other');
    execFileSync('mkdir', ['-p', other]);
    git(other, 'init', '-q', '-b', 'main');
    writeFileSync(join(other, 'b.txt'), 'other\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'init');
    const env = { CLEO_EVIDENCE_GIT_ROOT: other };
    expect(resolveChangeSetRoot(main, TASK, verifyWt, env)).toEqual({
      root: realpathSync(other),
      source: 'declared',
    });
    expect(resolveTypedGateRoot(main, verifyWt, env, TASK)).toBe(realpathSync(verifyWt));
  });
});
