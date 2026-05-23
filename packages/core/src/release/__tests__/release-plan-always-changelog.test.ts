/**
 * T10105 — `cleo release plan` MUST always write the CHANGELOG section.
 *
 * Pre-T10105 behaviour: when zero changeset entries parsed, the
 * `writeChangelogSection` call was skipped (guarded by
 * `aggregated.markdown.trim().length > 0`). Result: the v2026.5.100 ship
 * never wrote a `## [v2026.5.100]` block to CHANGELOG.md, and the section
 * appeared to "skip" straight from v5.102 → v5.99.
 *
 * Post-T10105 behaviour: the section is ALWAYS written. When the
 * aggregator produced no content, a placeholder body is inserted instead
 * + a WARN-level log explicitly states the empty-content reason.
 *
 * @task T10105
 * @epic E-RELEASE-PLAN-CHANGELOG
 * @saga T10099
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { releasePlan } from '../plan.js';

let testDir: string;

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

async function seedEpicWithChild(epicId: string, childId: string): Promise<void> {
  const accessor = await createSqliteDataAccessor(testDir);
  try {
    await accessor.setMetaValue('schema_version', '2.10.0');
    await accessor.upsertSingleTask(
      makeTask({ id: epicId, type: 'epic', title: 'Epic', pipelineStage: 'contribution' }),
    );
    await accessor.upsertSingleTask(makeTask({ id: childId, parentId: epicId }));
  } finally {
    await accessor.close();
  }
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-plan-always-cl-'));
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
    /* best-effort */
  }
  await rm(testDir, { recursive: true, force: true });
});

describe('releasePlan — always writes CHANGELOG.md section (T10105)', () => {
  it('writes a placeholder section when ZERO changesets are present', async () => {
    await seedEpicWithChild('T9999', 'T10001');
    // Deliberately do NOT create `.changeset/` — exercises the path that
    // pre-T10105 silently elided the CHANGELOG entry.

    const result = await releasePlan({
      version: 'v2026.5.100',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.changelogWritten).toBe(true);
    expect(result.data.changesetEntryCount).toBe(0);

    const changelogPath = join(testDir, 'CHANGELOG.md');
    expect(existsSync(changelogPath)).toBe(true);
    const body = readFileSync(changelogPath, 'utf8');
    expect(body).toMatch(/^## \[2026\.5\.100\] \(\d{4}-\d{2}-\d{2}\)/m);
    expect(body).toMatch(/No changeset entries parsed for this release/);
  });

  it('writes a placeholder section when the .changeset directory exists but is empty', async () => {
    await seedEpicWithChild('T9999', 'T10001');
    // Create the directory with only README.md so parseChangesetDir returns [].
    await mkdir(join(testDir, '.changeset'), { recursive: true });
    writeFileSync(join(testDir, '.changeset', 'README.md'), '# Empty\n', 'utf8');

    const result = await releasePlan({
      version: 'v2026.5.101',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.changelogWritten).toBe(true);

    const body = readFileSync(join(testDir, 'CHANGELOG.md'), 'utf8');
    expect(body).toMatch(/^## \[2026\.5\.101\] \(\d{4}-\d{2}-\d{2}\)/m);
    expect(body).toMatch(/No changeset entries parsed for this release/);
  });

  it('writes real release notes when at least one changeset is present', async () => {
    await seedEpicWithChild('T9999', 'T10001');
    await mkdir(join(testDir, '.changeset'), { recursive: true });
    writeFileSync(
      join(testDir, '.changeset', 'real-entry.md'),
      [
        '---',
        'id: real-entry',
        'tasks: [T10001]',
        'kind: feat',
        'prs: [123]',
        'summary: Real feature shipped.',
        '---',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await releasePlan({
      version: 'v2026.5.103',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.changelogWritten).toBe(true);
    expect(result.data.changesetEntryCount).toBe(1);

    const body = readFileSync(join(testDir, 'CHANGELOG.md'), 'utf8');
    expect(body).toMatch(/^## \[2026\.5\.103\] \(\d{4}-\d{2}-\d{2}\)/m);
    expect(body).toMatch(/Real feature shipped/);
    // Placeholder must NOT be present when real entries exist.
    expect(body).not.toMatch(/No changeset entries parsed for this release/);
  });

  it('honours writeChangelog=false (opt-out) and skips the write entirely', async () => {
    await seedEpicWithChild('T9999', 'T10001');

    const result = await releasePlan({
      version: 'v2026.5.104',
      epicId: 'T9999',
      channel: 'latest',
      scheme: 'calver',
      projectRoot: testDir,
      writeChangelog: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.changelogWritten).toBe(false);
    expect(existsSync(join(testDir, 'CHANGELOG.md'))).toBe(false);
  });
});
