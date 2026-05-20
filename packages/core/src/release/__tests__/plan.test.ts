/**
 * Tests for {@link releasePlan} — SPEC-T9345 §4.2 release plan verb.
 *
 * Covers:
 *  - Happy path: valid plan written, releases row UPSERTed, LAFS envelope.
 *  - E_EPIC_NOT_FOUND when the epic does not exist.
 *  - E_EPIC_EMPTY when the epic has no eligible children.
 *  - E_CHANNEL_MISMATCH on incompatible channel + version pair.
 *  - E_EVIDENCE_INSUFFICIENT when a task lacks evidence atoms.
 *  - Idempotency — re-running with identical inputs is a no-op modulo lastInvokedAt.
 *  - Plan file structure is schema-valid.
 *  - Releases row UPSERT semantics (no duplicate rows on re-run).
 *
 * @task T9525
 * @epic T9492
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import {
  E_CHANNEL_MISMATCH,
  E_DIRTY_TREE,
  E_EPIC_EMPTY,
  E_EPIC_NOT_FOUND,
  E_EVIDENCE_INSUFFICIENT,
  parseReleasePlan,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import * as schema from '../../store/tasks-schema.js';
import { releasePlan } from '../plan.js';

let testDir: string;

/**
 * Build a Task with sensible defaults for plan-time evidence checks. By
 * default, returns a task with a populated `verification.evidence` blob so
 * `evidenceAtoms` is non-empty.
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

/**
 * Initialize a `.git` directory inside `testDir` so `getProjectRoot()`
 * validation accepts it as a project root.
 */
async function initTestGit(): Promise<void> {
  execFileSync('git', ['init', '--quiet', testDir], { encoding: 'utf-8' });
  // Set a clean tree state — no commits / no dirty paths matter for our gate.
  execFileSync('git', ['-C', testDir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', testDir, 'config', 'user.name', 'Test']);
}

/**
 * Seed an epic + N child tasks into the accessor.
 */
async function seedEpicWithChildren(
  epicId: string,
  childCount: number,
  childOverrides: Partial<Task> = {},
): Promise<void> {
  const accessor = await createSqliteDataAccessor(testDir);
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
          ...childOverrides,
        }),
      );
    }
  } finally {
    await accessor.close();
  }
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-release-plan-'));
  await mkdir(join(testDir, '.cleo'), { recursive: true });
  // Seed config.json so DataAccessor opens cleanly.
  writeFileSync(
    join(testDir, '.cleo', 'config.json'),
    JSON.stringify({
      enforcement: { session: { requiredForMutate: false } },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    }),
  );
  // Seed project-info.json so projectHash resolves.
  writeFileSync(
    join(testDir, '.cleo', 'project-info.json'),
    JSON.stringify({
      projectHash: 'testhash00000',
      projectId: 'test-project-id',
      projectRoot: testDir,
      projectName: 'test',
    }),
  );
  await initTestGit();
  resetDbState();
});

afterEach(async () => {
  try {
    closeDb();
  } catch {
    // best-effort
  }
  await rm(testDir, { recursive: true, force: true });
});

// =============================================================================
// Happy path
// =============================================================================

