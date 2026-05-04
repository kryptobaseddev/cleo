/**
 * Integration test: git-log task-symbol sweeper wired to analyze pipeline.
 *
 * Verifies that after running the analyze pipeline + runGitLogTaskLinker
 * (the sequence that `cleo nexus analyze` executes), brain_page_edges
 * contains task_touches_symbol edges for commits tagged with T### in their
 * message — and that re-running produces no duplicate edges.
 *
 * Also verifies graceful failure when the target directory is not a git repo.
 *
 * Note: These tests are deliberately run `sequential` (not parallel) to
 * avoid `process.env['CLEO_HOME']` contention with other concurrently-running
 * test files that also open the nexus singleton.
 *
 * @task T1110
 * @epic T1106
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDGE_TYPES } from '../../memory/edge-types.js';
import { closeBrainDb, getBrainDb, getBrainNativeDb } from '../../store/memory-sqlite.js';
import { closeNexusDb, getNexusDb, getNexusNativeDb } from '../../store/nexus-sqlite.js';
import { runGitLogTaskLinker } from '../tasks-bridge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a file at `relPath` inside `root`, creating parent dirs as needed.
 */
function writeFile(root: string, relPath: string, content = 'export const x = 1;\n'): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/**
 * Run a git command in `cwd`, throwing on failure.
 */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
}

/**
 * Create a synthetic git repo in `dir` with `commitCount` commits, each
 * tagged with a task ID (T001, T002, …) in the commit message, and each
 * touching a distinct TypeScript file.
 *
 * Returns the list of file paths created (relative to `dir`).
 */
async function makeGitRepoWithTaskCommits(dir: string, commitCount: number): Promise<string[]> {
  // Init repo with a known user identity so git doesn't complain
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@cleo.dev');
  git(dir, 'config', 'user.name', 'CLEO Test');

  const files: string[] = [];

  for (let i = 1; i <= commitCount; i++) {
    const taskId = `T${String(i).padStart(3, '0')}`;
    const relPath = `src/module${i}.ts`;
    writeFile(dir, relPath, `export function fn${i}() { return ${i}; }\n`);
    files.push(relPath);
    git(dir, 'add', relPath);
    git(dir, 'commit', '-m', `feat(${taskId}): implement module ${i}`);
  }

  return files;
}

// ---------------------------------------------------------------------------
// Test setup / teardown
//
// CLEO_HOME is set once for the whole test suite (beforeAll/afterAll) to
// a private temp directory.  This prevents the nexus.db singleton from
// opening ~/.cleo/nexus.db, which could carry a stale last_task_linker_commit
// hash that would make git log return nothing in our synthetic repos.
// ---------------------------------------------------------------------------

let suiteDir: string;
let tmpDir: string;

beforeAll(() => {
  suiteDir = mkdtempSync(join(tmpdir(), 'task-sweeper-suite-'));
  // Point CLEO_HOME at a private directory for the duration of this suite.
  process.env['CLEO_HOME'] = join(suiteDir, 'cleo-home');
  mkdirSync(process.env['CLEO_HOME'], { recursive: true });
});

afterAll(() => {
  // Ensure all DB connections are released before removing the directory.
  closeBrainDb();
  closeNexusDb();
  delete process.env['CLEO_HOME'];
  rmSync(suiteDir, { recursive: true, force: true });
});

beforeEach(async () => {
  tmpDir = mkdtempSync(join(suiteDir, 'test-'));
  // Close any previously-open DB connections so each test starts fresh.
  closeBrainDb();
  closeNexusDb();
  // Open nexus DB and clear the last_task_linker_commit so each test sees
  // the full git history (no stale "since" hash from a previous test).
  await getNexusDb();
  const nexusNative = getNexusNativeDb();
  if (nexusNative) {
    try {
      nexusNative
        .prepare(`DELETE FROM nexus_schema_meta WHERE key = ?`)
        .run('last_task_linker_commit');
    } catch {
      // Table may not exist yet
    }
  }
  // Close again so the test body opens the DB fresh (important for getBrainDb
  // which takes projectRoot — we don't want a stale singleton open).
  closeNexusDb();
});

afterEach(() => {
  closeBrainDb();
  closeNexusDb();
});

// ---------------------------------------------------------------------------
// Suites (run sequentially to avoid CLEO_HOME mutation racing between tests)
// ---------------------------------------------------------------------------

