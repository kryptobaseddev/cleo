/**
 * T9245 — validateCommit content-intersect + critical-gate override rejection.
 *
 * Reproduces the loophole proven 2026-05-12: validateCommit at evidence.ts
 * only checked SHA reachability, never the commit's diff against the task's
 * AC-listed files. 13 mis-completed tasks across the 2026-05-11 campaign
 * exploited this. This suite locks the fix in place.
 *
 * Test matrix:
 *  - extractTaskAcFiles: pure-function unit tests over task.files / AC-parsing
 *  - validateCommit content-intersect:
 *      A) AC files declared, commit touches unrelated file → REJECT
 *      B) AC files declared, commit touches AC file        → ACCEPT
 *      C) No AC files declared                              → ACCEPT (legacy)
 *      D) task.kind = 'research'                            → ACCEPT (no code)
 *      E) Directory-style AC entry, commit inside it        → ACCEPT
 *  - revalidateEvidence critical-gate override rejection:
 *      F) implemented gate + override-only evidence → REJECT
 *      G) testsPassed gate + override-only evidence → REJECT
 *      H) qaPassed gate + override-only evidence    → ACCEPT (non-critical)
 *      I) implemented gate + override + hard atom   → ACCEPT
 *
 * Audit: `.cleo/rcasd/campaign-validation-2026-05-12/SYNTHESIS.md`
 *
 * @task T9245
 * @adr ADR-051
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import {
  CRITICAL_GATES_NO_OVERRIDE,
  extractTaskAcFiles,
  resolveCanonicalProjectRoot,
  revalidateEvidence,
  validateAtom,
} from '../evidence.js';

// =============================================================================
// Test helpers
// =============================================================================

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString();
}

function initGitRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'T9245 Probe']);
  git(dir, ['config', 'user.email', 'probe@example.com']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

function gitCommitFile(dir: string, relPath: string, content: string, message: string): string {
  const fullPath = join(dir, relPath);
  // Ensure parent dir exists.
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
// extractTaskAcFiles — pure-function unit tests
// =============================================================================

describe('T9245 — extractTaskAcFiles', () => {
  it('returns task.files when populated', () => {
    const r = extractTaskAcFiles({
      files: ['packages/core/src/a.ts', 'packages/core/src/b.ts'],
      acceptance: ['ignored'],
    });
    expect(r).toEqual(['packages/core/src/a.ts', 'packages/core/src/b.ts']);
  });

  it('parses path-like tokens from AC strings when files empty', () => {
    const r = extractTaskAcFiles({
      files: [],
      acceptance: [
        'packages/core/src/tasks/evidence.ts contains validateCommit',
        'Update packages/cleo/src/cli/commands/verify.ts',
      ],
    });
    expect(r).toContain('packages/core/src/tasks/evidence.ts');
    expect(r).toContain('packages/cleo/src/cli/commands/verify.ts');
  });

  it('returns null when neither files nor parseable AC paths', () => {
    const r = extractTaskAcFiles({
      files: [],
      acceptance: ['Write some tests', 'Make it work'],
    });
    expect(r).toBeNull();
  });

  it('returns null on undefined inputs', () => {
    expect(extractTaskAcFiles({})).toBeNull();
  });

  it('deduplicates path tokens across AC strings', () => {
    const r = extractTaskAcFiles({
      files: [],
      acceptance: ['edit packages/core/src/x.ts', 'also test packages/core/src/x.ts'],
    });
    expect(r).toEqual(['packages/core/src/x.ts']);
  });
});

// =============================================================================
// validateCommit content-intersect — integration tests against real DB + git
// =============================================================================

describe('T9245 — validateCommit content-intersect (probe reproduction)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    // Initialize git repo at the same dir as the cleo DB so validateCommit
    // resolves the same projectRoot for both.
    initGitRepo(env.tempDir);
    // First commit to anchor HEAD.
    gitCommitFile(env.tempDir, 'README.md', 'init\n', 'init');
  });

  afterEach(async () => {
    await env.cleanup();
    resetDbState();
  });

  it('REJECTS commit that touches no AC files (probe scenario)', async () => {
    // Seed a task whose AC declares one file path…
    await seedTasks(env.accessor, [
      {
        id: 'T_PROBE',
        title: 'probe',
        description: 'probe-test',
        status: 'pending',
        priority: 'medium',
        files: ['src/fileA.ts'],
        acceptance: ['src/fileA.ts contains marker_A'],
      } as Partial<Task> & { id: string },
    ]);

    // …then make a commit that ONLY touches an unrelated file.
    const sha = gitCommitFile(env.tempDir, 'src/unrelated.ts', 'noise\n', 'unrelated commit');

    const r = await validateAtom({ kind: 'commit', sha }, env.tempDir, 'T_PROBE');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codeName).toBe('E_EVIDENCE_CONTENT_MISMATCH');
      expect(r.reason).toMatch(/does not intersect/i);
      expect(r.reason).toMatch(/T9245/);
    }
  });

  it('ACCEPTS commit that touches a declared AC file', async () => {
    await seedTasks(env.accessor, [
      {
        id: 'T_OK',
        title: 'happy path',
        description: 'happy-path-test',
        status: 'pending',
        priority: 'medium',
        files: ['src/fileA.ts'],
        acceptance: ['src/fileA.ts contains marker_A'],
      } as Partial<Task> & { id: string },
    ]);

    const sha = gitCommitFile(env.tempDir, 'src/fileA.ts', 'marker_A\n', 'real implementation');

    const r = await validateAtom({ kind: 'commit', sha }, env.tempDir, 'T_OK');
    expect(r.ok).toBe(true);
  });

  it('ACCEPTS when task declares no AC files (legacy tolerance)', async () => {
    await seedTasks(env.accessor, [
      {
        id: 'T_LEGACY',
        title: 'legacy',
        description: 'legacy-test',
        status: 'pending',
        priority: 'medium',
        files: [],
        acceptance: ['Make it work somehow'],
      } as Partial<Task> & { id: string },
    ]);

    const sha = gitCommitFile(env.tempDir, 'anywhere.ts', 'x\n', 'unrelated');

    const r = await validateAtom({ kind: 'commit', sha }, env.tempDir, 'T_LEGACY');
    expect(r.ok).toBe(true);
  });

  it('ACCEPTS for research tasks regardless of diff', async () => {
    await seedTasks(env.accessor, [
      {
        id: 'T_RES',
        title: 'research-only',
        description: 'research-test',
        status: 'pending',
        priority: 'medium',
        kind: 'research',
        files: ['src/never-touched.ts'],
        acceptance: ['src/never-touched.ts must exist'],
      } as Partial<Task> & { id: string },
    ]);

    const sha = gitCommitFile(env.tempDir, 'docs/notes.md', 'finding\n', 'research notes');

    const r = await validateAtom({ kind: 'commit', sha }, env.tempDir, 'T_RES');
    expect(r.ok).toBe(true);
  });

  it('ACCEPTS commit inside a directory-style AC entry', async () => {
    await seedTasks(env.accessor, [
      {
        id: 'T_DIR',
        title: 'dir-scope',
        description: 'dir-scope-test',
        status: 'pending',
        priority: 'medium',
        files: ['packages/core/src/tasks/'],
        acceptance: ['change something under packages/core/src/tasks/'],
      } as Partial<Task> & { id: string },
    ]);

    const sha = gitCommitFile(env.tempDir, 'packages/core/src/tasks/foo.ts', 'x\n', 'inside dir');

    const r = await validateAtom({ kind: 'commit', sha }, env.tempDir, 'T_DIR');
    expect(r.ok).toBe(true);
  });

  it('skips content-intersect entirely when no taskId is provided', async () => {
    // Back-compat: callers that pass no taskId get the legacy
    // reachability-only behavior.
    const sha = gitCommitFile(env.tempDir, 'misc.ts', 'x\n', 'no-task-context');

    const r = await validateAtom({ kind: 'commit', sha }, env.tempDir);
    expect(r.ok).toBe(true);
  });
});

// =============================================================================
// revalidateEvidence critical-gate override rejection
// =============================================================================

describe('T9245 — revalidateEvidence rejects override-only on critical gates', () => {
  it('exports CRITICAL_GATES_NO_OVERRIDE = [implemented, testsPassed]', () => {
    expect(CRITICAL_GATES_NO_OVERRIDE).toEqual(['implemented', 'testsPassed']);
  });

  it('REJECTS override-only evidence on implemented gate', async () => {
    const r = await revalidateEvidence(
      {
        atoms: [{ kind: 'override', reason: 'owner-override-test' }],
        capturedAt: new Date().toISOString(),
        capturedBy: 'owner',
        override: true,
        overrideReason: 'owner-override-test',
      },
      '/tmp',
      'implemented',
    );
    expect(r.stillValid).toBe(false);
    expect(r.failedAtoms[0]?.reason).toMatch(/T9245/);
    expect(r.failedAtoms[0]?.reason).toMatch(/critical/i);
  });

  it('REJECTS override-only evidence on testsPassed gate', async () => {
    const r = await revalidateEvidence(
      {
        atoms: [{ kind: 'override', reason: 'tests-bypass' }],
        capturedAt: new Date().toISOString(),
        capturedBy: 'owner',
        override: true,
        overrideReason: 'tests-bypass',
      },
      '/tmp',
      'testsPassed',
    );
    expect(r.stillValid).toBe(false);
    expect(r.failedAtoms[0]?.reason).toMatch(/testsPassed/);
  });

  it('ACCEPTS override-only evidence on qaPassed (non-critical)', async () => {
    const r = await revalidateEvidence(
      {
        atoms: [{ kind: 'override', reason: 'qa-waiver' }],
        capturedAt: new Date().toISOString(),
        capturedBy: 'owner',
        override: true,
        overrideReason: 'qa-waiver',
      },
      '/tmp',
      'qaPassed',
    );
    expect(r.stillValid).toBe(true);
  });

  it('ACCEPTS override-only evidence on documented (non-critical)', async () => {
    const r = await revalidateEvidence(
      {
        atoms: [{ kind: 'override', reason: 'docs-trivial' }],
        capturedAt: new Date().toISOString(),
        capturedBy: 'owner',
        override: true,
        overrideReason: 'docs-trivial',
      },
      '/tmp',
      'documented',
    );
    expect(r.stillValid).toBe(true);
  });

  it('skips override-rejection when gate parameter omitted (back-compat)', async () => {
    // Pre-T9245 callers (no gate arg) still get the old override pass-through.
    const r = await revalidateEvidence(
      {
        atoms: [{ kind: 'override', reason: 'legacy' }],
        capturedAt: new Date().toISOString(),
        capturedBy: 'owner',
        override: true,
        overrideReason: 'legacy',
      },
      '/tmp',
    );
    expect(r.stillValid).toBe(true);
  });
});

// =============================================================================
// T-WT-2 — resolveCanonicalProjectRoot
// =============================================================================

describe('T-WT-2 — resolveCanonicalProjectRoot', () => {
  it('returns projectRoot unchanged when .git is a directory (normal repo)', () => {
    // Use the actual monorepo root which has a real .git directory.
    const root = '/mnt/projects/cleocode';
    const result = resolveCanonicalProjectRoot(root);
    expect(result).toBe(root);
  });

  it('returns projectRoot unchanged when .git does not exist (non-git dir)', () => {
    const result = resolveCanonicalProjectRoot('/tmp');
    expect(result).toBe('/tmp');
  });

  it('parses a gitlink file and returns the main repo root', () => {
    // Construct a synthetic gitlink in a temp dir.
    const tmp = '/tmp/cleo-wt2-gitlink-test';
    mkdirSync(tmp, { recursive: true });
    // Write a fake gitlink pointing to a synthetic worktrees entry.
    // The main repo root would be: /mnt/projects/cleocode
    // gitdir format: /mnt/projects/cleocode/.git/worktrees/T9601
    writeFileSync(
      join(tmp, '.git'),
      'gitdir: /mnt/projects/cleocode/.git/worktrees/T9601\n',
      'utf8',
    );
    const result = resolveCanonicalProjectRoot(tmp);
    expect(result).toBe('/mnt/projects/cleocode');
  });

  it('returns projectRoot as-is when gitlink content is malformed', () => {
    const tmp = '/tmp/cleo-wt2-malformed-test';
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, '.git'), 'not a valid gitdir line\n', 'utf8');
    const result = resolveCanonicalProjectRoot(tmp);
    expect(result).toBe(tmp);
  });

  it('DB read uses canonical root when projectRoot is a git worktree', async () => {
    // Set up: main repo at env.tempDir with a real git worktree at a subdirectory.
    // Tasks are seeded in the MAIN DB (env.tempDir/.cleo/tasks.db).
    // The worktree path has a gitlink file pointing back to the main repo.
    // resolveCanonicalProjectRoot must map the worktree path back to env.tempDir,
    // ensuring getTaskAccessor reads from the main DB — not a stale worktree copy.
    const env: TestDbEnv = await createTestDb();

    // Init the main repo.
    execFileSync('git', ['init', '-q'], { cwd: env.tempDir });
    execFileSync('git', ['config', 'user.name', 'T-WT-2 Probe'], { cwd: env.tempDir });
    execFileSync('git', ['config', 'user.email', 'probe@wt2.test'], { cwd: env.tempDir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: env.tempDir });
    writeFileSync(join(env.tempDir, 'README.md'), 'init\n');
    execFileSync('git', ['add', 'README.md'], { cwd: env.tempDir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: env.tempDir });

    // Seed task with declared AC file in the MAIN DB.
    await seedTasks(env.accessor, [
      {
        id: 'T_WT2_DB',
        title: 'wt2-db-test',
        description: 'verify DB reads from canonical root',
        status: 'pending',
        priority: 'medium',
        files: ['src/wt2-file.ts'],
        acceptance: ['src/wt2-file.ts implements feature'],
      } as Partial<Task> & { id: string },
    ]);

    // Commit the AC file in the main repo.
    mkdirSync(join(env.tempDir, 'src'), { recursive: true });
    writeFileSync(join(env.tempDir, 'src', 'wt2-file.ts'), 'export const x = 1;\n', 'utf8');
    execFileSync('git', ['add', 'src/wt2-file.ts'], { cwd: env.tempDir });
    execFileSync('git', ['commit', '-q', '-m', 'feat(T_WT2_DB): implement'], {
      cwd: env.tempDir,
    });
    const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.tempDir })
      .toString()
      .trim();

    // Create a real git worktree via `git worktree add` so the gitlink file is
    // properly written and git operations on the worktree path work correctly.
    const worktreeDir = join(env.tempDir, 'wt-branch');
    execFileSync('git', ['worktree', 'add', '--detach', worktreeDir, 'HEAD'], {
      cwd: env.tempDir,
    });

    // Verify resolveCanonicalProjectRoot maps the real worktree back to the main repo.
    // Use realpathSync for both sides to handle macOS /var → /private/var symlink.
    const resolved = resolveCanonicalProjectRoot(worktreeDir);
    expect(resolved).toBe(realpathSync(env.tempDir));

    // validateAtom with projectRoot = MAIN repo (simulating step 2.5 resolution)
    // should accept the commit since its diff intersects the declared AC file.
    // This is the primary regression scenario: Bug C (stale DB) is fixed if
    // the canonical root is used for the DB read even when ALS returns worktree path.
    const r = await validateAtom({ kind: 'commit', sha: commitSha }, env.tempDir, 'T_WT2_DB');
    expect(r.ok).toBe(true);

    await env.cleanup();
    resetDbState();
  });
});

// =============================================================================
// T-WT-3 — getEffectiveHead wired into validateCommit
// =============================================================================

describe('T-WT-3 — validateCommit uses getEffectiveHead for ancestry check', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    // Initialize git repo in the test dir.
    execFileSync('git', ['init', '-q'], { cwd: env.tempDir });
    execFileSync('git', ['config', 'user.name', 'T-WT-3 Probe'], { cwd: env.tempDir });
    execFileSync('git', ['config', 'user.email', 'probe@wt3.test'], { cwd: env.tempDir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: env.tempDir });
    // Initial commit to anchor HEAD on main.
    writeFileSync(join(env.tempDir, 'README.md'), 'init\n');
    execFileSync('git', ['add', 'README.md'], { cwd: env.tempDir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: env.tempDir });
  });

  afterEach(async () => {
    await env.cleanup();
    resetDbState();
  });

  it('ACCEPTS commit on task branch using getEffectiveHead (T-WT-3 regression lock)', async () => {
    // Seed a task declaring one AC file.
    await seedTasks(env.accessor, [
      {
        id: 'T_WT3_OK',
        title: 'wt3-ok',
        description: 'worktree-aware HEAD resolution',
        status: 'pending',
        priority: 'medium',
        files: ['src/wt3-file.ts'],
        acceptance: ['src/wt3-file.ts implements feature'],
      } as Partial<Task> & { id: string },
    ]);

    // Create the task branch.
    execFileSync('git', ['checkout', '-b', 'task/T_WT3_OK'], { cwd: env.tempDir });

    // Commit the AC file to the task branch — this commit is NOT on main.
    mkdirSync(join(env.tempDir, 'src'), { recursive: true });
    writeFileSync(join(env.tempDir, 'src', 'wt3-file.ts'), 'export const wt3 = 1;\n', 'utf8');
    execFileSync('git', ['add', 'src/wt3-file.ts'], { cwd: env.tempDir });
    execFileSync('git', ['commit', '-q', '-m', 'feat(T_WT3_OK): implement wt3-file'], {
      cwd: env.tempDir,
    });
    const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.tempDir })
      .toString()
      .trim();

    // Confirm commit is NOT reachable from main branch HEAD.
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: env.tempDir });

    // validateAtom with projectRoot = main repo, taskId = task that owns the branch.
    // Before T-WT-3 fix, this would return ok:false ("not reachable from HEAD").
    // After fix, getEffectiveHead resolves "task/T_WT3_OK" and the check passes.
    const r = await validateAtom({ kind: 'commit', sha: commitSha }, env.tempDir, 'T_WT3_OK');
    expect(r.ok).toBe(true);
  });

  it('REJECTS commit on task branch when no taskId provided (backward-compat)', async () => {
    // Seed a task (not used for the commit check — just ensures the branch is real).
    await seedTasks(env.accessor, [
      {
        id: 'T_WT3_BC',
        title: 'wt3-backcompat',
        description: 'backward-compat test',
        status: 'pending',
        priority: 'medium',
        files: [],
        acceptance: ['anything'],
      } as Partial<Task> & { id: string },
    ]);

    // Create task branch and commit to it.
    execFileSync('git', ['checkout', '-b', 'task/T_WT3_BC'], { cwd: env.tempDir });
    writeFileSync(join(env.tempDir, 'some-file.ts'), 'x\n', 'utf8');
    execFileSync('git', ['add', 'some-file.ts'], { cwd: env.tempDir });
    execFileSync('git', ['commit', '-q', '-m', 'feat(T_WT3_BC): unmerged commit'], {
      cwd: env.tempDir,
    });
    const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.tempDir })
      .toString()
      .trim();

    // Switch back to main so HEAD points to main tip (commit NOT reachable from HEAD).
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: env.tempDir });

    // NO taskId provided → getEffectiveHead returns "HEAD" → commit not reachable → ok:false.
    const r = await validateAtom({ kind: 'commit', sha: commitSha }, env.tempDir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Error message should mention "HEAD" (not task branch name) to confirm
      // backward-compatible code path is in effect.
      expect(r.reason).toMatch(/HEAD/i);
      expect(r.codeName).toBe('E_EVIDENCE_INVALID');
    }
  });
});
