/**
 * The one evidence-tree resolver (T14058): which checkout a task's evidence
 * describes. Change-set binding ({@link resolveChangeSetRoot} in
 * change-set.ts) and typed-gate execution ({@link resolveTypedGateRoot} in
 * gate-runner.ts) both call {@link resolveEvidenceTree}, so a test-run bound
 * in one tree is never judged by typed gates run in another.
 *
 * @task T14058
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { ChangeSetRootSource } from '@cleocode/contracts';
import { discoveryEnv, gitToplevel, resolveDeclaredEvidenceGitRoot } from '../git/work-tree.js';
import { enumerateWorktrees } from '../worktree/list.js';
import { resolveCanonicalProjectRoot, resolveEvidenceExecutionRoot } from './evidence.js';

/** A resolved evidence tree and why it was chosen. */
export interface EvidenceTree {
  /** Toplevel of the checkout the evidence describes. */
  root: string;
  /** Which tier chose it. */
  source: ChangeSetRootSource;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolvePath(path);
  }
}

/**
 * The git common directory of the checkout at `dir`, canonical, or null.
 * Ambient GIT_DIR / GIT_WORK_TREE are ignored, as every evidence probe does.
 */
function commonDirOf(dir: string): string | null {
  try {
    const args = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
    const common = execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      env: discoveryEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return common === '' ? null : canonical(common);
  } catch {
    return null;
  }
}

/** Whether `top` is a linked worktree: its `.git` is a gitlink, not the common directory. */
function isLinkedWorktree(top: string, common: string | null = commonDirOf(top)): boolean {
  return common !== null && canonical(join(top, '.git')) !== common;
}

/** The task's registered `task/<id>` worktree of the repository at `top`, if any. */
function taskWorktree(top: string, taskId: string | null): EvidenceTree | null {
  if (taskId === null) return null;
  let worktrees: ReturnType<typeof enumerateWorktrees> = [];
  try {
    worktrees = enumerateWorktrees(top);
  } catch {
    return null;
  }
  const own = worktrees.find(
    (entry) =>
      (entry.branch === `task/${taskId}` || entry.branch.startsWith(`task/${taskId}-`)) &&
      existsSync(entry.path) &&
      canonical(entry.path) !== canonical(top),
  );
  return own ? { root: own.path, source: 'task-worktree' } : null;
}

/**
 * Every candidate tree, most specific first; the caller takes the first it
 * accepts.
 *
 * With an evidence declaration (`CLEO_EVIDENCE_GIT_ROOT`, `GIT_WORK_TREE` or
 * `evidence.gitRoot`), which names the repository, not which checkout of it:
 *  1. the invocation's own linked worktree of the declared repository — even
 *     when it is the declared tree itself and the task has a `task/<id>`
 *     worktree (T14058: a separate clean verification checkout);
 *  2. the declared tree, when it is itself a linked worktree (T13649);
 *  3. the task's `task/<id>` worktree of the declared repository (T13926:
 *     invoked from the main checkout or from outside it);
 *  4. the declared tree.
 *
 * Without one: the invocation's own linked worktree of this project, the
 * task's `task/<id>` worktree, then the store root or its single child
 * checkout as {@link resolveEvidenceExecutionRoot} decides.
 */
function* candidates(
  storeRoot: string,
  taskId: string | null,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Generator<EvidenceTree> {
  const here = gitToplevel(cwd);
  const declared = resolveDeclaredEvidenceGitRoot(storeRoot, env);
  if (declared !== null) {
    const top = gitToplevel(declared.path) ?? declared.path;
    const common = commonDirOf(top);
    if (common !== null) {
      if (here !== null && isLinkedWorktree(here) && commonDirOf(here) === common)
        yield { root: here, source: 'invocation-worktree' };
      if (isLinkedWorktree(top, common)) yield { root: top, source: 'declared' };
      const own = taskWorktree(top, taskId);
      if (own) yield own;
    }
    yield { root: top, source: 'declared' };
  }
  // A declaration a caller refused still leaves the invocation's own tree.
  const base =
    declared === null
      ? resolveEvidenceExecutionRoot(storeRoot, cwd)
      : here !== null && canonical(resolveCanonicalProjectRoot(here)) === canonical(storeRoot)
        ? here
        : storeRoot;
  if (canonical(base) !== canonical(storeRoot) && isLinkedWorktree(base))
    yield { root: base, source: 'invocation-worktree' };
  const own = taskWorktree(base, taskId);
  if (own) yield own;
  yield { root: base, source: 'store' };
}

/**
 * Resolve the tree a task's evidence describes: where its change set is read,
 * its test-runs are bound and its typed gates run.
 *
 * @param storeRoot - CLEO store root.
 * @param taskId - Task whose `task/<id>` worktree may be the tree; null skips that tier.
 * @param cwd - Invocation directory.
 * @param env - Where the evidence declaration is read.
 * @param accept - Narrows the candidates (typed gates take only this project's
 *   checkouts); the first accepted wins, else the store root.
 * @returns The tree and its source tag.
 * @task T14058
 */
export function resolveEvidenceTree(
  storeRoot: string,
  taskId: string | null,
  cwd: string = process.cwd(), // CWD-OK: the invocation dir is the subject (gh#1220)
  env: NodeJS.ProcessEnv = process.env,
  accept: (root: string) => boolean = () => true,
): EvidenceTree {
  for (const tree of candidates(storeRoot, taskId, cwd, env)) {
    if (accept(tree.root)) return tree;
  }
  return { root: storeRoot, source: 'store' };
}
