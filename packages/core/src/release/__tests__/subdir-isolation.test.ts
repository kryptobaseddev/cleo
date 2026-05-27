/**
 * Sub-directory isolation tests for the release pipeline (T9583).
 *
 * Verifies that release verbs ({@link releasePlan}, {@link releaseOpen},
 * {@link releaseReconcileV2}) resolve the project root via
 * {@link getProjectRoot} even when invoked from a monorepo sub-directory.
 *
 * Regression guard: prior to T9583 these verbs called `process.cwd()`
 * directly. Running `cleo release plan` from `packages/core` would write the
 * plan file to `packages/core/.cleo/release/<v>.plan.json` instead of the
 * canonical `<root>/.cleo/release/<v>.plan.json`, fragmenting release state.
 *
 * @task T9583
 * @epic T9580
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReleasePlan, Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { releasePlan } from '../plan.js';

let testDir: string;
let subdir: string;
let originalCwd: string;

/**
 * Build a Task with sensible defaults so plan-time evidence checks pass.
 */
function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: overrides.title ?? `Task ${overrides.id}`,
    description: overrides.description ?? `Description for ${overrides.id}`,
    status: overrides.status ?? 'done',
    priority: overrides.priority ?? 'medium',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    pipelineStage: overrides.pipelineStage ?? 'contribution',
    verification: overrides.verification ?? {
      passed: true,
      round: 1,
      gates: { implemented: true },
      evidence: {
        implemented: {
          atoms: [{ kind: 'commit', sha: 'abc1234567', shortSha: 'abc1234' }],
          capturedAt: new Date().toISOString(),
          capturedBy: 'test-agent',
        },
      },
      lastAgent: null,
      lastUpdated: new Date().toISOString(),
      failureLog: [],
    },
    ...overrides,
  } as Task;
}

async function initTestGit(root: string): Promise<void> {
  execFileSync('git', ['init', '--quiet', root], { encoding: 'utf-8' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
}

async function seedEpic(epicId: string, childCount: number, root: string): Promise<void> {
  const accessor = await createSqliteDataAccessor(root);
  try {
    await accessor.setMetaValue('schema_version', '2.10.0');
    await accessor.upsertSingleTask(
      makeTask({ id: epicId, type: 'epic', title: 'Epic', pipelineStage: 'contribution' }),
    );
    for (let i = 1; i <= childCount; i++) {
      const id = `T${10000 + i}`;
      await accessor.upsertSingleTask(
        makeTask({
          id,
          parentId: epicId,
          title: `Child ${i}`,
        }),
      );
    }
  } finally {
    await accessor.close();
  }
}

beforeEach(async () => {
  originalCwd = process.cwd();
  testDir = await mkdtemp(join(tmpdir(), 'cleo-subdir-iso-'));
  await mkdir(join(testDir, '.cleo'), { recursive: true });
  writeFileSync(
    join(testDir, '.cleo', 'config.json'),
    JSON.stringify({
      enforcement: { session: { requiredForMutate: false } },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    }),
  );
  writeFileSync(
    join(testDir, '.cleo', 'project-info.json'),
    JSON.stringify({
      projectHash: 'testhash00000',
      projectId: 'test-project-id',
      projectRoot: testDir,
      projectName: 'test',
    }),
  );

  // Carve out a monorepo-like sub-directory: <root>/packages/core
  subdir = join(testDir, 'packages', 'core');
  await mkdir(subdir, { recursive: true });

  await initTestGit(testDir);
  resetDbState();
});

afterEach(async () => {
  // Always restore cwd before tearing down — otherwise vitest follow-on tests
  // inherit a removed working directory and fail with ENOENT on cwd().
  try {
    process.chdir(originalCwd);
  } catch {
    // best-effort
  }
  try {
    closeDb();
  } catch {
    // best-effort
  }
  await rm(testDir, { recursive: true, force: true });
});

// =============================================================================
// Sub-directory isolation
// =============================================================================

describe('release pipeline — sub-directory isolation (T9583)', () => {
  it('releasePlan writes .cleo/release/<v>.plan.json to project root, not subdir cwd', async () => {
    await seedEpic('T9999', 2, testDir);

    // Run from the sub-directory — this is the regression vector.
    process.chdir(subdir);

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      // NOTE: deliberately NOT passing projectRoot — exercising the walk-up
      // resolution that getProjectRoot() performs from process.cwd().
      createdBy: 'test',
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`releasePlan failed: ${result.error.message}`);

    // The plan path MUST root at testDir, NOT subdir.
    // T9601: macOS resolves /var/folders/... → /private/var/folders/... via
    // realpath. Normalize testDir to its canonical path for comparison.
    const canonicalTestDir = realpathSync(testDir);
    const expectedRootPlanPath = join(canonicalTestDir, '.cleo', 'release', 'v2026.6.0.plan.json');
    const wrongSubdirPlanPath = join(subdir, '.cleo', 'release', 'v2026.6.0.plan.json');

    expect(result.data.planPath).toBe(expectedRootPlanPath);
    expect(existsSync(expectedRootPlanPath)).toBe(true);
    expect(existsSync(wrongSubdirPlanPath)).toBe(false);

    // Plan content sanity check — confirms the plan was actually written to
    // the canonical location with the expected epic.
    const plan: ReleasePlan = JSON.parse(readFileSync(expectedRootPlanPath, 'utf-8'));
    expect(plan.epicId).toBe('T9999');
    expect(plan.tasks).toHaveLength(2);
  });

  it('releasePlan honours an explicit projectRoot override over cwd-walkup', async () => {
    await seedEpic('T9999', 1, testDir);

    // From the subdir, supply an explicit projectRoot — that path wins.
    process.chdir(subdir);

    const result = await releasePlan({
      version: 'v2026.7.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      createdBy: 'test',
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`releasePlan failed: ${result.error.message}`);

    expect(result.data.planPath).toBe(join(testDir, '.cleo', 'release', 'v2026.7.0.plan.json'));
  });

  it('releasePlan honours CLEO_ROOT env var when projectRoot omitted', async () => {
    await seedEpic('T9999', 1, testDir);

    // No cwd change — but set CLEO_ROOT to override.
    const prev = process.env['CLEO_ROOT'];
    process.env['CLEO_ROOT'] = testDir;
    try {
      const result = await releasePlan({
        version: 'v2026.8.0',
        epicId: 'T9999',
        channel: 'latest',
        scheme: 'calver',
        createdBy: 'test',
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error(`releasePlan failed: ${result.error.message}`);

      expect(result.data.planPath).toBe(join(testDir, '.cleo', 'release', 'v2026.8.0.plan.json'));
    } finally {
      if (prev === undefined) delete process.env['CLEO_ROOT'];
      else process.env['CLEO_ROOT'] = prev;
    }
  });
});
