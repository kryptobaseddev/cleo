/**
 * Safe completion merge (T14053): `cleo complete` merges a task branch into
 * the local default branch only for a CLEO-provisioned worktree, only into a
 * main checkout already on that branch with no uncommitted tracked changes,
 * never switches the checkout, and `cleo done --plan` shows the same decision
 * without changing git.
 *
 * @task T14053
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { integrationDisabledReason } from '../../orchestrate/worktree-complete.js';
import { appendWorktreeAuditEntry } from '../../worktree/audit.js';
import {
  completeAgentWorktreeIntegration,
  createAgentWorktree,
  integrationOutcome,
  planWorktreeIntegration,
} from '../branch-lock.js';

let base: string | undefined;

/** A repo on `main` with one commit; worktrees and audit stay inside it. */
function makeRepo(): string {
  base = mkdtempSync(join(tmpdir(), 'cleo-t14053-'));
  const root = join(base, 'project');
  mkdirSync(root);
  vi.stubEnv('XDG_DATA_HOME', join(base, 'xdg'));
  vi.stubEnv('CLEO_HOME', join(base, 'xdg', 'cleo'));
  git(root, 'init', '-q', '-b', 'main');
  identity(root);
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function identity(cwd: string): void {
  git(cwd, 'config', 'user.email', 'cleo-test@example.com');
  git(cwd, 'config', 'user.name', 'CLEO Test');
  git(cwd, 'config', 'commit.gpgsign', 'false');
}

/** A CLEO-provisioned worktree for `taskId` with one commit. */
function provisioned(root: string, taskId: string): string {
  const wt = createAgentWorktree(taskId, root);
  identity(wt.path);
  writeFileSync(join(wt.path, `${taskId}.ts`), 'export const x = 1;\n');
  git(wt.path, 'add', '.');
  git(wt.path, 'commit', '-q', '-m', `${taskId}: work`);
  return wt.path;
}

/** Every ref, HEAD and the porcelain status — what "touching git" would change. */
function gitState(root: string): string {
  return [
    git(root, 'for-each-ref'),
    git(root, 'rev-parse', '--abbrev-ref', 'HEAD'),
    git(root, 'status', '--porcelain'),
  ].join('\n--\n');
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (base) rmSync(base, { recursive: true, force: true });
  base = undefined;
});