// T1110: skip removed — runGitLogTaskLinker is wired to cleo nexus analyze
// post-hook (commit 473f7a8ff) and correctly produces task_touches_symbol
// edges for synthetic git repos with T### commit messages. All 3 acceptance
// criteria verified: edges produced, idempotency enforced, non-git graceful.
describe('task-sweeper post-analyze wiring', { sequential: true }, () => {
  it('produces task_touches_symbol edges for commits tagged T### in a synthetic git repo', async () => {
    // Arrange: synthetic repo with 3 commits, each tagged T001 / T002 / T003
    const repoDir = join(tmpDir, 'repo');
    mkdirSync(repoDir);
    await makeGitRepoWithTaskCommits(repoDir, 3);

    // Seed nexus_nodes so there are symbols to link against.
    // In a real analyze run, runPipeline would populate these.
    await getBrainDb(repoDir);
    await getNexusDb();

    const nexusNative = getNexusNativeDb()!;
    expect(nexusNative).toBeDefined();

    // Insert nexus symbols for the files touched in commits
    for (let i = 1; i <= 3; i++) {
      nexusNative
        .prepare(
          `INSERT OR REPLACE INTO nexus_nodes
             (id, project_id, kind, name, file_path, label, indexed_at, is_exported)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
        )
        .run(
          `src/module${i}.ts::fn${i}`,
          'test-proj',
          'function',
          `fn${i}`,
          `src/module${i}.ts`,
          `fn${i}`,
          1,
        );
    }

    // Act: run the sweeper (the post-hook that analyzeCommand triggers)
    const result = await runGitLogTaskLinker(repoDir);

    // Assert: 3 commits processed, 3 tasks found
    expect(result.commitsProcessed).toBe(3);
    expect(result.tasksFound).toBe(3);
    expect(result.lastCommitHash).not.toBeNull();

    // Verify brain_page_edges has task_touches_symbol edges (at least one per task)
    const brainNative = getBrainNativeDb()!;
    const rows = brainNative
      .prepare(
        `SELECT from_id, to_id, edge_type FROM brain_page_edges
           WHERE edge_type = ?`,
      )
      .all(EDGE_TYPES.TASK_TOUCHES_SYMBOL) as Array<{
      from_id: string;
      to_id: string;
      edge_type: string;
    }>;

    // Each commit touches one file which has one symbol → 3 edges minimum
    expect(rows.length).toBeGreaterThanOrEqual(3);

    // Verify all three task IDs are present
    const taskIds = new Set(rows.map((r) => r.from_id));
    expect(taskIds.has('task:T001')).toBe(true);
    expect(taskIds.has('task:T002')).toBe(true);
    expect(taskIds.has('task:T003')).toBe(true);
  }, 30_000);

  it('is idempotent — re-running the sweeper does not duplicate task_touches_symbol edges', async () => {
    // Arrange
    const repoDir = join(tmpDir, 'repo-idem');
    mkdirSync(repoDir);
    await makeGitRepoWithTaskCommits(repoDir, 2);

    await getBrainDb(repoDir);
    await getNexusDb();

    const nexusNative = getNexusNativeDb()!;
    for (let i = 1; i <= 2; i++) {
      nexusNative
        .prepare(
          `INSERT OR REPLACE INTO nexus_nodes
             (id, project_id, kind, name, file_path, label, indexed_at, is_exported)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
        )
        .run(
          `src/module${i}.ts::fn${i}`,
          'test-proj',
          'function',
          `fn${i}`,
          `src/module${i}.ts`,
          `fn${i}`,
          1,
        );
    }

    // Act: run sweeper twice
    const result1 = await runGitLogTaskLinker(repoDir);
    const result2 = await runGitLogTaskLinker(repoDir);

    const brainNative = getBrainNativeDb()!;
    const edgeCount = (
      brainNative
        .prepare(`SELECT COUNT(*) as cnt FROM brain_page_edges WHERE edge_type = ?`)
        .get(EDGE_TYPES.TASK_TOUCHES_SYMBOL) as { cnt: number }
    ).cnt;

    // First run creates edges; second run finds no new commits
    // (newest commit hash stored → sinceCommit range is empty on re-run)
    expect(result1.commitsProcessed).toBe(2);
    // Second run: no new commits since last-stored hash → 0 commits processed
    expect(result2.commitsProcessed).toBe(0);

    // Edge count must match result1 (no duplicates from second run)
    expect(edgeCount).toBe(result1.linked);
  }, 30_000);

  it('handles a non-git directory gracefully — no error thrown, warn logged', async () => {
    // Arrange: plain directory, not a git repo
    const plainDir = join(tmpDir, 'plain-dir');
    mkdirSync(plainDir);
    writeFile(plainDir, 'src/index.ts');

    await getBrainDb(plainDir);
    await getNexusDb();

    // Spy on console.warn to verify the warning is emitted
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Act: sweeper should NOT throw
    const result = await runGitLogTaskLinker(plainDir);

    // Assert: graceful empty result
    expect(result.linked).toBe(0);
    expect(result.commitsProcessed).toBe(0);
    expect(result.tasksFound).toBe(0);
    expect(result.lastCommitHash).toBeNull();

    // Assert: warning was logged
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('runGitLogTaskLinker'));

    warnSpy.mockRestore();
  }, 10_000);
});
