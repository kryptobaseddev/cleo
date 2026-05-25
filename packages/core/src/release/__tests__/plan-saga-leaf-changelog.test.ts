/**
 * Integration tests for `cleo release plan` × T9838 (3 release-flow gaps).
 *
 * Covers:
 *  - `--saga T####` walks `task_relations.relation_type='groups'` and
 *    aggregates member Epics into the release plan (ADR-073 I3).
 *  - `--saga` failure modes: not-found, not-a-saga, zero members.
 *  - `--epic <leaf>` with zero children + evidence on the Epic itself →
 *    success (singleton task list; ADR-073 leaf-Epic-as-PR pattern).
 *  - `--epic <leaf>` with zero children AND zero evidence atoms →
 *    `E_EPIC_EMPTY_LEAF_NO_EVIDENCE`.
 *  - `--epic <leaf>` evidence-complete vs the original E_EPIC_EMPTY (still
 *    triggered for the Saga form, NOT for the leaf-Epic form).
 *  - CHANGELOG.md auto-write: fresh-file insert, existing-section replace
 *    idempotently, `--no-changelog` (writeChangelog=false) opt-out.
 *  - Pure helpers (replaceOrInsertChangelogSection) — string-level coverage.
 *
 * @task T9838
 * @epic T9782
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { __test__, releasePlan } from '../plan.js';

const { replaceOrInsertChangelogSection } = __test__;

let testDir: string;

/**
 * Build a Task with sensible defaults for plan-time evidence checks.
 *
 * Evidence atoms default to a single `commit:` atom on the `implemented`
 * gate so the task passes the R-301 evidence-completeness check.
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
 * Build a Task explicitly carrying zero evidence atoms.
 */
function makeTaskNoEvidence(overrides: Partial<Task> & { id: string }): Task {
  return makeTask({
    ...overrides,
    verification: {
      passed: false,
      round: 1,
      gates: {},
      evidence: {},
      lastAgent: null,
      lastUpdated: new Date().toISOString(),
      failureLog: [],
    },
  });
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
 * Seed an Epic with N evidenced child tasks.
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
 * Seed a Saga (label='saga') with N member Epics linked via type='groups'.
 * Each member Epic gets `childCount` children. Returns the member Epic IDs
 * for downstream assertions.
 */
async function seedSagaWithMembers(
  sagaId: string,
  memberCount: number,
  childCountPerMember: number,
): Promise<string[]> {
  const accessor = await createSqliteDataAccessor(testDir);
  const memberEpicIds: string[] = [];
  try {
    await accessor.setMetaValue('schema_version', '2.10.0');
    // Build the Saga first (Epic with label='saga').
    await accessor.upsertSingleTask(
      makeTask({
        id: sagaId,
        type: 'epic',
        title: 'Saga',
        labels: ['saga'],
        pipelineStage: 'contribution',
      }),
    );
    for (let m = 1; m <= memberCount; m++) {
      const memberId = `T${20000 + m}`;
      memberEpicIds.push(memberId);
      await accessor.upsertSingleTask(
        makeTask({
          id: memberId,
          type: 'epic',
          title: `Member Epic ${m}`,
          pipelineStage: 'contribution',
        }),
      );
      for (let c = 1; c <= childCountPerMember; c++) {
        const childId = `T${30000 + m * 100 + c}`;
        await accessor.upsertSingleTask(
          makeTask({ id: childId, parentId: memberId, title: `M${m}-Child${c}` }),
        );
      }
      // Link saga → member via type='groups' (ADR-073 I3).
      await accessor.addRelation(sagaId, memberId, 'groups');
    }
  } finally {
    await accessor.close();
  }
  return memberEpicIds;
}

/**
 * Write a single `.changeset/<slug>.md` file with the given content.
 */
function writeChangeset(slug: string, content: string): void {
  const dir = join(testDir, '.changeset');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), content, 'utf8');
}

/**
 * Seed a feature-style changeset entry so the aggregator emits non-empty
 * release notes — required to exercise the CHANGELOG.md write path.
 */