describe('worktree integration on completion (T14053)', () => {
  it('plan and run agree on a provisioned worktree; the plan changes nothing, the run merges without pushing', () => {
    const root = makeRepo();
    provisioned(root, 'T14053A');
    const before = gitState(root);

    const plan = planWorktreeIntegration('T14053A', root, { targetBranch: 'main' });
    expect(plan.action, plan.reason).toBe('merge');
    expect(plan.branch).toBe('task/T14053A');
    expect(plan.targetBranch).toBe('main');
    expect(gitState(root)).toBe(before);

    const result = completeAgentWorktreeIntegration('T14053A', root, {
      targetBranch: 'main',
      skipFetch: true,
    });
    const outcome = integrationOutcome(result);
    expect(outcome.action, outcome.reason).toBe('merge');
    expect(outcome.mergeCommit).toBe(git(root, 'rev-parse', 'main'));
    expect(outcome.pushed).toBe(false);
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('CLEO_NO_AUTO_WORKTREE_COMPLETE and --no-integrate both skip, naming why', () => {
    expect(integrationDisabledReason(true, {})).toMatch(/--no-integrate/);
    expect(integrationDisabledReason(false, { CLEO_NO_AUTO_WORKTREE_COMPLETE: '1' })).toMatch(
      /CLEO_NO_AUTO_WORKTREE_COMPLETE/,
    );
    for (const off of ['', '0', 'false', 'FALSE']) {
      expect(integrationDisabledReason(false, { CLEO_NO_AUTO_WORKTREE_COMPLETE: off })).toBe(
        undefined,
      );
    }

    const root = makeRepo();
    const wt = provisioned(root, 'T14053B');
    const disabledReason = integrationDisabledReason(false, {
      CLEO_NO_AUTO_WORKTREE_COMPLETE: '1',
    });
    const plan = planWorktreeIntegration('T14053B', root, {
      targetBranch: 'main',
      ...(disabledReason ? { disabledReason } : {}),
    });
    expect(plan.action).toBe('skip');
    expect(plan.reason).toBe(disabledReason);
    expect(existsSync(wt)).toBe(true);
  });

  it('never merges a hand-made task/<id> branch', () => {
    const root = makeRepo();
    git(root, 'switch', '-q', '-c', 'task/T14053C');
    writeFileSync(join(root, 'stray.ts'), 'export const s = 1;\n');
    git(root, 'add', 'stray.ts');
    git(root, 'commit', '-q', '-m', 'stray work');
    const strayTip = git(root, 'rev-parse', 'HEAD');
    git(root, 'switch', '-q', 'main');
    const mainBefore = git(root, 'rev-parse', 'main');

    const plan = planWorktreeIntegration('T14053C', root, { targetBranch: 'main' });
    expect(plan.action).toBe('skip');
    expect(plan.reason).toMatch(/not provisioned by CLEO/);

    const result = completeAgentWorktreeIntegration('T14053C', root, {
      targetBranch: 'main',
      skipFetch: true,
    });
    expect(result.merged).toBe(false);
    expect(result.notProvisioned).toBe(true);
    expect(integrationOutcome(result).action).toBe('skip');
    expect(git(root, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(root, 'rev-parse', 'task/T14053C')).toBe(strayTip);
  });

  it('a worktree adopted with `cleo worktree adopt` counts as provisioned', () => {
    const root = makeRepo();
    const wt = provisioned(root, 'T14053H');
    // A worktree from before provisioning was recorded: drop its create row.
    rmSync(join(root, '.cleo', 'audit', 'worktree-lifecycle.jsonl'));
    expect(planWorktreeIntegration('T14053H', root, { targetBranch: 'main' }).action).toBe('skip');

    appendWorktreeAuditEntry(root, {
      actor: 'cleo',
      action: 'adopt',
      target: `${wt}/`,
      branch: 'task/T14053H',
      taskId: 'T14053H',
      success: true,
    });
    expect(planWorktreeIntegration('T14053H', root, { targetBranch: 'main' }).action).toBe('merge');
  });

  it("completing one task leaves another task's worktree alone, and a linked worktree is never the merge target", () => {
    const root = makeRepo();
    const other = provisioned(root, 'T14053D');
    provisioned(root, 'T14053E');
    const otherTip = git(other, 'rev-parse', 'HEAD');

    const merged = completeAgentWorktreeIntegration('T14053E', root, {
      targetBranch: 'main',
      skipFetch: true,
    });
    expect(merged.merged, merged.error).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(git(other, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/T14053D');
    expect(git(other, 'rev-parse', 'HEAD')).toBe(otherTip);

    // Run with the other task's worktree as the project root: nothing moves.
    const mainBefore = git(root, 'rev-parse', 'main');
    const fromOther = completeAgentWorktreeIntegration('T14053D', other, {
      targetBranch: 'main',
      skipFetch: true,
    });
    expect(fromOther.merged).toBe(false);
    expect(integrationOutcome(fromOther).action).not.toBe('merge');
    expect(git(other, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/T14053D');
    expect(git(root, 'rev-parse', 'main')).toBe(mainBefore);
  });

  it('refuses a dirty main checkout without switching or merging', () => {
    const root = makeRepo();
    const wt = provisioned(root, 'T14053F');
    writeFileSync(join(root, 'README.md'), '# uncommitted edit\n');
    const mainBefore = git(root, 'rev-parse', 'main');

    const plan = planWorktreeIntegration('T14053F', root, { targetBranch: 'main' });
    expect(plan.action).toBe('refuse');
    expect(plan.reason).toMatch(/uncommitted changes/);

    const result = completeAgentWorktreeIntegration('T14053F', root, {
      targetBranch: 'main',
      skipFetch: true,
    });
    expect(result.merged).toBe(false);
    expect(result.rootRefused).toBe(true);
    expect(integrationOutcome(result).action).toBe('refuse');
    expect(git(root, 'rev-parse', 'main')).toBe(mainBefore);
    expect(readFileSync(join(root, 'README.md'), 'utf-8')).toBe('# uncommitted edit\n');
    expect(existsSync(wt)).toBe(true);
  });

  it('refuses when the main checkout is on another branch, and leaves it there', () => {
    const root = makeRepo();
    provisioned(root, 'T14053G');
    git(root, 'switch', '-q', '-c', 'feature/x');
    const mainBefore = git(root, 'rev-parse', 'main');

    const result = completeAgentWorktreeIntegration('T14053G', root, {
      targetBranch: 'main',
      skipFetch: true,
    });
    expect(result.rootRefused).toBe(true);
    expect(result.error).toMatch(/on 'feature\/x', not 'main'/);
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/x');
    expect(git(root, 'rev-parse', 'main')).toBe(mainBefore);
  });
});
