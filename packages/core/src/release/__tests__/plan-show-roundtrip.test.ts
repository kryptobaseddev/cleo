/**
 * Round-trip regression test for T9686: `cleo release plan v<X>` must make
 * `cleo release show v<X>` succeed.
 *
 * Prior to T9686, `releaseShow` / `releaseList` read from the legacy
 * `release_manifests` table while `releasePlan` wrote to the new `releases`
 * table. The dual-source-of-truth caused `show` to return E_NOT_FOUND for
 * any release that had gone through the new pipeline but never through the
 * legacy one. This test locks the fix in place: read + write now share
 * `releases_view` as the single SSoT.
 *
 * @task T9686
 * @epic T9499
 * @see SPEC-T9345 §3.12
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { releasePlan } from '../plan.js';
import { listReleases, showRelease } from '../release-manifest.js';

let testDir: string;

/** Build a Task with sensible defaults for plan-time evidence checks. */
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

async function initTestGit(): Promise<void> {
  execFileSync('git', ['init', '--quiet', testDir], { encoding: 'utf-8' });
  execFileSync('git', ['-C', testDir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', testDir, 'config', 'user.name', 'Test']);
}

async function seedEpicWithChildren(epicId: string, childCount: number): Promise<void> {
  const accessor = await createSqliteDataAccessor(testDir);
  try {
    await accessor.setMetaValue('schema_version', '2.10.0');
    await accessor.upsertSingleTask(
      makeTask({ id: epicId, type: 'epic', title: 'Epic', pipelineStage: 'contribution' }),
    );
    for (let i = 1; i <= childCount; i++) {
      const id = `T${20000 + i}`;
      await accessor.upsertSingleTask(makeTask({ id, parentId: epicId, title: `Child ${i}` }));
    }
  } finally {
    await accessor.close();
  }
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-release-roundtrip-'));
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

// ─────────────────────────────────────────────────────────────────────────────
// T9686 regression lock — plan → show round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('T9686 — release plan → show round-trip (SSoT regression lock)', () => {
  it('`cleo release plan v<X>` then `cleo release show v<X>` succeeds without E_NOT_FOUND', async () => {
    await seedEpicWithChildren('T20000', 2);

    const planResult = await releasePlan({
      version: 'v2026.7.0',
      epicId: 'T20000',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      createdBy: 'roundtrip-test',
    });

    expect(planResult.success).toBe(true);
    if (!planResult.success) throw new Error('plan failed');
    expect(planResult.data.resolvedVersion).toBe('v2026.7.0');

    // show MUST find the release the plan just wrote. Pre-T9686 this threw
    // 'Release v2026.7.0 not found' because show read the legacy table.
    const manifest = await showRelease('v2026.7.0', testDir);
    expect(manifest.version).toBe('v2026.7.0');
    expect(manifest.status).toBe('planned');
    expect(manifest.source).toBe('new');
    // Task list is projected from `release_changes.task_id` for new-pipeline
    // rows. Plan does not populate release_changes yet (that's reconcile's
    // job), so for a freshly-planned release the tasks array MAY be empty.
    // Just assert it is well-formed.
    expect(Array.isArray(manifest.tasks)).toBe(true);
  });

  it('`cleo release list` shows new-pipeline rows alongside any legacy rows', async () => {
    await seedEpicWithChildren('T20000', 1);

    await releasePlan({
      version: 'v2026.7.1',
      epicId: 'T20000',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      createdBy: 'roundtrip-test',
    });

    const list = await listReleases(undefined, testDir);
    expect(list.total).toBe(1);
    expect(list.filtered).toBe(1);
    const found = list.releases.find((r) => r.version === 'v2026.7.1');
    expect(found).toBeDefined();
    expect(found?.status).toBe('planned');
    expect(found?.source).toBe('new');
  });

  it('idempotent plan re-run does not duplicate the row in the SSoT view', async () => {
    await seedEpicWithChildren('T20000', 1);

    // First plan
    const first = await releasePlan({
      version: 'v2026.7.2',
      epicId: 'T20000',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      createdBy: 'roundtrip-test',
    });
    expect(first.success).toBe(true);

    // Second plan with the same args — UPSERT no-op modulo timestamps.
    const second = await releasePlan({
      version: 'v2026.7.2',
      epicId: 'T20000',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      createdBy: 'roundtrip-test',
    });
    expect(second.success).toBe(true);

    const list = await listReleases(undefined, testDir);
    const matches = list.releases.filter((r) => r.version === 'v2026.7.2');
    expect(matches).toHaveLength(1);
  });

  it('show throws when the version is absent from BOTH the new and legacy tables', async () => {
    await expect(showRelease('v9999.999.999', testDir)).rejects.toThrow(
      /v9999\.999\.999 not found/,
    );
  });
});