function seedFeatChangeset(): void {
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
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-plan-saga-'));
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

// ---------------------------------------------------------------------------
// Fix 1: Saga walking via task_relations.relation_type='groups'
// ---------------------------------------------------------------------------

describe('releasePlan --saga (T9838 Fix 1)', () => {
  it('walks groups relation and aggregates member-epic children into the plan', async () => {
    // 2 member Epics × 2 children each + 1 saga = 5 tasks. Aggregated tasks
    // are the 4 children (Saga + member Epics are excluded by the subtree
    // filter that drops the Epic root id).
    const memberIds = await seedSagaWithMembers('T9999', 2, 2);
    expect(memberIds).toHaveLength(2);

    const result = await releasePlan({
      version: 'v2026.6.0',
      sagaId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      writeChangelog: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    // 2 members × 2 children = 4 task entries in the plan.
    expect(result.data.taskCount).toBe(4);
    // The plan's epicId is the Saga ID for traceability.
    expect(result.data.epicId).toBe('T9999');
    expect(result.data.evidenceComplete).toBe(true);
  });

  it('returns E_NOT_FOUND when the saga ID does not exist', async () => {
    const result = await releasePlan({
      version: 'v2026.6.0',
      sagaId: 'T-NOSUCH',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      writeChangelog: false,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('E_NOT_FOUND');
  });

  it('returns E_INVALID_INPUT when the task exists but lacks label=saga', async () => {
    // Seed an Epic WITHOUT the saga label, then try --saga.
    const accessor = await createSqliteDataAccessor(testDir);
    try {
      await accessor.setMetaValue('schema_version', '2.10.0');
      await accessor.upsertSingleTask(
        makeTask({ id: 'T9998', type: 'epic', title: 'Plain Epic, not a Saga' }),
      );
    } finally {
      await accessor.close();
    }

    const result = await releasePlan({
      version: 'v2026.6.0',
      sagaId: 'T9998',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      writeChangelog: false,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('E_INVALID_INPUT');
    expect(result.error.message).toContain("missing label='saga'");
  });

  it('returns E_EPIC_EMPTY when a saga has zero member epics', async () => {
    // Saga exists, labels=['saga'], but no `relates` of type='groups'.
    const accessor = await createSqliteDataAccessor(testDir);
    try {
      await accessor.setMetaValue('schema_version', '2.10.0');
      await accessor.upsertSingleTask(
        makeTask({
          id: 'T9997',
          type: 'epic',
          title: 'Lonely Saga',
          labels: ['saga'],
        }),
      );
    } finally {
      await accessor.close();
    }

    const result = await releasePlan({
      version: 'v2026.6.0',
      sagaId: 'T9997',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      writeChangelog: false,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('E_EPIC_EMPTY');
    expect(result.error.message).toContain('no eligible member epics');
  });

  it('rejects when both --saga and --epic are provided', async () => {
    const result = await releasePlan({
      version: 'v2026.6.0',
      sagaId: 'T9999',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      writeChangelog: false,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('E_INVALID_INPUT');
    expect(result.error.message).toContain('mutually exclusive');
  });

  it('rejects when neither --saga nor --epic is provided', async () => {
    const result = await releasePlan({
      version: 'v2026.6.0',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      writeChangelog: false,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('E_INVALID_INPUT');
    expect(result.error.message).toContain('--saga or --epic is required');
  });
});

// ---------------------------------------------------------------------------
// Fix 2: Leaf-Epic-as-Task (Epic with zero children is valid input)
// ---------------------------------------------------------------------------

describe('releasePlan --epic <leaf> (T9838 Fix 2)', () => {
  it('treats a leaf Epic with evidence as the singleton task list', async () => {
    // Seed only the Epic itself — no children. Default evidence atoms on the
    // Epic come from `makeTask`.
    const accessor = await createSqliteDataAccessor(testDir);
    try {
      await accessor.setMetaValue('schema_version', '2.10.0');
      await accessor.upsertSingleTask(
        makeTask({
          id: 'T9788',
          type: 'epic',
          title: 'Leaf Epic — shipped as one PR',
        }),
      );
    } finally {
      await accessor.close();
    }

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9788',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      writeChangelog: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    // The Epic itself counts as the singleton.
    expect(result.data.taskCount).toBe(1);
    expect(result.data.epicId).toBe('T9788');
    expect(result.data.evidenceComplete).toBe(true);
    // Plan file written.
    expect(existsSync(result.data.planPath)).toBe(true);
  });

  it('returns E_EPIC_EMPTY_LEAF_NO_EVIDENCE when leaf Epic has zero atoms', async () => {
    // Leaf Epic + zero evidence atoms. T9838 Fix 2 says we surface a
    // dedicated error code (NOT the generic E_EPIC_EMPTY) so consumers can
    // route the operator to `cleo verify` instead of `cleo show + add child`.
    const accessor = await createSqliteDataAccessor(testDir);
    try {
      await accessor.setMetaValue('schema_version', '2.10.0');
      await accessor.upsertSingleTask(
        makeTaskNoEvidence({
          id: 'T9789',
          type: 'epic',
          title: 'Leaf Epic — no evidence',
        }),
      );
    } finally {
      await accessor.close();
    }

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9789',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      writeChangelog: false,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('E_EPIC_EMPTY_LEAF_NO_EVIDENCE');
    expect(result.error.message).toContain('zero child tasks');
    expect(result.error.message).toContain('zero evidence atoms');
  });

  it('continues to work for Epics WITH children (no regression on the multi-task path)', async () => {
    await seedEpicWithChildren('T9777', 3);

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9777',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      writeChangelog: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.taskCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: Auto-write CHANGELOG.md section (idempotent, opt-out via flag)
// ---------------------------------------------------------------------------

describe('releasePlan writes CHANGELOG.md (T9838 Fix 3)', () => {
  it('inserts a new ## [version] section into a fresh CHANGELOG.md', async () => {
    await seedEpicWithChildren('T9999', 1);
    seedFeatChangeset();

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.changelogWritten).toBe(true);
    expect(result.data.changelogPath).toBe(join(testDir, 'CHANGELOG.md'));

    const body = readFileSync(result.data.changelogPath, 'utf-8');
    expect(body).toContain('## [2026.6.0]');
    expect(body).toContain('A new capability.');
    // Default header seeded for fresh files.
    expect(body).toContain('# Changelog');
  });

  it('replaces an existing ## [version] section idempotently on re-run', async () => {
    await seedEpicWithChildren('T9999', 1);
    seedFeatChangeset();

    // First run — section created.
    const first = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(first.success).toBe(true);
    if (!first.success) throw new Error('unreachable');
    const firstBody = readFileSync(first.data.changelogPath, 'utf-8');

    // Second run with identical inputs — same content, written=false.
    const second = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(second.success).toBe(true);
    if (!second.success) throw new Error('unreachable');

    const secondBody = readFileSync(second.data.changelogPath, 'utf-8');
    expect(secondBody).toBe(firstBody);
    expect(second.data.changelogWritten).toBe(false);

    // Exactly one `## [2026.6.0]` block — no duplication.
    const matches = secondBody.match(/^## \[2026\.6\.0\]/gm) ?? [];
    expect(matches).toHaveLength(1);
    // Also assert no orphan aggregator `## v2026.6.0 — DATE` line remains
    // (the canonical bracketed header is the SoT).
    const bareHeader = secondBody.match(/^## v2026\.6\.0/gm) ?? [];
    expect(bareHeader).toHaveLength(0);
  });

  it('replaces the section block (not just the header) on aggregator content change', async () => {
    await seedEpicWithChildren('T9999', 1);
    seedFeatChangeset();
    await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });

    // Add a SECOND changeset — body should now contain both entries; the
    // existing section is replaced wholesale (not appended).
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
    expect(second.data.changelogWritten).toBe(true);

    const body = readFileSync(second.data.changelogPath, 'utf-8');
    expect(body).toContain('A new capability.');
    expect(body).toContain('A sample bug fix.');
    // Still exactly one section header.
    const matches = body.match(/^## \[2026\.6\.0\]/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('writeChangelog=false skips the CHANGELOG.md write', async () => {
    await seedEpicWithChildren('T9999', 1);
    seedFeatChangeset();

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      writeChangelog: false,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.changelogWritten).toBe(false);
    expect(existsSync(result.data.changelogPath)).toBe(false);
  });

  it('writes a placeholder CHANGELOG section when aggregated release notes are empty (T10105)', async () => {
    // No `.changeset/` entries → aggregated.markdown is empty. Per T10105
    // (Saga T10099 AC2/AC3) the section MUST still be written with a
    // placeholder body — the pre-T10105 silent-skip caused the v2026.5.100
    // ship to drop CHANGELOG entries for v5.100/v5.101/v5.103.
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
    expect(result.data.changelogWritten).toBe(true);
    expect(existsSync(result.data.changelogPath)).toBe(true);
    const body = readFileSync(result.data.changelogPath, 'utf8');
    expect(body).toMatch(/^## \[2026\.6\.0\] \(\d{4}-\d{2}-\d{2}\)/m);
    expect(body).toMatch(/No changeset entries parsed for this release/);
  });

  it('preserves unrelated sections when inserting the new ## [version] block', async () => {
    await seedEpicWithChildren('T9999', 1);
    seedFeatChangeset();

    // Pre-seed a CHANGELOG with an older section the plan flow MUST NOT touch.
    const preExisting = [
      '# Changelog',
      '',
      '## [2025.1.0] (2025-01-15)',
      '',
      '- Older release notes left intact.',
      '',
    ].join('\n');
    writeFileSync(join(testDir, 'CHANGELOG.md'), preExisting, 'utf-8');

    const result = await releasePlan({
      version: 'v2026.6.0',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.changelogWritten).toBe(true);

    const body = readFileSync(result.data.changelogPath, 'utf-8');
    // New section inserted FIRST (right after the title).
    expect(body).toMatch(/# Changelog[\s\S]*## \[2026\.6\.0\][\s\S]*## \[2025\.1\.0\]/);
    // Older section content preserved verbatim.
    expect(body).toContain('Older release notes left intact.');
  });
});

// ---------------------------------------------------------------------------
// Pure-helper coverage — replaceOrInsertChangelogSection
// ---------------------------------------------------------------------------

describe('replaceOrInsertChangelogSection (pure)', () => {
  it('inserts after the # title on a fresh file', () => {
    const out = replaceOrInsertChangelogSection(
      '',
      'v1.0.0',
      '## [v1.0.0] (2026-05-20)\n\n- entry\n',
    );
    expect(out).toContain('# Changelog');
    expect(out).toContain('## [v1.0.0]');
  });

  it('replaces an existing section by version match', () => {
    const existing = [
      '# Changelog',
      '',
      '## [v1.0.0] (2025-01-01)',
      '',
      '- OLD',
      '',
      '## [v0.9.0] (2024-12-01)',
      '',
      '- legacy',
      '',
    ].join('\n');
    const out = replaceOrInsertChangelogSection(
      existing,
      'v1.0.0',
      '## [v1.0.0] (2026-05-20)\n\n- NEW\n',
    );
    expect(out).toContain('- NEW');
    expect(out).not.toContain('- OLD');
    expect(out).toContain('- legacy'); // v0.9.0 preserved.
  });

  it('inserts the new section before existing sections when version is new', () => {
    const existing = ['# Changelog', '', '## [v0.9.0] (2024-12-01)', '', '- legacy', ''].join('\n');
    const out = replaceOrInsertChangelogSection(
      existing,
      'v1.0.0',
      '## [v1.0.0] (2026-05-20)\n\n- NEW\n',
    );
    // v1.0.0 appears BEFORE v0.9.0 in the file.
    const idxNew = out.indexOf('## [v1.0.0]');
    const idxOld = out.indexOf('## [v0.9.0]');
    expect(idxNew).toBeGreaterThan(-1);
    expect(idxOld).toBeGreaterThan(idxNew);
  });
});
