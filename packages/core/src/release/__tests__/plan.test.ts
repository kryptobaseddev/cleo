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
import { fileURLToPath } from 'node:url';
import type { Task } from '@cleocode/contracts';
import {
  E_CHANNEL_MISMATCH,
  E_DIRTY_TREE,
  E_EPIC_NOT_FOUND,
  E_EVIDENCE_INSUFFICIENT,
  parseReleasePlan,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import * as schema from '../../store/tasks-schema.js';
import { parseHooksV1Gate } from '../hooks-v1-promotion.js';
import { __test__ as planInternals, releasePlan } from '../plan.js';

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

// Explicit release fixtures own their configuration, provenance store and documents.
beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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
  it('retains an explicit hooks promotion flag in the committed plan', async () => {
    await seedEpicWithChildren('T9999', 1);
    const result = await releasePlan({
      version: 'v2026.10.6',
      epicId: 'T9999',
      projectRoot: testDir,
      hooksV1Promotion: true,
      scheme: 'calver',
    });
    expect(result.success).toBe(true);
    const plan = parseReleasePlan(
      JSON.parse(readFileSync(join(testDir, '.cleo/release/v2026.10.6.plan.json'), 'utf8')),
    );
    expect(plan.hooksV1Promotion).toBe(true);
  });

  it('preserves the canary channel in its plan while using the compatible persisted enum', async () => {
    await seedEpicWithChildren('T9999', 1);
    const result = await releasePlan({
      version: 'v2026.10.6-canary.1',
      epicId: 'T9999',
      channel: 'canary',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Canary planning failed');
    expect(result.data.channel).toBe('canary');
    const plan = parseReleasePlan(JSON.parse(readFileSync(result.data.planPath, 'utf8')));
    expect(plan.channel).toBe('canary');
    const rows = await (await getDb(testDir)).select().from(schema.releases).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel).toBe('beta');
  });

  it.each([
    { version: 'v2026.10.6', channel: 'canary' },
    { version: 'v2026.10.6-canary.1', channel: 'beta' },
  ] as const)('rejects incompatible canary planning inputs: $version/$channel', async (input) => {
    await seedEpicWithChildren('T9999', 1);
    const result = await releasePlan({ ...input, epicId: 'T9999', projectRoot: testDir });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Incompatible canary accepted');
    expect(result.error.code).toBe(E_CHANNEL_MISMATCH);
  });

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

  it('uses the most recent tagged shipped release as previousVersion (T10082)', async () => {
    await seedEpicWithChildren('T9999', 1);
    execFileSync('git', [
      '-C',
      testDir,
      'commit',
      '--allow-empty',
      '-m',
      'release history',
      '--quiet',
    ]);
    execFileSync('git', ['-C', testDir, 'tag', 'v2026.5.95']);
    execFileSync('git', ['-C', testDir, 'tag', 'v2026.5.97']);
    const db = await getDb(testDir);
    await db.insert(schema.releases).values([
      {
        id: 'testhash00000:v2026.5.95',
        version: 'v2026.5.95',
        channel: 'latest',
        status: 'reconciled',
        publishedAt: '2026-05-20T00:00:00.000Z',
      },
      {
        id: 'testhash00000:v2026.5.97',
        version: 'v2026.5.97',
        channel: 'latest',
        status: 'published',
        publishedAt: '2026-05-21T00:00:00.000Z',
      },
      {
        id: 'testhash00000:v2026.5.98',
        version: 'v2026.5.98',
        channel: 'latest',
        status: 'planned',
        plannedAt: '2026-05-22T00:00:00.000Z',
      },
    ]);

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    const plan = parseReleasePlan(JSON.parse(readFileSync(result.data.planPath, 'utf-8')));
    expect(plan.previousVersion).toBe('v2026.5.97');
    expect(plan.previousTag).toBe('v2026.5.97');
  });

  it('derives previousTag from the newest reachable v* tag, even with no releases row (T13536)', async () => {
    await seedEpicWithChildren('T9999', 1);
    const git = (...args: string[]) => execFileSync('git', ['-C', testDir, ...args]);
    const commit = (m: string) => git('commit', '--allow-empty', '-m', m, '--quiet');
    commit('one');
    git('tag', 'v2026.5.1');
    commit('two');
    git('tag', 'v2026.5.2');
    // A newer tag on a side branch is not reachable from HEAD.
    git('checkout', '-q', '-b', 'side');
    commit('side');
    git('tag', 'v2026.5.9');
    git('checkout', '-q', '-');
    commit('three');

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    const plan = parseReleasePlan(JSON.parse(readFileSync(result.data.planPath, 'utf-8')));
    expect(plan.previousTag).toBe('v2026.5.2');
    expect(plan.previousVersion).toBe('v2026.5.2');
    expect(plan.meta?.firstEverRelease).toBe(false);
  });

  it('previousTag skips tags that are not version-shaped or not below the planned version (T13543)', async () => {
    await seedEpicWithChildren('T9999', 1);
    const git = (...args: string[]) => execFileSync('git', ['-C', testDir, ...args]);
    const commit = (m: string) => git('commit', '--allow-empty', '-m', m, '--quiet');
    commit('one');
    git('tag', 'v2026.5.2');
    commit('two');
    // Stray tags that parse as higher versions, all reachable from HEAD.
    git('tag', 'vv2026.5.106');
    git('tag', 'vendor-2026.5.50');
    git('tag', 'v9.0-test');
    // A reachable tag newer than the planned version (a back-dated plan).
    git('tag', 'v2026.7.0');

    for (const channel of ['latest', 'beta'] as const) {
      const result = await releasePlan({
        version: 'v2026.6.0',
        epicId: 'T9999',
        channel,
        scheme: 'calver',
        projectRoot: testDir,
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('unreachable');
      const plan = parseReleasePlan(JSON.parse(readFileSync(result.data.planPath, 'utf-8')));
      expect(plan.previousTag, channel).toBe('v2026.5.2');
    }
  });

  it('previousTag orders prerelease numbers numerically: beta.9 precedes beta.10 (T13543)', async () => {
    await seedEpicWithChildren('T9999', 1);
    const git = (...args: string[]) => execFileSync('git', ['-C', testDir, ...args]);
    git('commit', '--allow-empty', '-m', 'one', '--quiet');
    for (const n of [1, 2, 9]) git('tag', `v2026.6.0-beta.${n}`);

    const result = await releasePlan({
      version: 'v2026.6.0-beta.10',
      epicId: 'T9999',
      channel: 'beta',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    const plan = parseReleasePlan(JSON.parse(readFileSync(result.data.planPath, 'utf-8')));
    expect(plan.previousTag).toBe('v2026.6.0-beta.9');
  });

  it('accepts explicit task-list release scope via taskIds (T10088)', async () => {
    const accessor = await createSqliteDataAccessor(testDir);
    try {
      await accessor.setMetaValue('schema_version', '2.10.0');
      await accessor.upsertSingleTask(makeTask({ id: 'T10001', title: 'Explicit one' }));
      await accessor.upsertSingleTask(makeTask({ id: 'T10002', title: 'Explicit two' }));
    } finally {
      await accessor.close();
    }

    const result = await releasePlan({
      version: 'v2026.6.0',
      taskIds: ['T10002', 'T10001'],
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.taskCount).toBe(2);
    const plan = parseReleasePlan(JSON.parse(readFileSync(result.data.planPath, 'utf-8')));
    expect(plan.tasks.map((t) => t.id)).toEqual(['T10002', 'T10001']);
    expect(plan.meta?.taskIds).toEqual(['T10002', 'T10001']);
  });

  it('a --tasks plan spanning several epics records no epic; each task keeps its own (T13323)', async () => {
    const accessor = await createSqliteDataAccessor(testDir);
    try {
      await accessor.setMetaValue('schema_version', '2.10.0');
      await accessor.upsertSingleTask(makeTask({ id: 'T20001', title: 'Epic A', type: 'epic' }));
      await accessor.upsertSingleTask(makeTask({ id: 'T20002', title: 'Epic B', type: 'epic' }));
      await accessor.upsertSingleTask(
        makeTask({ id: 'T20011', title: 'Under A', parentId: 'T20001' }),
      );
      await accessor.upsertSingleTask(
        makeTask({ id: 'T20012', title: 'Under B', parentId: 'T20002' }),
      );
    } finally {
      await accessor.close();
    }

    const result = await releasePlan({
      version: 'v2026.6.0',
      taskIds: ['T20012', 'T20011'],
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    // The first task's parent (T20002) used to become the release's epic.
    expect(result.data.epicId).toBeNull();
    const plan = parseReleasePlan(JSON.parse(readFileSync(result.data.planPath, 'utf-8')));
    expect(plan.epicId).toBeNull();
    expect(plan.tasks.map((t) => [t.id, t.epicAncestor])).toEqual([
      ['T20012', 'T20002'],
      ['T20011', 'T20001'],
    ]);
  });
});

// =============================================================================
// Error envelopes
// =============================================================================

describe('releasePlan — hooks-v1 gate opened by source (T13555)', () => {
  const gate = (set: string, released = 'return false;') =>
    `export const UNRELEASED_HOOK_FEATURES: ReadonlySet<HookFeature> = new Set([${set}]);\n` +
    `export function hooksV1Released(opts: HooksV1ReleaseOptions = {}): boolean {\n  ${released}\n}\n`;
  const git = (...args: string[]) => execFileSync('git', ['-C', testDir, ...args]);
  /** Tag a release with the gate closed, then commit `next` as the gate source. */
  const releaseThen = (next: string | null) => {
    const file = join(testDir, 'packages/core/src/hooks/release-gate.ts');
    execFileSync('mkdir', ['-p', join(testDir, 'packages/core/src/hooks')]);
    writeFileSync(file, gate("'hooks-v1'"));
    git('add', '-A', 'packages');
    git('commit', '-q', '-m', 'gate');
    git('tag', 'v2026.5.1');
    if (next === null) git('rm', '-q', file);
    else {
      writeFileSync(file, next);
      git('add', '-A', 'packages');
    }
    git('commit', '-q', '--allow-empty', '-m', 'next');
  };
  const plan = (extra: { hooksV1Promotion?: boolean; hooksV1Waiver?: string } = {}) =>
    releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      ...extra,
    });

  it('refuses a stable plan that drops hooks-v1 from the unreleased set without the flag', async () => {
    await seedEpicWithChildren('T9999', 1);
    releaseThen(gate(''));
    const result = await plan();
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('E_HOOKS_V1_PROMOTION_REQUIRED');
    expect(result.error.details).toMatchObject({
      previousTag: 'v2026.5.1',
      changes: ["'hooks-v1' left UNRELEASED_HOOK_FEATURES"],
    });
  });

  it('refuses a changed hooksV1Released and a deleted gate', async () => {
    await seedEpicWithChildren('T9999', 1);
    releaseThen(gate("'hooks-v1'", 'return true;'));
    const changed = await plan();
    expect(changed.success).toBe(false);
    if (changed.success) throw new Error('unreachable');
    expect(changed.error.details).toMatchObject({ changes: ['hooksV1Released changed'] });
    git('rm', '-q', 'packages/core/src/hooks/release-gate.ts');
    git('commit', '-q', '-m', 'delete');
    const deleted = await plan();
    expect(deleted.success).toBe(false);
  });

  it('accepts the promotion, an untouched gate, and an audited waiver', async () => {
    await seedEpicWithChildren('T9999', 1);
    releaseThen(gate(''));
    expect((await plan({ hooksV1Promotion: true })).success).toBe(true);
    const waived = await plan({ hooksV1Waiver: 'owner approved without the pilot' });
    expect(waived.success).toBe(true);
    if (!waived.success) throw new Error('unreachable');
    const written = parseReleasePlan(JSON.parse(readFileSync(waived.data.planPath, 'utf-8')));
    expect(written.hooksV1Waiver).toBe('owner approved without the pilot');
    const audit = readFileSync(join(testDir, '.cleo/audit/hooks-v1-waiver.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      version: 'v2026.6.0',
      previousTag: 'v2026.5.1',
      reason: 'owner approved without the pilot',
      changes: ["'hooks-v1' left UNRELEASED_HOOK_FEATURES"],
    });
  });

  it('exempts the release after the promotion: removing hooks-v1 is the cleanup', async () => {
    await seedEpicWithChildren('T9999', 1);
    execFileSync('mkdir', ['-p', join(testDir, '.cleo/release')]);
    writeFileSync(
      join(testDir, '.cleo/release/v2026.5.1.plan.json'),
      JSON.stringify({ hooksV1Promotion: true }),
    );
    git('add', '-f', '.cleo/release/v2026.5.1.plan.json');
    releaseThen(gate(''));
    expect((await plan()).success).toBe(true);
  });

  it('fails closed on a gate shape it cannot read', async () => {
    await seedEpicWithChildren('T9999', 1);
    releaseThen(
      'export const UNRELEASED_HOOK_FEATURES = loadFeatures();\n' +
        'export function hooksV1Released(opts: HooksV1ReleaseOptions = {}): boolean {\n  return false;\n}\n',
    );
    const result = await plan();
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.details).toMatchObject({
      changes: [
        'packages/core/src/hooks/release-gate.ts has a gate shape the release guard cannot read',
      ],
    });
  });

  it('parses the real release-gate.ts: hooks-v1 unreleased and hooksV1Released found', () => {
    const real = readFileSync(
      fileURLToPath(new URL('../../hooks/release-gate.ts', import.meta.url)),
      'utf-8',
    );
    const shape = parseHooksV1Gate(real);
    expect(shape.unreleased).toBe(true);
    expect(shape.released).toMatch(/^export function hooksV1Released\(/);
  });

  it('a later cleanup after the gate shipped open needs no waiver, whatever its shape', async () => {
    await seedEpicWithChildren('T9999', 1);
    releaseThen(gate(''));
    expect((await plan({ hooksV1Promotion: true })).success).toBe(true);
    git('tag', 'v2026.5.2');
    writeFileSync(
      join(testDir, 'packages/core/src/hooks/release-gate.ts'),
      'export const UNRELEASED_HOOK_FEATURES = new Set<HookFeature>();\n',
    );
    git('add', '-A', 'packages');
    git('commit', '-q', '-m', 'cleanup');
    expect((await plan()).success).toBe(true);
  });

  it('reads `new Set()` with no array literal as hooks-v1 released', () => {
    expect(
      parseHooksV1Gate('export const UNRELEASED_HOOK_FEATURES = new Set<HookFeature>();\n')
        .unreleased,
    ).toBe(false);
  });

  it('leaves an untouched gate alone', async () => {
    await seedEpicWithChildren('T9999', 1);
    releaseThen(gate("'hooks-v1'"));
    const result = await plan();
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(
      parseReleasePlan(JSON.parse(readFileSync(result.data.planPath, 'utf-8'))).hooksV1Waiver,
    ).toBeUndefined();
  });
});

describe('releasePlan — a shipped version is immutable (T13619)', () => {
  it.each([
    'committed',
    'tagged',
    'pushed',
    'published',
    'reconciled',
    'rolled_back',
  ] as const)('refuses to re-plan a version whose row is %s, writing nothing', async (status) => {
    await seedEpicWithChildren('T9999', 1);
    const db = await getDb(testDir);
    await db.insert(schema.releases).values({
      id: 'testhash00000:v2026.6.0',
      version: 'v2026.6.0',
      channel: 'latest',
      status,
    });
    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('E_INVALID_STATE');
    expect(result.error.message).toContain('v2026.6.0');
    // The origin keeps the shipped status, exactly as every synced peer does.
    const rows = await db.select().from(schema.releases).all();
    expect(rows.map((r) => [r.version, r.status])).toEqual([['v2026.6.0', status]]);
    expect(existsSync(join(testDir, '.cleo/release/v2026.6.0.plan.json'))).toBe(false);
  });

  it('the plan upsert never moves a row that shipped after the check back to planned', async () => {
    await seedEpicWithChildren('T9999', 1);
    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    const plan = parseReleasePlan(JSON.parse(readFileSync(result.data.planPath, 'utf-8')));
    // A peer's shipped status lands between the shipped check and the upsert.
    const db = await getDb(testDir);
    await db.update(schema.releases).set({ status: 'tagged' }).run();
    await planInternals.upsertReleasesRow(plan, 'latest', testDir);
    const rows = await db.select().from(schema.releases).all();
    expect(rows.map((r) => [r.version, r.status])).toEqual([['v2026.6.0', 'tagged']]);
  });

  it('still re-plans a version that has not shipped', async () => {
    await seedEpicWithChildren('T9999', 1);
    const db = await getDb(testDir);
    await db.insert(schema.releases).values({
      id: 'testhash00000:v2026.6.0',
      version: 'v2026.6.0',
      channel: 'latest',
      status: 'pr-opened',
    });
    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(true);
  });
});

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

  it('--tasks on a store holding none of the ids names the plan-blob path (T13479, #1475)', async () => {
    const result = await releasePlan({
      version: 'v2026.6.0',
      taskIds: ['T10001', 'T10002'],
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('E_NOT_FOUND');
    expect(result.error.message).toContain('local-only');
    expect(result.error.fix).toContain('plan-blob-sha256');
    expect(result.error.details).toMatchObject({ missing: ['T10001', 'T10002'] });
  });

  it('--tasks with only some ids missing keeps the cleo exists remedy (T13479)', async () => {
    const accessor = await createSqliteDataAccessor(testDir);
    try {
      await accessor.setMetaValue('schema_version', '2.10.0');
      await accessor.upsertSingleTask(makeTask({ id: 'T10001' }));
    } finally {
      await accessor.close();
    }
    const result = await releasePlan({
      version: 'v2026.6.0',
      taskIds: ['T10001', 'T10002'],
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('E_NOT_FOUND');
    expect(result.error.fix).toBe('cleo exists T10002');
  });

  it('returns E_EPIC_EMPTY_LEAF_NO_EVIDENCE when the epic has zero children + no evidence (T9838)', async () => {
    // T9838 Fix 2: leaf-Epic-as-Task (ADR-073) is now a valid input shape.
    // The plan verb falls back to the Epic's own evidence atoms when the
    // Epic has no children. When the Epic ALSO has no evidence atoms, the
    // verb surfaces a dedicated error code so the operator is routed to
    // `cleo verify` (NOT the legacy "add a child task" advice).
    const accessor = await createSqliteDataAccessor(testDir);
    try {
      await accessor.setMetaValue('schema_version', '2.10.0');
      await accessor.upsertSingleTask({
        ...makeTask({ id: 'T9999', type: 'epic', title: 'Empty Epic' }),
        // Override default evidence with zero atoms.
        verification: {
          passed: false,
          round: 1,
          gates: {},
          evidence: {},
          lastAgent: null,
          lastUpdated: new Date().toISOString(),
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
    expect(result.error.code).toBe('E_EPIC_EMPTY_LEAF_NO_EVIDENCE');
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
      // Child task with no verification.evidence — should trigger R-301.
      // Status MUST be non-'done': T9758 (5d60cbc4a) grandfathers already-done
      // tasks past the evidence gate (ADR-051 §11.1 forbids adding evidence to
      // completed tasks), so an 'active' child is the genuine missing-evidence case.
      await accessor.upsertSingleTask({
        id: 'T10001',
        parentId: 'T9999',
        title: 'Empty-evidence child',
        description: 'Has no evidence atoms',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
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

  it('refuses when a task carries atoms but its implemented gate is false (T12359)', async () => {
    // Enforce verification the way a real project does (the default outside
    // VITEST): the plan must judge gate OUTCOMES with the policy
    // `cleo complete` applies, not the mere presence of evidence atoms.
    writeFileSync(
      join(testDir, '.cleo', 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false } },
        lifecycle: { mode: 'off' },
        verification: { enabled: true, requiredGates: ['implemented', 'testsPassed'] },
      }),
    );
    const accessor = await createSqliteDataAccessor(testDir);
    try {
      await accessor.setMetaValue('schema_version', '2.10.0');
      await accessor.upsertSingleTask(makeTask({ id: 'T9999', type: 'epic', title: 'Epic' }));
      // Fully verified sibling — must be reported as verified, not blocking.
      await accessor.upsertSingleTask(
        makeTask({
          id: 'T10001',
          parentId: 'T9999',
          status: 'active',
          verification: {
            passed: true,
            round: 1,
            gates: { implemented: true, testsPassed: true },
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
        }),
      );
      // The v2026.9.17 shape: a tool atom is present, implemented is false.
      await accessor.upsertSingleTask(
        makeTask({
          id: 'T10002',
          parentId: 'T9999',
          status: 'active',
          verification: {
            passed: false,
            round: 1,
            gates: { implemented: false, testsPassed: true },
            evidence: {
              testsPassed: {
                atoms: [{ kind: 'tool', tool: 'test', exitCode: 0 }],
                capturedAt: new Date().toISOString(),
                capturedBy: 'test-agent',
              },
            },
            lastAgent: null,
            lastUpdated: new Date().toISOString(),
            failureLog: [],
          },
        }),
      );
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
    expect(result.error.message).toContain('T10002');
    expect(result.error.message).toContain('implemented=false');
    const details = result.error.details as {
      requiredGates: string[];
      verificationEnforced: boolean;
      tasks: Array<{
        id: string;
        verdict: string;
        missingGates: string[];
        evidenceAtoms: string[];
      }>;
      taskGates: Array<{ id: string; verdict: string; gates: Record<string, boolean | null> }>;
    };
    expect(details.verificationEnforced).toBe(true);
    expect(details.requiredGates).toEqual(['implemented', 'testsPassed']);
    // Only the unverified task blocks, and it names the gate — not just atoms.
    expect(details.tasks.map((t) => t.id)).toEqual(['T10002']);
    expect(details.tasks[0]?.verdict).toBe('unverified');
    expect(details.tasks[0]?.missingGates).toEqual(['implemented']);
    expect(details.tasks[0]?.evidenceAtoms).toEqual(['tool:test']);
    // Every task's gate state is reported.
    expect(details.taskGates.map((g) => [g.id, g.verdict])).toEqual([
      ['T10001', 'verified'],
      ['T10002', 'unverified'],
    ]);
    expect(details.taskGates[1]?.gates.implemented).toBe(false);
  });

  it('reports per-task gate states in the success envelope (T12359)', async () => {
    await seedEpicWithChildren('T9999', 2);

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    // This suite disables verification; seeded children are `done`.
    expect(result.data.verificationEnforced).toBe(false);
    expect(result.data.taskGates).toHaveLength(2);
    for (const g of result.data.taskGates) {
      expect(g.verdict).toBe('grandfathered');
      expect(g.gates).toEqual({ implemented: true });
      expect(g.evidenceAtoms.length).toBeGreaterThan(0);
    }
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
