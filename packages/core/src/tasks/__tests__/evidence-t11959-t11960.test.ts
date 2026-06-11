/**
 * Regression tests for T11959 and T11960.
 *
 * T11960 (DHQ-083): AC prose-token false rejection
 *   The `extractTaskAcFiles` function previously extracted URL-shaped prose
 *   tokens (e.g. "claude.com/platform.claude.com") as declared file paths,
 *   causing false E_EVIDENCE_CONTENT_MISMATCH rejections. Fix: tokens must
 *   pass the `isRepoPathLike` guard before being added to the AC-files set.
 *
 * T11959 (DHQ-075/076): Worktree-aware file: atom resolution
 *   `validateFiles` previously checked only `existsSync` at the canonical
 *   root, failing for files that exist only on the task branch (worktree
 *   context). Fix: when `taskId` is provided and the file is absent on disk,
 *   fall back to `git show task/<taskId>:<path>`.
 *
 * DHQ-083 companion (a): Commit reachability from main
 *   The T9178 branch-scope check rejected commits reachable from main but not
 *   yet on the task branch (e.g. owner commits to main directly, or branch
 *   cleaned up after merge). Fix: accept commits reachable from main/master.
 *
 * DHQ-083 companion (b): Merge-commit first-parent diff
 *   `gitShowFiles` previously used `git show --name-only` which returns an
 *   empty list for merge commits, causing the content-intersect gate to
 *   report "touches no files" and reject valid evidence. Fix: use
 *   `git diff-tree --no-commit-id -r --name-only -m --first-parent`.
 *
 * @task T11959
 * @task T11960
 * @adr ADR-051
 * @adr ADR-051-worktree-extension
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { extractTaskAcFiles, isRepoPathLike, validateAtom } from '../evidence.js';

// =============================================================================
// Test helpers
// =============================================================================

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString();
}

function initGitRepo(dir: string): void {
  git(dir, ['init', '-q', '--initial-branch=main']);
  git(dir, ['config', 'user.name', 'T11959 Probe']);
  git(dir, ['config', 'user.email', 'probe@example.com']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

function gitCommitFile(dir: string, relPath: string, content: string, message: string): string {
  const fullPath = join(dir, relPath);
  const slash = relPath.lastIndexOf('/');
  if (slash > 0) {
    mkdirSync(join(dir, relPath.slice(0, slash)), { recursive: true });
  }
  writeFileSync(fullPath, content);
  git(dir, ['add', relPath]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

// =============================================================================
// T11960 — isRepoPathLike heuristic unit tests
// =============================================================================

describe('T11960 — isRepoPathLike heuristic', () => {
  it('accepts tokens starting with packages/', () => {
    expect(isRepoPathLike('packages/core/src/tasks/evidence.ts')).toBe(true);
  });

  it('accepts tokens starting with src/', () => {
    expect(isRepoPathLike('src/lib/util.ts')).toBe(true);
  });

  it('accepts tokens starting with scripts/', () => {
    expect(isRepoPathLike('scripts/lint-evidence.mjs')).toBe(true);
  });

  it('accepts tokens starting with docs/', () => {
    expect(isRepoPathLike('docs/architecture/overview.md')).toBe(true);
  });

  it('accepts .ts extension tokens from any path', () => {
    expect(isRepoPathLike('some/unknown/path/file.ts')).toBe(true);
  });

  it('accepts .json extension tokens', () => {
    expect(isRepoPathLike('config/settings.json')).toBe(true);
  });

  it('accepts .sql extension tokens', () => {
    expect(isRepoPathLike('migrations/0001_init.sql')).toBe(true);
  });

  it('accepts .md extension tokens', () => {
    expect(isRepoPathLike('docs/release-notes.md')).toBe(true);
  });

  it('REJECTS URL-shaped tokens — claude.com/platform.claude.com (T11960 regression)', () => {
    // This is the exact failing case from the DHQ-083 report.
    expect(isRepoPathLike('claude.com/platform.claude.com')).toBe(false);
  });

  it('REJECTS generic internet hostname/path tokens', () => {
    expect(isRepoPathLike('example.com/some-page')).toBe(false);
    expect(isRepoPathLike('api.github.com/repos/org/repo')).toBe(false);
  });

  it('REJECTS tokens without a known extension and no known prefix', () => {
    expect(isRepoPathLike('unknown/path/no-extension')).toBe(false);
  });
});

// =============================================================================
// T11960 — extractTaskAcFiles does not include URL-prose tokens
// =============================================================================

describe('T11960 — extractTaskAcFiles filters URL prose tokens', () => {
  it('does NOT include "claude.com/platform.claude.com" as a declared AC file', () => {
    const r = extractTaskAcFiles({
      files: [],
      acceptance: [
        'Anthropic OAuth login via platform.claude.com migrated to claude.com/platform.claude.com',
        'Update packages/core/src/llm/oauth.ts to use the new endpoint',
      ],
    });
    // URL-shaped token must NOT be in the returned list.
    expect(r).not.toContain('claude.com/platform.claude.com');
    // Legitimate repo path MUST be captured.
    expect(r).toContain('packages/core/src/llm/oauth.ts');
  });

  it('returns null when all tokens are URL-shaped prose (no real paths)', () => {
    const r = extractTaskAcFiles({
      files: [],
      acceptance: [
        'Migrate authentication from platform.claude.com to claude.com/platform.claude.com',
        'No code files mentioned here',
      ],
    });
    // No repo-path-like tokens → null (skip content-intersect entirely).
    expect(r).toBeNull();
  });

  it('explicit task.files bypasses the heuristic (direct URL-looking entry is preserved)', () => {
    // When a human explicitly passes a file via --files, trust it unconditionally.
    const r = extractTaskAcFiles({
      files: ['packages/core/src/tasks/evidence.ts'],
      acceptance: ['anything including claude.com/platform'],
    });
    expect(r).toEqual(['packages/core/src/tasks/evidence.ts']);
  });
});

// =============================================================================
// T11959 — validateFiles git-show fallback for branch-only files
// =============================================================================

describe('T11959 — validateFiles git-show fallback', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    initGitRepo(env.tempDir);
    // Anchor HEAD with an initial commit.
    gitCommitFile(env.tempDir, 'README.md', 'init\n', 'init');
  });

  afterEach(async () => {
    await env.cleanup();
    resetDbState();
  });

  it('ACCEPTS a file that exists only on the task branch (git-show fallback)', async () => {
    // Create a task branch.
    git(env.tempDir, ['checkout', '-b', 'task/T11959_FILES']);

    // Commit a file that will NOT exist on disk at the canonical root.
    gitCommitFile(
      env.tempDir,
      'packages/core/src/tasks/branch-only.ts',
      'export const x = 1;\n',
      'feat: branch-only file',
    );

    // Switch back to main — file is gone from disk.
    git(env.tempDir, ['checkout', 'main']);

    // Seed the task in main's DB.
    await seedTasks(env.accessor, [
      {
        id: 'T11959_FILES',
        title: 'worktree-file-test',
        description: 'validate files fallback',
        status: 'pending',
        priority: 'medium',
        files: ['packages/core/src/tasks/branch-only.ts'],
        acceptance: ['packages/core/src/tasks/branch-only.ts must exist'],
      } as Partial<Task> & { id: string },
    ]);

    // validateAtom with files: pointing to the branch-only file.
    // With taskId provided, should fall back to git-show task/T11959_FILES.
    const r = await validateAtom(
      { kind: 'files', paths: ['packages/core/src/tasks/branch-only.ts'] },
      env.tempDir,
      'T11959_FILES',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.atom.kind).toBe('files');
      expect(r.atom.files).toHaveLength(1);
      expect(r.atom.files[0]?.path).toBe('packages/core/src/tasks/branch-only.ts');
      // sha256 must be non-empty.
      expect(r.atom.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('REJECTS a branch-only file when no taskId is provided (no fallback)', async () => {
    // Same setup but omit taskId — old behaviour must be preserved.
    git(env.tempDir, ['checkout', '-b', 'task/T11959_NO_TASK']);
    gitCommitFile(env.tempDir, 'packages/core/src/tasks/no-task-branch.ts', 'x\n', 'feat');
    git(env.tempDir, ['checkout', 'main']);

    const r = await validateAtom(
      { kind: 'files', paths: ['packages/core/src/tasks/no-task-branch.ts'] },
      env.tempDir,
      // no taskId
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codeName).toBe('E_EVIDENCE_INVALID');
      expect(r.reason).toMatch(/does not exist/i);
    }
  });

  it('ACCEPTS a file that exists on disk (filesystem path — primary resolution)', async () => {
    // Verify the non-fallback path still works.
    gitCommitFile(env.tempDir, 'packages/core/src/on-disk.ts', 'export const y = 2;\n', 'feat');

    const r = await validateAtom(
      { kind: 'files', paths: ['packages/core/src/on-disk.ts'] },
      env.tempDir,
    );
    expect(r.ok).toBe(true);
  });
});

// =============================================================================
// DHQ-083 companion (a) — commit reachable from main is accepted
// =============================================================================

describe('DHQ-083 companion (a) — commit reachable from main accepted', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    initGitRepo(env.tempDir);
    gitCommitFile(env.tempDir, 'README.md', 'init\n', 'init');
  });

  afterEach(async () => {
    await env.cleanup();
    resetDbState();
  });

  it('ACCEPTS commit on main when task branch also exists (main-reachability fix)', async () => {
    // Seed task with AC file.
    await seedTasks(env.accessor, [
      {
        id: 'T_MAIN_REACH',
        title: 'main-reachability',
        description: 'accept commits on main',
        status: 'pending',
        priority: 'medium',
        files: ['src/main-commit.ts'],
        acceptance: ['src/main-commit.ts must implement feature'],
      } as Partial<Task> & { id: string },
    ]);

    // Commit the AC file directly to main.
    mkdirSync(join(env.tempDir, 'src'), { recursive: true });
    const sha = gitCommitFile(
      env.tempDir,
      'src/main-commit.ts',
      'export const f = 1;\n',
      'feat(T_MAIN_REACH): implement on main',
    );

    // Create the task branch WITHOUT the commit (branch from main BEFORE the
    // commit, so the SHA is reachable from main but NOT from task/<id>).
    // We need to create the branch at an earlier point — use the initial commit.
    const initSha = git(env.tempDir, ['rev-parse', 'HEAD~1']).trim();
    git(env.tempDir, ['branch', 'task/T_MAIN_REACH', initSha]);

    // Now validateAtom: commit is on main but NOT on task/T_MAIN_REACH.
    // Before the fix this would return ok:false ("not reachable from task/...").
    // After the fix it should return ok:true (reachable from main).
    const r = await validateAtom({ kind: 'commit', sha }, env.tempDir, 'T_MAIN_REACH');
    expect(r.ok).toBe(true);
  });
});

// =============================================================================
// DHQ-083 companion (b) — merge-commit first-parent diff
// =============================================================================

describe('DHQ-083 companion (b) — merge-commit first-parent diff', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    initGitRepo(env.tempDir);
    gitCommitFile(env.tempDir, 'README.md', 'init\n', 'init');
  });

  afterEach(async () => {
    await env.cleanup();
    resetDbState();
  });

  it('ACCEPTS a merge commit SHA when its diff includes the AC file', async () => {
    // Seed task with AC file.
    await seedTasks(env.accessor, [
      {
        id: 'T_MERGE',
        title: 'merge-commit-test',
        description: 'merge commit diff',
        status: 'pending',
        priority: 'medium',
        files: ['src/merge-feature.ts'],
        acceptance: ['src/merge-feature.ts must implement merge feature'],
      } as Partial<Task> & { id: string },
    ]);

    // Create task branch and add the AC file on it.
    git(env.tempDir, ['checkout', '-b', 'task/T_MERGE']);
    mkdirSync(join(env.tempDir, 'src'), { recursive: true });
    gitCommitFile(
      env.tempDir,
      'src/merge-feature.ts',
      'export const merge = true;\n',
      'feat(T_MERGE): merge feature',
    );

    // Merge the task branch back into main (creates a merge commit).
    git(env.tempDir, ['checkout', 'main']);
    git(env.tempDir, ['merge', '--no-ff', 'task/T_MERGE', '-m', 'Merge task/T_MERGE into main']);
    const mergeSha = git(env.tempDir, ['rev-parse', 'HEAD']).trim();

    // The merge commit SHA must pass content-intersect (it "touches" src/merge-feature.ts
    // via first-parent diff against main before the merge).
    const r = await validateAtom({ kind: 'commit', sha: mergeSha }, env.tempDir, 'T_MERGE');
    expect(r.ok).toBe(true);
  });

  it('REJECTS merge commit when first-parent diff does NOT include AC file', async () => {
    // Seed task requiring a file that the merge commit does not touch.
    await seedTasks(env.accessor, [
      {
        id: 'T_MERGE_MISS',
        title: 'merge-commit-miss',
        description: 'merge commit miss',
        status: 'pending',
        priority: 'medium',
        files: ['src/required-but-absent.ts'],
        acceptance: ['src/required-but-absent.ts must be changed'],
      } as Partial<Task> & { id: string },
    ]);

    // Create task branch that modifies an UNRELATED file.
    git(env.tempDir, ['checkout', '-b', 'task/T_MERGE_MISS']);
    gitCommitFile(env.tempDir, 'src/unrelated.ts', 'x\n', 'feat: unrelated');

    // Merge back into main.
    git(env.tempDir, ['checkout', 'main']);
    git(env.tempDir, ['merge', '--no-ff', 'task/T_MERGE_MISS', '-m', 'Merge task/T_MERGE_MISS']);
    const mergeSha = git(env.tempDir, ['rev-parse', 'HEAD']).trim();

    const r = await validateAtom({ kind: 'commit', sha: mergeSha }, env.tempDir, 'T_MERGE_MISS');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codeName).toBe('E_EVIDENCE_CONTENT_MISMATCH');
    }
  });
});
