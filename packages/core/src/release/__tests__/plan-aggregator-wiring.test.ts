/**
 * Integration tests for `cleo release plan` × CLEO-native changesets aggregator (T9753).
 *
 * Covers:
 *  - plan reads `.changeset/*.md` and embeds the aggregated CHANGELOG markdown
 *    into `meta.releaseNotes` on the written plan envelope.
 *  - empty `.changeset/` directory → plan succeeds with changesetEntryCount=0.
 *  - missing `.changeset/` directory → plan succeeds (no error) with count=0.
 *  - `release_changesets` rows persist correctly with FK to releases.id and
 *    structured JSON columns for `taskIds` / `prs`.
 *  - Re-running the plan verb overwrites prior changeset rows (no accumulation).
 *
 * @task T9753
 * @epic T9752
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { parseReleasePlan } from '@cleocode/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import * as schema from '../../store/tasks-schema.js';
import { releasePlan } from '../plan.js';

let testDir: string;

/**
 * Build a Task with sensible defaults for plan-time evidence checks.
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
 * Initialize a `.git` directory so `getProjectRoot` accepts the test path.
 */
async function initTestGit(): Promise<void> {
  execFileSync('git', ['init', '--quiet', testDir], { encoding: 'utf-8' });
  execFileSync('git', ['-C', testDir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', testDir, 'config', 'user.name', 'Test']);
}

/**
 * Seed an epic + N child tasks.
 */
async function seedEpicWithChildren(epicId: string, childCount: number): Promise<void> {
  const accessor = await createSqliteDataAccessor(testDir);
  try {
    await accessor.setMetaValue('schema_version', '2.10.0');
    await accessor.upsertSingleTask(
      makeTask({ id: epicId, type: 'epic', title: 'Epic', pipelineStage: 'contribution' }),
    );
    for (let i = 1; i <= childCount; i++) {
      const id = `T${10000 + i}`;
      await accessor.upsertSingleTask(makeTask({ id, parentId: epicId, title: `Child ${i}` }));
    }
  } finally {
    await accessor.close();
  }
}

/**
 * Write a single `.changeset/<slug>.md` file with the given content.
 */
function writeChangeset(slug: string, content: string): void {
  const dir = join(testDir, '.changeset');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), content, 'utf8');
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-plan-agg-'));
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

describe('releasePlan × changesets aggregator', () => {
  it('reads in-scope .changeset/*.md and embeds aggregated CHANGELOG in plan.meta.releaseNotes', async () => {
    await seedEpicWithChildren('T9999', 1);

    writeChangeset(
      'sample-fix',
      [
        '---',
        'id: sample-fix',
        'tasks: [T10001]',
        'kind: fix',
        'summary: A sample bug fix.',
        '---',
        '',
        'Longer explanation of the fix.',
        '',
      ].join('\n'),
    );

    writeChangeset(
      'sample-feat',
      [
        '---',
        'id: sample-feat',
        'tasks: [T10001]',
        'kind: feat',
        'prs: [99]',
        'summary: A new capability.',
        '---',
        '',
      ].join('\n'),
    );

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      createdBy: 'integration-test',
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.changesetEntryCount).toBe(2);

    const plan = parseReleasePlan(JSON.parse(readFileSync(result.data.planPath, 'utf-8')));
    const meta = plan.meta as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    const releaseNotes = meta?.['releaseNotes'];
    expect(typeof releaseNotes).toBe('string');
    expect(releaseNotes).toContain('## v2026.6.0');
    expect(releaseNotes).toContain('### Added');
    expect(releaseNotes).toContain('### Fixed');
    expect(releaseNotes).toContain('- A new capability. _(provenance: [T10001](');
    expect(releaseNotes).toContain('- A sample bug fix. _(provenance: [T10001](');
    expect(meta?.['changesetEntryCount']).toBe(2);
    expect(meta?.['changesetIds']).toEqual(['sample-feat', 'sample-fix']);
  });

  it('filters stale/orphan changesets that do not reference planned tasks', async () => {
    await seedEpicWithChildren('T9999', 1);

    writeChangeset(
      'in-scope',
      [
        '---',
        'id: in-scope',
        'tasks: [T10001]',
        'kind: fix',
        'summary: Scoped fix.',
        '---',
        '',
      ].join('\n'),
    );
    writeChangeset(
      'stale-orphan',
      [
        '---',
        'id: stale-orphan',
        'tasks: [T424242]',
        'kind: feat',
        'summary: Old release entry should not leak.',
        '---',
        '',
      ].join('\n'),
    );

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      createdBy: 'integration-test',
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.changesetEntryCount).toBe(1);

    const plan = parseReleasePlan(JSON.parse(readFileSync(result.data.planPath, 'utf-8')));
    const meta = plan.meta as Record<string, unknown> | undefined;
    expect(meta?.['releaseNotes']).toContain('Scoped fix.');
    expect(meta?.['releaseNotes']).not.toContain('Old release entry should not leak.');
    expect(meta?.['changesetIds']).toEqual(['in-scope']);
  });

  it('persists release_changesets rows linked to the release with structured JSON columns', async () => {
    await seedEpicWithChildren('T9999', 1);

    writeChangeset(
      'multi-task',
      [
        '---',
        'id: multi-task',
        'tasks: [T10001]',
        'kind: refactor',
        'prs: [42, 43]',
        'summary: Split a big module.',
        '---',
        '',
        'Body paragraph.',
        '',
      ].join('\n'),
    );

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');

    const db = await getDb(testDir);
    const releases = await db.select().from(schema.releases).all();
    expect(releases).toHaveLength(1);
    const releaseId = releases[0]!.id;

    const changesetRows = await db
      .select()
      .from(schema.releaseChangesets)
      .where(eq(schema.releaseChangesets.releaseId, releaseId))
      .all();

    expect(changesetRows).toHaveLength(1);
    const row = changesetRows[0]!;
    expect(row.changesetId).toBe('multi-task');
    expect(row.kind).toBe('refactor');
    expect(row.summary).toBe('Split a big module.');
    expect(JSON.parse(row.taskIds)).toEqual(['T10001']);
    expect(row.prs).not.toBeNull();
    expect(JSON.parse(row.prs!)).toEqual([42, 43]);
    expect(row.notes).toBe('Body paragraph.');
    expect(row.breaking).toBeNull();
  });

  it('succeeds with entryCount=0 when .changeset/ directory is missing entirely', async () => {
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
    expect(result.data.changesetEntryCount).toBe(0);

    const plan = parseReleasePlan(JSON.parse(readFileSync(result.data.planPath, 'utf-8')));
    const meta = plan.meta as Record<string, unknown> | undefined;
    expect(meta?.['releaseNotes']).toBe('');
    expect(meta?.['changesetEntryCount']).toBe(0);
  });

  it('succeeds with entryCount=0 when .changeset/ exists but only contains README.md', async () => {
    await seedEpicWithChildren('T9999', 1);
    mkdirSync(join(testDir, '.changeset'), { recursive: true });
    writeFileSync(
      join(testDir, '.changeset', 'README.md'),
      '# Changesets directory\n\nDocs only.\n',
    );

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.changesetEntryCount).toBe(0);
  });

  it('skips out-of-scope stale changesets and warns instead of re-consuming them', async () => {
    await seedEpicWithChildren('T9999', 1);

    writeChangeset(
      'in-scope',
      [
        '---',
        'id: in-scope',
        'tasks: [T10001]',
        'kind: fix',
        'summary: Current fix.',
        '---',
        '',
      ].join('\n'),
    );
    writeChangeset(
      'stale-prior-release',
      [
        '---',
        'id: stale-prior-release',
        'tasks: [T4242]',
        'kind: feat',
        'summary: Old feature.',
        '---',
        '',
      ].join('\n'),
    );

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.changesetEntryCount).toBe(1);

    const plan = parseReleasePlan(JSON.parse(readFileSync(result.data.planPath, 'utf-8')));
    expect((plan.meta as Record<string, unknown>).releaseNotes).toContain('Current fix.');
    expect((plan.meta as Record<string, unknown>).releaseNotes).not.toContain('Old feature.');
    expect(plan.preflightSummary.preflightWarnings).toContain(
      'Skipped 1 out-of-scope changeset entry whose task anchors are not part of this release plan',
    );

    const db = await getDb(testDir);
    const releases = await db.select().from(schema.releases).all();
    const releaseId = releases[0]!.id;
    const rows = await db
      .select()
      .from(schema.releaseChangesets)
      .where(eq(schema.releaseChangesets.releaseId, releaseId))
      .all();
    expect(rows.map((row) => row.changesetId)).toEqual(['in-scope']);
  });

  it('re-running the plan overwrites prior release_changesets rows (no accumulation)', async () => {
    await seedEpicWithChildren('T9999', 1);

    writeChangeset(
      'first',
      [
        '---',
        'id: first',
        'tasks: [T10001]',
        'kind: feat',
        'summary: First entry.',
        '---',
        '',
      ].join('\n'),
    );

    const first = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(first.success).toBe(true);

    // Add a second entry and re-run.
    writeChangeset(
      'second',
      [
        '---',
        'id: second',
        'tasks: [T10001]',
        'kind: fix',
        'summary: Second entry.',
        '---',
        '',
      ].join('\n'),
    );

    const second = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(second.success).toBe(true);
    if (!second.success) throw new Error('unreachable');
    expect(second.data.changesetEntryCount).toBe(2);

    const db = await getDb(testDir);
    const releases = await db.select().from(schema.releases).all();
    const releaseId = releases[0]!.id;
    const rows = await db
      .select()
      .from(schema.releaseChangesets)
      .where(eq(schema.releaseChangesets.releaseId, releaseId))
      .all();
    // Exactly 2 — the prior row was wiped before re-insert.
    expect(rows).toHaveLength(2);
    const slugs = rows.map((r) => r.changesetId).sort();
    expect(slugs).toEqual(['first', 'second']);
  });
});
