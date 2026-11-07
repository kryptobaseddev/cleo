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
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

// `repoRoot` is realpath-resolved at fixture setup so path comparisons against
// `git worktree list --porcelain` output match on macOS. On macOS, `tmpdir()`
// returns `/var/folders/...` which is a symlink to `/private/var/folders/...`,
// and git reports the realpath-resolved form — a raw string compare would fail
// only on macOS (T9757 / T9736 / T9738-E carryforward).
let repoRoot: string;

beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t9686d-primary-')));
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
    // T14236: its HEAD is main's own tip, not merged work of its own, so it is
    // not merged; the primary guard keeps it `active` either way.
    expect(primary?.isMerged).toBe(false);
    // The category denies prune candidacy.
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
    // Create a truly merged secondary worktree: a branch with a commit of its
    // own, merged into main with a merge commit. (T14236: a branch that never
    // diverged is a fresh worktree, which stays `active` and is not pruneable.)
    //
    // A non-`task/` branch with no stored task: T14274 makes it a disposal
    // candidate once idle past the stale window, so the test passes a zero-day
    // window; the disposal proof then holds (clean, its work is on main).
    const secondaryPath = join(repoRoot, 'wt-secondary');
    run(repoRoot, ['worktree', 'add', '-b', 'feat/already-merged', secondaryPath]);
    writeFileSync(join(secondaryPath, 'work.md'), 'merged work\n');
    run(secondaryPath, ['add', 'work.md']);
    run(secondaryPath, ['commit', '-q', '-m', 'work']);
    run(repoRoot, [
      'merge',
      '-q',
      '--no-ff',
      '-m',
      'merge feat/already-merged',
      'feat/already-merged',
    ]);

    try {
      const list = await listWorktrees({ projectRoot: repoRoot, staleDays: 0 });
      if (!list.success) throw new Error('expected success');
      // The primary stays active; the secondary is redundant (T14274).
      const primary = list.data.worktrees.find((w) => w.path === repoRoot);
      expect(primary?.statusCategory).toBe('active');
      const secondary = list.data.worktrees.find((w) => w.branch === 'feat/already-merged');
      expect(secondary?.isMerged).toBe(true);
      expect(secondary?.statusCategory).toBe('redundant');

      // Prune dry-run should pick up the secondary but skip the primary.
      const prune = await pruneOrphanedWorktreesByStatus({
        projectRoot: repoRoot,
        auditLogPath: join(repoRoot, 'audit.jsonl'),
        dryRun: true,
        staleDays: 0,
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
