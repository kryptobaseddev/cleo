/**
 * Integration test for the T9686-D primary-worktree safety net.
 *
 * Unlike the heavily-mocked unit suite in `list.test.ts` and `prune.test.ts`,
 * this spec spawns REAL git in a freshly-initialized tmp repo so we exercise
 * the end-to-end path: `git worktree list --porcelain` → classifier →
 * prune candidate filter. The repro the regression here matches exactly what
 * the user reported: running `cleo worktree prune --orphaned --dry-run` on the
 * canonical project root must NEVER mark the project root as a prune candidate.
 *
 * @task T9686-D
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listWorktrees } from '../list.js';
import { pruneOrphanedWorktreesByStatus } from '../prune.js';

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'cleo-t9686d-primary-'));
  // Initialize a minimal repo with one commit on `main` so `merge-base
  // --is-ancestor main main` succeeds — that's the exact condition that
  // caused the regression.
  run(repoRoot, ['init', '-q', '-b', 'main']);
  run(repoRoot, ['config', 'user.email', 't9686d@example.invalid']);
  run(repoRoot, ['config', 'user.name', 'T9686-D Test']);
  writeFileSync(join(repoRoot, 'README.md'), 'hello\n');
  run(repoRoot, ['add', 'README.md']);
  run(repoRoot, ['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  try {
    rmSync(repoRoot, { recursive: true, force: true });
  } catch {
    /* tmpdir cleanup best-effort */
  }
});

describe('T9686-D primary-worktree guard (real git)', () => {
  it('classifies a bare main checkout as `active`, NOT `merged`', async () => {
    const result = await listWorktrees({ projectRoot: repoRoot });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');

    expect(result.data.worktrees).toHaveLength(1);
    const primary = result.data.worktrees[0];
    expect(primary?.branch).toBe('main');
    // The branch IS reachable from itself — that part is reality.
    expect(primary?.isMerged).toBe(true);
    // The category overrides the merged status so prune candidacy is denied.
    expect(primary?.statusCategory).toBe('active');
  });

  it('prune --dry-run never lists the primary worktree as a candidate', async () => {
    const auditLogPath = join(repoRoot, 'audit.jsonl');
    const result = await pruneOrphanedWorktreesByStatus({
      projectRoot: repoRoot,
      auditLogPath,
      dryRun: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    const candidatePaths = result.data.outcomes.map((o) => o.path);
    expect(candidatePaths).not.toContain(repoRoot);
    expect(result.data.outcomes).toHaveLength(0);
  });

  it('secondary worktrees on merged branches are still pruneable', async () => {
    // Create a fully-merged secondary worktree: branch off main, never diverge.
    // `git worktree add` checks out a new ref pointing at the same commit, so
    // `merge-base --is-ancestor <branch> main` returns exit 0.
    //
    // We use a non-`task/` branch name so the classifier doesn't treat the
    // worktree as an orphan (taskId set, owningTaskStatus null → orphan in
    // precedence). The intent here is to exercise the `merged` candidacy
    // path, not orphan detection — those have separate coverage.
    const secondaryPath = join(repoRoot, 'wt-secondary');
    run(repoRoot, ['worktree', 'add', '-b', 'feat/already-merged', secondaryPath]);

    try {
      const list = await listWorktrees({ projectRoot: repoRoot });
      if (!list.success) throw new Error('expected success');
      // The primary stays active; the secondary classifies as merged.
      const primary = list.data.worktrees.find((w) => w.path === repoRoot);
      expect(primary?.statusCategory).toBe('active');
      const secondary = list.data.worktrees.find((w) => w.branch === 'feat/already-merged');
      expect(secondary?.statusCategory).toBe('merged');

      // Prune dry-run should pick up the secondary but skip the primary.
      const prune = await pruneOrphanedWorktreesByStatus({
        projectRoot: repoRoot,
        auditLogPath: join(repoRoot, 'audit.jsonl'),
        dryRun: true,
      });
      if (!prune.success) throw new Error('expected success');
      const paths = prune.data.outcomes.map((o) => o.path);
      expect(paths).not.toContain(repoRoot);
      expect(paths.some((p) => p.endsWith('/wt-secondary'))).toBe(true);
    } finally {
      // Clean up the secondary worktree before tmpdir nuke (otherwise git's
      // admin entry under .git/worktrees/wt-secondary lingers across tests).
      try {
        run(repoRoot, ['worktree', 'remove', '--force', secondaryPath]);
      } catch {
        /* best-effort */
      }
    }
  });
});
