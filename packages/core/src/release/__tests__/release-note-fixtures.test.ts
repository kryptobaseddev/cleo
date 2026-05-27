/**
 * Greenfield/brownfield fixtures for deterministic release-note rendering (T10473).
 *
 * These tests exercise `releasePlan` end-to-end against fresh TypeScript,
 * Python, Rust, and cleocode-shaped project directories. They intentionally do
 * not call network/model providers: the rendered CHANGELOG section comes only
 * from `.changeset/*.md` task anchors plus local project metadata.
 *
 * @task T10473
 * @epic T9759
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { parseReleasePlan } from '@cleocode/contracts';
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

async function initProjectSkeleton(projectName: string): Promise<void> {
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
      projectHash: `${projectName}-hash`,
      projectId: `${projectName}-id`,
      projectRoot: testDir,
      projectName,
    }),
  );
  execFileSync('git', ['init', '--quiet', testDir], { encoding: 'utf-8' });
  execFileSync('git', ['-C', testDir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', testDir, 'config', 'user.name', 'Test']);
}

async function seedEpicWithChildren(epicId: string, childIds: readonly string[]): Promise<void> {
  const accessor = await createSqliteDataAccessor(testDir);
  try {
    await accessor.setMetaValue('schema_version', '2.10.0');
    await accessor.upsertSingleTask(
      makeTask({ id: epicId, type: 'epic', title: 'Release fixture epic' }),
    );
    for (const id of childIds) {
      await accessor.upsertSingleTask(makeTask({ id, parentId: epicId, title: `Fixture ${id}` }));
    }
  } finally {
    await accessor.close();
  }
}

function writeChangeset(slug: string, lines: readonly string[]): void {
  const dir = join(testDir, '.changeset');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), `${lines.join('\n')}\n`, 'utf8');
}

function commitFixtureInputs(): void {
  execFileSync('git', ['-C', testDir, 'add', '.'], { encoding: 'utf-8' });
  execFileSync(
    'git',
    ['-C', testDir, 'commit', '--quiet', '-m', 'test: seed release-note fixture'],
    {
      encoding: 'utf-8',
    },
  );
}

async function planFixture(): Promise<{ changelog: string; releaseNotes: string }> {
  commitFixtureInputs();
  const result = await releasePlan({
    version: 'v2026.6.0',
    epicId: 'T9999',
    channel: 'latest',
    scheme: 'calver',
    projectRoot: testDir,
    createdBy: 'release-note-fixture-test',
  });

  if (!result.success) throw new Error(JSON.stringify(result.error));
  expect(result.data.changelogWritten).toBe(true);
  expect(existsSync(result.data.changelogPath)).toBe(true);

  const plan = parseReleasePlan(JSON.parse(readFileSync(result.data.planPath, 'utf-8')));
  const releaseNotes = String((plan.meta as Record<string, unknown>).releaseNotes ?? '');
  return {
    changelog: readFileSync(result.data.changelogPath, 'utf-8'),
    releaseNotes,
  };
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-release-note-fixture-'));
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

describe('deterministic release-note fixtures (T10473)', () => {
  it.each([
    {
      name: 'typescript',
      manifest: ['package.json', JSON.stringify({ name: 'fixture-ts', type: 'module' })],
      task: 'T10001',
      change: 'TypeScript fixture publishes typed release notes.',
      section: 'Added',
      kind: 'feat',
    },
    {
      name: 'python',
      manifest: ['pyproject.toml', '[project]\nname = "fixture-python"\nversion = "0.1.0"\n'],
      task: 'T10002',
      change: 'Python fixture documents packaging fixes.',
      section: 'Fixed',
      kind: 'fix',
    },
    {
      name: 'rust',
      manifest: [
        'Cargo.toml',
        '[package]\nname = "fixture-rust"\nversion = "0.1.0"\nedition = "2021"\n',
      ],
      task: 'T10003',
      change: 'Rust fixture records security hardening.',
      section: 'Security',
      kind: 'chore',
      releaseNoteSection: 'security',
    },
  ])('renders a fresh $name fixture into valid CHANGELOG sections', async (fixture) => {
    await initProjectSkeleton(`fixture-${fixture.name}`);
    writeFileSync(join(testDir, fixture.manifest[0]), fixture.manifest[1], 'utf8');
    await seedEpicWithChildren('T9999', [fixture.task]);
    writeChangeset(`${fixture.name}-entry`, [
      '---',
      `id: ${fixture.name}-entry`,
      `tasks: [${fixture.task}]`,
      `kind: ${fixture.kind}`,
      `summary: ${fixture.change}`,
      ...(fixture.releaseNoteSection
        ? ['releaseNotes:', `  section: ${fixture.releaseNoteSection}`]
        : []),
      '---',
      '',
    ]);

    const { changelog, releaseNotes } = await planFixture();

    expect(releaseNotes).toContain(`### ${fixture.section}`);
    expect(changelog).toContain(`### ${fixture.section}`);
    expect(changelog).toContain(fixture.change);
    expect(changelog).toContain(`provenance: [${fixture.task}](`);
  });

  it('renders cleocode-style fixture task and PR provenance as hyperlinks', async () => {
    await initProjectSkeleton('cleocode');
    writeFileSync(join(testDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n', 'utf8');
    await seedEpicWithChildren('T9999', ['T10473']);
    writeChangeset('cleocode-provenance', [
      '---',
      'id: cleocode-provenance',
      'tasks: [T10473]',
      'kind: feat',
      'prs: [804]',
      'summary: cleocode release notes include provenance links.',
      'releaseNotes:',
      '  targets: ["@cleocode/core"]',
      '  impact: cleocode fixture exposes task and PR provenance.',
      '---',
      '',
    ]);

    const { changelog } = await planFixture();

    expect(changelog).toContain(
      '**@cleocode/core:** cleocode fixture exposes task and PR provenance.',
    );
    expect(changelog).toContain(
      '[T10473](https://github.com/kryptobaseddev/cleo/search?q=T10473&type=commits)',
    );
    expect(changelog).toContain('[#804](https://github.com/kryptobaseddev/cleo/pull/804)');
  });

  it('preserves surrounding brownfield CHANGELOG content while replacing only the planned section', async () => {
    await initProjectSkeleton('fixture-brownfield');
    await seedEpicWithChildren('T9999', ['T10004']);
    writeFileSync(
      join(testDir, 'CHANGELOG.md'),
      [
        '# Changelog',
        '',
        'Intro text kept by brownfield projects.',
        '',
        '## [2026.5.0] (2026-05-01)',
        '',
        '### Fixed',
        '',
        '- Prior release remains intact.',
        '',
      ].join('\n'),
      'utf8',
    );
    writeChangeset('brownfield-fix', [
      '---',
      'id: brownfield-fix',
      'tasks: [T10004]',
      'kind: fix',
      'summary: Brownfield fixture replaces only the new release block.',
      '---',
      '',
    ]);

    const { changelog } = await planFixture();

    expect(changelog).toContain('Intro text kept by brownfield projects.');
    expect(changelog).toContain('## [2026.5.0] (2026-05-01)');
    expect(changelog).toContain('- Prior release remains intact.');
    expect(changelog).toContain('## [2026.6.0]');
    expect(changelog).toContain('Brownfield fixture replaces only the new release block.');
    expect(changelog.match(/^## \[2026\.6\.0\]/gm) ?? []).toHaveLength(1);
  });
});
