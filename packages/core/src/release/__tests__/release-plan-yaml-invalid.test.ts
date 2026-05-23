/**
 * T10105 — Vitest reproduction of the v2026.5.100 silent-skip bug.
 *
 * Pre-T10105 behaviour: a `.changeset/*.md` whose YAML frontmatter could
 * not be parsed (e.g. an unquoted colon in `summary:`) caused
 * `parseChangesetDir` to throw, which `readChangesetEntries` swallowed at
 * WARN level + returned `[]`. The aggregator then emitted empty release
 * notes, so the CHANGELOG.md section for that release was effectively
 * skipped. v5.100 / v5.101 / v5.103 were all dropped this way.
 *
 * Post-T10105: `cleo release plan` ABORTS with
 * `E_CHANGESET_YAML_INVALID`, surfaces the offending `file:line`, and
 * never silently drops the batch.
 *
 * @task T10105
 * @epic E-RELEASE-PLAN-CHANGELOG
 * @saga T10099
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { releasePlan } from '../plan.js';

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

function writeChangeset(slug: string, content: string): void {
  const dir = join(testDir, '.changeset');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), content, 'utf8');
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-plan-yaml-invalid-'));
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

describe('releasePlan — fail-loud on invalid YAML (T10105 / Saga T10099)', () => {
  it('aborts with E_CHANGESET_YAML_INVALID when a changeset has an unquoted colon in summary (v5.100 repro)', async () => {
    await seedEpicWithChild('T9999', 'T10001');

    // The exact shape of the v2026.5.100 silent-skip bug: a valid filename,
    // valid task ID, but `summary: foo: bar` is two compact mappings to YAML
    // which `yaml@2.x` rejects with BLOCK_AS_IMPLICIT_KEY at line 4.
    writeChangeset(
      'v5100-repro',
      [
        '---',
        'id: v5100-repro',
        'tasks: [T10001]',
        'kind: feat',
        'summary: feat(T10001): unquoted colon eats the entry',
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
      writeChangelog: false,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('E_CHANGESET_YAML_INVALID');
    expect(result.error.message).toMatch(/v5100-repro\.md/);
    expect(result.error.message).toMatch(/invalid YAML frontmatter/);
    expect(result.error.fix).toMatch(/quotes/);
    expect(result.error.details).toMatchObject({
      file: expect.stringMatching(/v5100-repro\.md$/),
      line: expect.any(Number),
      parserMessage: expect.any(String),
    });
    // Line must be 1-based and inside the file body (not zero/negative).
    expect((result.error.details as { line: number }).line).toBeGreaterThan(0);
  });

  it('does NOT silently drop a sibling valid changeset when one is malformed', async () => {
    await seedEpicWithChild('T9999', 'T10001');

    // One good entry, one bad — pre-T10105 dropped BOTH. Post-T10105 the
    // bad entry aborts the run.
    writeChangeset(
      'good-entry',
      [
        '---',
        'id: good-entry',
        'tasks: [T10001]',
        'kind: feat',
        'summary: A valid summary line.',
        '---',
        '',
      ].join('\n'),
    );
    writeChangeset(
      'bad-entry',
      [
        '---',
        'id: bad-entry',
        'tasks: [T10001]',
        'kind: fix',
        'summary: fix(T10001): unquoted colon breaks parse',
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
      writeChangelog: false,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    // Parser runs files in alphabetical order — `bad-entry.md` sorts BEFORE
    // `good-entry.md`, so the failure surfaces on bad-entry.
    expect(result.error.code).toBe('E_CHANGESET_YAML_INVALID');
    expect((result.error.details as { file: string }).file).toMatch(/bad-entry\.md$/);
  });
});