describe('releasePlan — happy path', () => {
  it('writes a plan file + UPSERTs releases row + returns a LAFS-compliant envelope', async () => {
    await seedEpicWithChildren('T9999', 3);

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      createdBy: 'test',
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');

    // Envelope fields
    expect(result.data.version).toBe('v2026.6.0');
    expect(result.data.resolvedVersion).toBe('v2026.6.0');
    expect(result.data.channel).toBe('latest');
    expect(result.data.epicId).toBe('T9999');
    expect(result.data.taskCount).toBe(3);
    expect(result.data.evidenceComplete).toBe(true);
    expect(result.data.planPath).toContain('.cleo/release/v2026.6.0.plan.json');

    // Plan file on disk
    expect(existsSync(result.data.planPath)).toBe(true);
    const raw = JSON.parse(readFileSync(result.data.planPath, 'utf-8'));
    const plan = parseReleasePlan(raw);
    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks[0]?.epicAncestor).toBe('T9999');
    expect(plan.tasks[0]?.evidenceAtoms.length).toBeGreaterThan(0);
    expect(plan.status).toBe('planned');
    expect(plan.previousVersion).toBeNull();
    expect(plan.meta?.firstEverRelease).toBe(true);
    expect(plan.platformMatrix.length).toBeGreaterThan(0);
    expect(plan.gates.length).toBe(6);

    // Releases row in DB
    const db = await getDb(testDir);
    const rows = await db.select().from(schema.releases).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe('v2026.6.0');
    expect(rows[0]?.status).toBe('planned');
    expect(rows[0]?.epicId).toBe('T9999');
  });

  it('normalizes a version supplied without a leading v', async () => {
    await seedEpicWithChildren('T9999', 1);
    const result = await releasePlan({
      version: '2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.resolvedVersion).toBe('v2026.6.0');
  });
});

// =============================================================================
// Error envelopes
// =============================================================================

describe('releasePlan — error envelopes', () => {
  it('returns E_EPIC_NOT_FOUND when the epic does not exist', async () => {
    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T-DOES-NOT-EXIST',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe(E_EPIC_NOT_FOUND);
  });

  it('returns E_EPIC_EMPTY when the epic has zero children', async () => {
    const accessor = await createSqliteDataAccessor(testDir);
    try {
      await accessor.setMetaValue('schema_version', '2.10.0');
      await accessor.upsertSingleTask(makeTask({ id: 'T9999', type: 'epic', title: 'Empty Epic' }));
    } finally {
      await accessor.close();
    }
    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe(E_EPIC_EMPTY);
  });

  it('returns E_CHANNEL_MISMATCH on channel=latest + pre-release suffix in version', async () => {
    await seedEpicWithChildren('T9999', 1);
    const result = await releasePlan({
      version: 'v2026.6.0-beta.1',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe(E_CHANNEL_MISMATCH);
  });

  it('returns E_EVIDENCE_INSUFFICIENT when a child task has no evidence atoms', async () => {
    const accessor = await createSqliteDataAccessor(testDir);
    try {
      await accessor.setMetaValue('schema_version', '2.10.0');
      await accessor.upsertSingleTask(makeTask({ id: 'T9999', type: 'epic', title: 'Epic' }));
      // Child task with no verification.evidence — should trigger R-301
      await accessor.upsertSingleTask({
        id: 'T10001',
        parentId: 'T9999',
        title: 'Empty-evidence child',
        description: 'Has no evidence atoms',
        status: 'done',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        pipelineStage: 'contribution',
        verification: {
          passed: false,
          round: 1,
          gates: {},
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
        },
      } as Task);
    } finally {
      await accessor.close();
    }
    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe(E_EVIDENCE_INSUFFICIENT);
    expect(result.error.details).toBeDefined();
  });

  it('returns E_DIRTY_TREE when version files are dirty', async () => {
    await seedEpicWithChildren('T9999', 1);
    // Create + stage a package.json then dirty it.
    const pkgPath = join(testDir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ name: 'test', version: '1.0.0' }));
    execFileSync('git', ['-C', testDir, 'add', 'package.json']);
    execFileSync('git', ['-C', testDir, 'commit', '-m', 'init', '--quiet']);
    writeFileSync(pkgPath, JSON.stringify({ name: 'test', version: '1.0.1' }));

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe(E_DIRTY_TREE);
    expect(result.error.details).toMatchObject({
      dirtyPaths: expect.arrayContaining(['package.json']),
    });
  });
});

// =============================================================================
// Idempotency
// =============================================================================

describe('releasePlan — idempotency', () => {
  it('re-running with identical inputs UPSERTs (no duplicate row)', async () => {
    await seedEpicWithChildren('T9999', 2);

    const first = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(first.success).toBe(true);

    const second = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(second.success).toBe(true);

    const db = await getDb(testDir);
    const rows = await db.select().from(schema.releases).all();
    // UPSERT semantics — exactly one row regardless of re-runs.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('planned');
  });

  it('produces identical plan-task fields across re-runs (modulo createdAt)', async () => {
    await seedEpicWithChildren('T9999', 2);

    const first = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(first.success).toBe(true);
    if (!first.success) throw new Error('unreachable');
    const firstPlan = parseReleasePlan(JSON.parse(readFileSync(first.data.planPath, 'utf-8')));

    const second = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(second.success).toBe(true);
    if (!second.success) throw new Error('unreachable');
    const secondPlan = parseReleasePlan(JSON.parse(readFileSync(second.data.planPath, 'utf-8')));

    expect(secondPlan.tasks).toEqual(firstPlan.tasks);
    expect(secondPlan.epicId).toBe(firstPlan.epicId);
    expect(secondPlan.platformMatrix).toEqual(firstPlan.platformMatrix);
    // changelog buckets identical
    expect(secondPlan.changelog).toEqual(firstPlan.changelog);
  });
});

// =============================================================================
// Dry-run
// =============================================================================

describe('releasePlan — dry-run', () => {
  it('does not write the plan file or the releases row when dryRun is true', async () => {
    await seedEpicWithChildren('T9999', 1);

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      dryRun: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    // Plan file should NOT exist
    expect(existsSync(result.data.planPath)).toBe(false);
    // No releases row inserted
    const db = await getDb(testDir);
    const rows = await db.select().from(schema.releases).all();
    expect(rows).toHaveLength(0);
  });
});
