/**
 * End-to-end integration test: spawn worktree → commit → validateAtom → destroy.
 *
 * Covers the happy-path flow that the IVTR pipeline executes for every agent task:
 *   1. Create a temporary main git repo in /tmp.
 *   2. Open a CLEO tasks.db inside it (auto-created by getTaskAccessor).
 *   3. Upsert a research-kind task (research bypasses content-intersect, T9245).
 *   4. createWorktree — provisions task/<taskId> branch + XDG worktree path.
 *   5. Commit a file on the task branch (simulates agent deliverable).
 *   6. validateAtom({ kind: 'commit', sha }) → assert ok: true.
 *   7. destroyWorktree → assert worktree dir removed.
 *
 * @task T9604
 * @epic T9586
 * @adr ADR-051
 * @adr ADR-055
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _resetCleoPlatformPathsCache, computeCanonicalProjectId } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from '../worktree-create.js';
import { destroyWorktree } from '../worktree-destroy.js';

/** Initialise a bare-minimum git repository in a temp directory. */
function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-e2e-test-'));

  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });

  // Commit something so HEAD is resolvable.
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });

  return dir;
}

function seedCleoProject(projectRoot: string, cleoHome: string): void {
  const cleoDir = join(projectRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  writeFileSync(
    join(cleoDir, 'project-info.json'),
    JSON.stringify(
      {
        projectId: 'legacy-spawn-verify-e2e',
        name: 'spawn-verify-e2e',
        lastUpdated: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  const projectId = computeCanonicalProjectId(projectRoot);
  const db = new DatabaseSync(join(cleoHome, 'nexus.db'));
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS project_registry (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL)',
    );
    db.prepare(
      'INSERT OR REPLACE INTO project_registry (project_id, project_path) VALUES (?, ?)',
    ).run(projectId, projectRoot);
  } finally {
    db.close();
  }
}

describe('spawn-verify E2E (T-WT-5)', () => {
  let mainRepo: string;
  let cleoHome: string;
  let originalCleoHome: string | undefined;

  beforeEach(() => {
    mainRepo = initTempRepo();
    cleoHome = mkdtempSync(join(tmpdir(), 'cleo-home-e2e-'));
    originalCleoHome = process.env['CLEO_HOME'];
    // Route XDG worktree storage to an isolated temp dir.
    process.env['CLEO_HOME'] = cleoHome;
    _resetCleoPlatformPathsCache();
  });

  afterEach(() => {
    // Restore env var.
    if (originalCleoHome === undefined) {
      delete process.env['CLEO_HOME'];
    } else {
      process.env['CLEO_HOME'] = originalCleoHome;
    }
    _resetCleoPlatformPathsCache();
    // Each test file runs in an isolated fork (pool: forks + isolate) so the
    // DB singleton dies with the worker process — no explicit closeDb needed.
    rmSync(cleoHome, { recursive: true, force: true });
    rmSync(mainRepo, { recursive: true, force: true });
  });

  // 120s timeout — createWorktree + git ops + validateAtom can take
  // 30-90s on cold runners (transformer warmup + copy-on-write bootstrap
  // + worktree provisioning + tasks.db open). Vitest default 5s is too
  // tight. T9604 follow-up.
  it('creates worktree, validates commit atom, then destroys worktree', {
    timeout: 120_000,
  }, async () => {
    const TASK_ID = 'T-WT-5-test';

    // -----------------------------------------------------------------
    // Step 1: bootstrap a CLEO tasks.db in the temp repo and insert a task.
    // We use a 'research' kind so T9245 content-intersect is bypassed.
    // -----------------------------------------------------------------
    seedCleoProject(mainRepo, cleoHome);
    const { getTaskAccessor } = await import('@cleocode/core/store/data-accessor');
    const accessor = await getTaskAccessor(mainRepo);
    await accessor.upsertSingleTask({
      id: TASK_ID,
      title: 'T-WT-5 spawn-verify test task',
      description: 'Integration test fixture for spawn-verify E2E pipeline.',
      status: 'active',
      priority: 'medium',
      kind: 'research',
      createdAt: new Date().toISOString(),
    });

    // -----------------------------------------------------------------
    // Step 2: createWorktree — provisions task/<taskId> branch.
    // -----------------------------------------------------------------
    const wt = await createWorktree(mainRepo, {
      taskId: TASK_ID,
      lockWorktree: false,
      // Skip CoW bootstrap to keep test fast (node_modules not needed here).
      applyIncludePatterns: false,
    });

    expect(wt.path).toBeTruthy();
    expect(wt.branch).toBe(`task/${TASK_ID}`);
    expect(existsSync(wt.path)).toBe(true);

    // -----------------------------------------------------------------
    // Step 3: simulate agent deliverable — commit a file in the worktree.
    // Configure identity in the worktree (git.config.system may be missing in CI).
    // -----------------------------------------------------------------
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: wt.path,
      stdio: 'pipe',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wt.path, stdio: 'pipe' });
    const deliverablePath = join(wt.path, 'deliverable.txt');
    writeFileSync(deliverablePath, 'agent work product\n');
    execFileSync('git', ['add', 'deliverable.txt'], { cwd: wt.path, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', `feat(${TASK_ID}): agent deliverable`], {
      cwd: wt.path,
      stdio: 'pipe',
    });

    // Capture the commit SHA.
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: wt.path,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // -----------------------------------------------------------------
    // Step 4: validateAtom — commit SHA must be reachable from task branch.
    // Uses mainRepo as projectRoot (git shares object store with worktree).
    // -----------------------------------------------------------------
    const { validateAtom } = await import('@cleocode/core/tasks');
    const result = await validateAtom({ kind: 'commit', sha }, mainRepo, TASK_ID);

    expect(result.ok).toBe(true);

    // -----------------------------------------------------------------
    // Step 5: destroyWorktree — assert directory is removed.
    // -----------------------------------------------------------------
    const destroyResult = await destroyWorktree(mainRepo, {
      taskId: TASK_ID,
      deleteBranch: true,
      force: true,
    });

    expect(destroyResult.worktreeRemoved).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
  });

  // T11033 — Verify that project-info.json is copied from the parent project's
  // .cleo/ into the worktree .cleo/ at provision time, enabling worktree-resident
  // CLEO commands to resolve the parent projectId.
  it('T11033: copies project-info.json from parent .cleo/ into worktree .cleo/ at provision time', {
    timeout: 120_000,
  }, async () => {
    const TASK_ID = 'T11033-e2e';

    // Create .cleo/project-info.json in the parent project.
    const parentCleoDir = join(mainRepo, '.cleo');
    mkdirSync(parentCleoDir, { recursive: true });
    const projectInfo = {
      projectId: 'test-project-id-11033',
      projectHash: 'deadbeef1234',
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(join(parentCleoDir, 'project-info.json'), JSON.stringify(projectInfo, null, 2));

    // Provision the worktree.
    const wt = await createWorktree(mainRepo, {
      taskId: TASK_ID,
      lockWorktree: false,
      applyIncludePatterns: false,
    });

    // Assert project-info.json was copied into the worktree .cleo/.
    const worktreeInfoPath = join(wt.path, '.cleo', 'project-info.json');
    expect(existsSync(worktreeInfoPath)).toBe(true);

    // Read and validate the content.
    const copiedContent = JSON.parse(readFileSync(worktreeInfoPath, 'utf-8'));
    expect(copiedContent.projectId).toBe('test-project-id-11033');
    expect(copiedContent.projectHash).toBe('deadbeef1234');
  });

  // T11033 — Graceful no-op when the parent project has no .cleo/project-info.json.
  it('T11033: does not fail when parent project has no .cleo/ directory', {
    timeout: 120_000,
  }, async () => {
    const TASK_ID = 'T11033-no-cleo';

    // The temp repo from beforeEach doesn't have .cleo/ — this is the default.
    const wt = await createWorktree(mainRepo, {
      taskId: TASK_ID,
      lockWorktree: false,
      applyIncludePatterns: false,
    });

    // Worktree was created successfully — the absence of project-info.json
    // should not cause any failure.
    expect(wt.path).toBeTruthy();
    expect(existsSync(wt.path)).toBe(true);
  });
});
