/** Regression coverage for staged Nexus graph replacement and recovery. */
import { execFileSync } from 'node:child_process';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GraphPublicationRows } from '@cleocode/contracts';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worktreeScope } from '../../paths.js';
import { createOperationExecutionContext } from '../../store/background-ops.js';
import { getNexusDb } from '../../store/nexus-sqlite.js';
import { publishNexusGraph, runNexusAnalysis } from '../analyze-orchestrator.js';
import { assessKnowledgeCoverage, readKnowledgeIndexAssessment } from '../knowledge.js';
import * as sourceRootsModule from '../source-roots.js';
import { resolveSourceRoots } from '../source-roots.js';

vi.mock('../../store/nexus-sqlite.js', async () => ({
  getNexusDb: vi.fn(async () => drizzle({ client: native })),
  getNexusNativeDb: vi.fn(() => native),
  nexusSchema: await import('../../store/schema/cleo-project/nexus-graph.js'),
}));
vi.mock('../../resources/spawn-wrapper.js', () => ({ createParserExecutionPort: () => undefined }));
vi.mock('@cleocode/core/internal', () => ({
  refreshNexusBridge: vi.fn(),
  nexusUpdateIndexStats: vi.fn(),
}));
vi.mock('@cleocode/core/nexus', () => ({
  runGitLogTaskLinker: async () => ({ commitsProcessed: 0 }),
}));

let native: DatabaseSync;

beforeEach(() => {
  native = new DatabaseSync(':memory:');
  native.exec(`
    CREATE TABLE nexus_nodes (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL,
      name TEXT, file_path TEXT, start_line INTEGER, end_line INTEGER,
      language TEXT, is_exported INTEGER NOT NULL, parent_id TEXT,
      parameters_json TEXT, return_type TEXT, doc_summary TEXT,
      community_id TEXT, meta_json TEXT, is_external INTEGER DEFAULT 0,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE nexus_relations (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
      type TEXT NOT NULL, confidence REAL NOT NULL, reason TEXT, step INTEGER,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE _nexus_meta (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE _nexus_parse_cache (
      path TEXT PRIMARY KEY NOT NULL, content_hash TEXT NOT NULL,
      fingerprint TEXT NOT NULL, generation TEXT NOT NULL, payload BLOB NOT NULL
    );
    CREATE VIRTUAL TABLE nexus_symbols_fts USING fts5(name);
    INSERT INTO nexus_nodes (id, kind, label, is_exported, indexed_at)
      VALUES ('old', 'function', 'old', 1, '2026-01-01');
    INSERT INTO nexus_relations (id, source_id, target_id, type, confidence, indexed_at)
      VALUES ('old-edge', 'old', 'old', 'calls', 1, '2026-01-01');
    INSERT INTO nexus_symbols_fts (name) VALUES ('old');
  `);
});

afterEach(() => native.close());

/** A complete replacement generation using the shared publication contract. */
function replacement(): GraphPublicationRows {
  return {
    nodes: [
      {
        id: 'new',
        kind: 'function',
        label: 'new',
        name: 'new',
        filePath: 'new.ts',
        startLine: 1,
        endLine: 2,
        language: 'typescript',
        isExported: true,
        parentId: null,
        parametersJson: null,
        returnType: null,
        docSummary: null,
        communityId: null,
        metaJson: null,
        indexedAt: '2026-09-18',
      },
    ],
    relations: [
      {
        id: 'new-edge',
        sourceId: 'new',
        targetId: 'new',
        type: 'calls',
        confidence: 1,
        reason: null,
        step: null,
        indexedAt: '2026-09-18',
      },
    ],
  };
}

describe('publishNexusGraph', () => {
  it('replaces a complete generation and removes orphaned FTS rows', () => {
    publishNexusGraph(drizzle({ client: native }), replacement(), null);
    expect(native.prepare('SELECT id FROM nexus_nodes').all()).toEqual([{ id: 'new' }]);
    expect(native.prepare('SELECT id FROM nexus_relations').all()).toEqual([{ id: 'new-edge' }]);
    expect(native.prepare('SELECT name FROM nexus_symbols_fts').all()).toEqual([]);
    expect(
      native.prepare("SELECT value FROM _nexus_meta WHERE key = 'graph_generation'").get(),
    ).toBeDefined();
  });

  it('stores source scope and freshness with the same committed generation', () => {
    const rows = replacement();
    rows.assessment = {
      sourceRoot: '/project',
      assessedRevision: 'revision',
      assessedAt: '2026-09-18',
      includedRepositories: ['app'],
      files: [{ path: 'app/main.ts', status: 'analyzed', mtimeMs: 123, size: 42 }],
    };
    publishNexusGraph(drizzle({ client: native }), rows, null);
    expect(
      native.prepare("SELECT value FROM _nexus_meta WHERE key = 'graph_assessment'").get(),
    ).toEqual({ value: JSON.stringify(rows.assessment) });
  });

  it('restores nodes, edges, and FTS when publication fails after node insertion', () => {
    native.exec(`CREATE TRIGGER fail_relation BEFORE INSERT ON nexus_relations
      BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END;`);
    expect(() => publishNexusGraph(drizzle({ client: native }), replacement(), null)).toThrow();
    expect(native.prepare('SELECT id FROM nexus_nodes').all()).toEqual([{ id: 'old' }]);
    expect(native.prepare('SELECT id FROM nexus_relations').all()).toEqual([{ id: 'old-edge' }]);
    expect(native.prepare('SELECT name FROM nexus_symbols_fts').all()).toEqual([{ name: 'old' }]);
    expect(native.prepare('SELECT * FROM _nexus_meta').all()).toEqual([]);
  });

  it('commits the staged publication identity while preserving separate source hashes', () => {
    const rows = replacement();
    const generation = '11111111-1111-4111-8111-111111111111';
    rows.generation = generation;
    rows.nodes[0]!.metaJson = JSON.stringify({
      lexicalCapability: 'typescript-javascript',
      publicationGeneration: generation,
      sourceGeneration: 'a'.repeat(64),
    });
    rows.assessment = {
      generation,
      sourceRoot: '/fixture',
      assessedRevision: null,
      assessedAt: '2026-09-19',
      files: [],
      references: [
        {
          kind: 'shadowed',
          filePath: 'new.ts',
          sourceId: 'new',
          targetName: 'local',
          relationship: 'calls',
          reason: 'Local binding is not an imported target',
          generation: 'a'.repeat(64),
          publicationGeneration: generation,
        },
      ],
    };
    publishNexusGraph(drizzle({ client: native }), rows, null);
    expect(
      native.prepare("SELECT value FROM _nexus_meta WHERE key='graph_generation'").get(),
    ).toEqual({ value: generation });
    expect(
      native.prepare("SELECT value FROM _nexus_meta WHERE key='graph_assessment'").get(),
    ).toEqual({ value: JSON.stringify(rows.assessment) });
    expect(native.prepare('SELECT meta_json FROM nexus_nodes').get()).toEqual({
      meta_json: rows.nodes[0]!.metaJson,
    });
    expect(() => publishNexusGraph(drizzle({ client: native }), rows, generation)).toThrow(
      'fresh immutable identity',
    );
  });

  it.each([
    'assessment',
    'reference',
    'declaration',
  ])('refuses mixed %s publication identities without changing the previous graph', (part) => {
    const rows = replacement();
    const generation = '22222222-2222-4222-8222-222222222222';
    const other = '33333333-3333-4333-8333-333333333333';
    rows.generation = generation;
    rows.assessment = {
      generation: part === 'assessment' ? other : generation,
      sourceRoot: '/fixture',
      assessedRevision: null,
      assessedAt: '2026-09-19',
      files: [],
      references:
        part === 'reference'
          ? [
              {
                kind: 'dynamic',
                filePath: 'new.ts',
                sourceId: 'new',
                targetName: 'computed',
                relationship: 'calls',
                reason: 'Dynamic expression',
                publicationGeneration: other,
              },
            ]
          : [],
    };
    rows.nodes[0]!.metaJson = JSON.stringify({
      lexicalCapability: 'typescript-javascript',
      publicationGeneration: part === 'declaration' ? other : generation,
    });
    expect(() => publishNexusGraph(drizzle({ client: native }), rows, null)).toThrow(
      'publication generation',
    );
    expect(native.prepare('SELECT id FROM nexus_nodes').all()).toEqual([{ id: 'old' }]);
    expect(native.prepare('SELECT id FROM nexus_relations').all()).toEqual([{ id: 'old-edge' }]);
    expect(native.prepare('SELECT name FROM nexus_symbols_fts').all()).toEqual([{ name: 'old' }]);
    expect(native.prepare('SELECT * FROM _nexus_meta').all()).toEqual([]);
  });

  it('rejects a stale concurrent publication without replacing the winning graph', () => {
    const db = drizzle({ client: native });
    publishNexusGraph(db, replacement(), null);
    const stale = replacement();
    stale.nodes[0]!.id = 'stale';
    expect(() => publishNexusGraph(db, stale, null)).toThrow('changed during indexing');
    expect(native.prepare('SELECT id FROM nexus_nodes').all()).toEqual([{ id: 'new' }]);
  });
});

/** Actual Git output is the independent oracle for per-root revision fixtures. */
function fixtureGit(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Create one owned repository with an independently observable committed file. */
async function fixtureRepository(root: string, content: string): Promise<string> {
  await mkdir(root, { recursive: true });
  fixtureGit(root, 'init', '--quiet');
  await writeFile(join(root, 'same.ts'), content);
  fixtureGit(root, 'add', 'same.ts');
  fixtureGit(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'source fixture',
  );
  return fixtureGit(root, 'rev-parse', 'HEAD');
}

describe('explicit owned source-root provenance', () => {
  let parent: string;
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'source-root-provenance-'));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(parent, { recursive: true, force: true });
  });

  it('preserves non-Git parent identity and separate revisions/prefixes for identical filenames', async () => {
    const first = join(parent, 'first');
    const second = join(parent, 'second');
    const headA = await fixtureRepository(first, 'export const first = 1;');
    const headB = await fixtureRepository(second, 'export const second = 2;');
    await fixtureRepository(join(parent, 'unselected'), 'export const hidden = true;');
    const assessment = await resolveSourceRoots({
      projectId: 'immutable-parent',
      projectRoot: parent,
      includedRepositories: ['first', 'second'],
    });
    expect(assessment.projectId).toBe('immutable-parent');
    expect(assessment.projectRoot).toBe(parent);
    expect(assessment.roots).toEqual([
      expect.objectContaining({
        canonicalPath: parent,
        graphPrefix: '',
        status: 'unversioned',
        revision: null,
      }),
      expect.objectContaining({
        canonicalPath: first,
        graphPrefix: 'first',
        status: 'available',
        revision: headA,
      }),
      expect.objectContaining({
        canonicalPath: second,
        graphPrefix: 'second',
        status: 'available',
        revision: headB,
      }),
    ]);
    expect(assessment.roots.map((root) => root.graphPrefix + '/same.ts')).toEqual([
      '/same.ts',
      'first/same.ts',
      'second/same.ts',
    ]);
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.roots)).toBe(true);
    expect(
      assessment.roots.every((root) => Object.isFrozen(root) && Object.isFrozen(root.diagnostics)),
    ).toBe(true);
  });

  it('observes a normal source repository without replacing a distinct parent identity', async () => {
    const repository = join(parent, 'checkout');
    const revision = await fixtureRepository(repository, 'export const source = true;');
    const assessment = await resolveSourceRoots({
      projectId: 'parent-id',
      projectRoot: parent,
      sourceRoot: repository,
    });
    expect(assessment.projectRoot).toBe(parent);
    expect(assessment.sourceRoot).toBe(repository);
    expect(assessment.roots).toEqual([
      expect.objectContaining({
        canonicalPath: repository,
        graphPrefix: '',
        revision,
        status: 'available',
      }),
    ]);
  });

  it('observes linked worktrees through their Git file marker', async () => {
    const repository = join(parent, 'repository');
    const revision = await fixtureRepository(repository, 'export const worktree = true;');
    const linked = join(parent, 'linked');
    fixtureGit(repository, 'worktree', 'add', '--quiet', '--detach', linked);
    const assessment = await resolveSourceRoots({
      projectId: 'parent-id',
      projectRoot: parent,
      includedRepositories: ['linked'],
    });
    expect(assessment.roots[1]).toMatchObject({
      canonicalPath: linked,
      graphPrefix: 'linked',
      revision,
      status: 'available',
    });
  });

  it('keeps missing roots and unusable Git metadata explicitly diagnostic', async () => {
    await mkdir(join(parent, 'broken/.git'), { recursive: true });
    const assessment = await resolveSourceRoots({
      projectId: 'parent-id',
      projectRoot: parent,
      includedRepositories: ['missing', 'broken'],
    });
    expect(assessment.roots[1]).toMatchObject({
      requestedPath: join(parent, 'missing'),
      canonicalPath: null,
      status: 'missing',
      revision: null,
    });
    expect(assessment.roots[1]?.diagnostics.join(' ')).toContain('Cannot observe');
    expect(assessment.roots[2]).toMatchObject({
      canonicalPath: join(parent, 'broken'),
      status: 'failed',
      revision: null,
    });
    expect(assessment.roots[2]?.diagnostics.join(' ')).toContain('Git revision observation failed');
  });

  it('records a changed revision without modifying the earlier observation', async () => {
    const initial = await fixtureRepository(parent, 'export const before = true;');
    const before = await resolveSourceRoots({ projectId: 'stable-id', projectRoot: parent });
    await writeFile(join(parent, 'same.ts'), 'export const after = true;');
    fixtureGit(parent, 'add', 'same.ts');
    fixtureGit(
      parent,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'changed revision',
    );
    const next = fixtureGit(parent, 'rev-parse', 'HEAD');
    const after = await resolveSourceRoots({ projectId: 'stable-id', projectRoot: parent });
    expect(after.roots[0]?.revision).toBe(next);
    expect(before.roots[0]?.revision).toBe(initial);
    expect(next).not.toBe(initial);
    expect(after.projectId).toBe(before.projectId);
  });

  it.each([
    '../escape',
    '/outside',
    'C:\\outside',
    '.',
  ])('rejects invalid ownership scope %s', async (included) => {
    await expect(
      resolveSourceRoots({
        projectId: 'parent',
        projectRoot: parent,
        includedRepositories: [included],
      }),
    ).rejects.toThrow(/ownership|relative path/);
  });

  it('rejects symlink aliases instead of publishing two prefixes for one owner', async () => {
    await fixtureRepository(join(parent, 'real'), 'export const real = true;');
    await symlink(join(parent, 'real'), join(parent, 'alias'), 'dir');
    await expect(
      resolveSourceRoots({
        projectId: 'parent',
        projectRoot: parent,
        includedRepositories: ['real', 'alias'],
      }),
    ).rejects.toThrow(/Ambiguous symlink ownership/);
  });

  it('does not inherit an ancestor checkout for an included ordinary directory', async () => {
    await fixtureRepository(parent, 'export const parent = true;');
    await mkdir(join(parent, 'ordinary'));
    const assessment = await resolveSourceRoots({
      projectId: 'parent',
      projectRoot: parent,
      includedRepositories: ['ordinary'],
    });
    expect(assessment.roots[1]).toMatchObject({ status: 'failed', revision: null });
    expect(assessment.roots[1]?.diagnostics).toContain(
      'Explicitly included root has no Git worktree marker.',
    );
  });

  it('isolates Git location pins and captures input before asynchronous filesystem work', async () => {
    const revision = await fixtureRepository(join(parent, 'app'), 'export const app = true;');
    vi.stubEnv('GIT_DIR', join(parent, 'unrelated/.git'));
    vi.stubEnv('GIT_WORK_TREE', join(parent, 'unrelated'));
    const input = { projectId: 'original-id', projectRoot: parent, includedRepositories: ['app'] };
    const pending = resolveSourceRoots(input);
    input.projectId = 'mutated';
    input.includedRepositories.push('not-requested');
    const assessment = await pending;
    expect(assessment.projectId).toBe('original-id');
    expect(assessment.roots).toHaveLength(2);
    expect(assessment.roots[1]).toMatchObject({ revision, status: 'available' });
  });

  it.each([
    'deadline',
    'cancellation',
  ])('terminates an active Git observation on %s', async (mode) => {
    await mkdir(join(parent, '.git'));
    const executable = join(parent, 'git');
    await writeFile(executable, '#!/bin/sh\nprintf "%s" "$$" > git.pid\nexec /bin/sleep 30\n');
    await chmod(executable, 0o755);
    vi.stubEnv('PATH', parent);
    const controller = new AbortController();
    const started = Date.now();
    // Observe rejection immediately so cancellation cannot become an unhandled rejection.
    const observation = resolveSourceRoots({
      projectId: 'parent',
      projectRoot: parent,
      deadline: started + (mode === 'deadline' ? 400 : 5000),
      signal: controller.signal,
    }).then(
      (value) => ({ value, error: null }),
      (error: Error) => ({ value: null, error }),
    );
    let pid: number | undefined;
    try {
      for (let attempt = 0; attempt < 100 && pid === undefined; attempt++) {
        try {
          pid = Number(await readFile(join(parent, 'git.pid'), 'utf8'));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(pid).toBeGreaterThan(0);
      if (mode === 'cancellation') controller.abort(new Error('fixture cancellation'));
      const result = await observation;
      if (mode === 'deadline') {
        expect(result.error).toBeNull();
        expect(result.value?.roots[0]).toMatchObject({ status: 'pending', revision: null });
      } else {
        expect(result.value).toBeNull();
        expect(result.error?.message).toBe('fixture cancellation');
      }
      let alive = true;
      for (let attempt = 0; attempt < 100 && alive; attempt++) {
        try {
          process.kill(pid!, 0);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      controller.abort();
      await observation;
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already reaped. */
        }
      }
    }
  });

  it('retains unavailable Git and budget exhaustion as different outcomes', async () => {
    await fixtureRepository(parent, 'export const root = true;');
    vi.stubEnv('PATH', join(parent, 'no-executables'));
    const failed = await resolveSourceRoots({ projectId: 'parent', projectRoot: parent });
    expect(failed.roots[0]).toMatchObject({ status: 'failed', revision: null });
    expect(failed.roots[0]?.diagnostics.join(' ')).toContain('ENOENT');
    const pending = await resolveSourceRoots({
      projectId: 'parent',
      projectRoot: parent,
      deadline: Date.now() - 1,
    });
    expect(pending.roots[0]).toMatchObject({ status: 'pending', revision: null });
    await expect(
      resolveSourceRoots({ projectId: 'parent', projectRoot: parent, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
});

describe('analysis root provenance integration', () => {
  let parent: string;
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'analysis-owned-roots-'));
    await mkdir(join(parent, '.cleo'));
    await writeFile(
      join(parent, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'stable-parent-id', projectHash: 'stable-parent-hash' }),
    );
    await fixtureRepository(join(parent, 'app'), 'export function source() { return 1; }');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(parent, { recursive: true, force: true });
  });

  const inventory = () =>
    JSON.stringify({
      nodes: native.prepare('SELECT * FROM nexus_nodes ORDER BY id').all(),
      relations: native.prepare('SELECT * FROM nexus_relations ORDER BY id').all(),
      meta: native.prepare('SELECT * FROM _nexus_meta ORDER BY key').all(),
      fts: native.prepare('SELECT * FROM nexus_symbols_fts ORDER BY name').all(),
    });

  it('publishes and canonically reads each included revision while retaining explicit parent identity', async () => {
    vi.stubEnv('CLEO_DIR', join(parent, 'wrong/.cleo'));
    vi.stubEnv('CLEO_ROOT', join(parent, 'wrong'));
    const result = await runNexusAnalysis({ repoPath: parent, includedRepositories: ['app'] });
    const revision = fixtureGit(join(parent, 'app'), 'rev-parse', 'HEAD');
    expect(result.projectId).toBe('stable-parent-id');
    expect(result.assessment?.sourceRoots).toMatchObject({
      projectId: 'stable-parent-id',
      projectRoot: parent,
      roots: [
        expect.objectContaining({ graphPrefix: '', revision: null, status: 'unversioned' }),
        expect.objectContaining({ graphPrefix: 'app', revision, status: 'available' }),
      ],
    });
    expect(await readKnowledgeIndexAssessment(parent)).toEqual(result.assessment);
    expect(getNexusDb).toHaveBeenCalledWith(parent);
    expect(worktreeScope.getStore()).toBeUndefined();
  });

  it('retains a distinct identity parent for an explicitly analyzed included repository', async () => {
    const result = await runNexusAnalysis({ projectRoot: parent, repoPath: join(parent, 'app') });
    expect(result.projectId).toBe('stable-parent-id');
    expect(result.assessment?.sourceRoots).toMatchObject({
      projectRoot: parent,
      sourceRoot: join(parent, 'app'),
    });
  });

  it('records a new revision without rebuilding identical sources, and rebuilds on a root configuration change', async () => {
    const first = await runNexusAnalysis({ repoPath: parent, includedRepositories: ['app'] });
    const unchanged = await runNexusAnalysis({ repoPath: parent, incremental: true });
    expect(unchanged.incremental).toBe(true);
    expect(unchanged.summary.mode).toBe('unchanged');
    expect(unchanged.assessment?.generation).toBe(first.assessment?.generation);
    fixtureGit(
      join(parent, 'app'),
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '--quiet',
      '-m',
      'revision only',
    );
    // T12315: a commit that changes no bytes is not a reason to re-parse. The
    // graph is kept, and the revision it was just re-verified against is
    // recorded, so knowledge coverage does not report it stale.
    const next = await runNexusAnalysis({ repoPath: parent, incremental: true });
    expect(next.summary.mode).toBe('unchanged');
    expect(next.assessment?.generation).toBe(first.assessment?.generation);
    expect(next.assessment?.sourceRoots?.roots[1]?.revision).toBe(
      fixtureGit(join(parent, 'app'), 'rev-parse', 'HEAD'),
    );
    expect(await readKnowledgeIndexAssessment(parent)).toEqual(next.assessment);
    await fixtureRepository(join(parent, 'other'), 'export const other = true;');
    const changed = await runNexusAnalysis({
      repoPath: parent,
      includedRepositories: ['app', 'other'],
      incremental: true,
    });
    expect(changed.incremental).toBe(false);
    expect(changed.summary.reason).toMatch(/source ownership .* changed/);
    expect(changed.assessment?.generation).not.toBe(next.assessment?.generation);
    expect(changed.assessment?.sourceRoots?.roots.map((root) => root.graphPrefix)).toEqual([
      '',
      'app',
      'other',
    ]);
  });

  it.each([
    'revision',
    'file',
  ])('rechecks an incremental no-op after a concurrent %s change', async (change) => {
    await runNexusAnalysis({ repoPath: parent, includedRepositories: ['app'] });
    const before = inventory();
    let changed = false;
    await expect(
      runNexusAnalysis({
        repoPath: parent,
        incremental: true,
        onProgress() {
          if (changed) return;
          changed = true;
          if (change === 'revision')
            fixtureGit(
              join(parent, 'app'),
              '-c',
              'user.name=Fixture',
              '-c',
              'user.email=fixture@example.invalid',
              '-c',
              'commit.gpgsign=false',
              'commit',
              '--allow-empty',
              '--quiet',
              '-m',
              'during unchanged scan',
            );
          else writeFileSync(join(parent, 'app/same.ts'), 'export const changed = true;');
        },
      }),
    ).rejects.toThrow(/revision changed|Source files changed/);
    expect(inventory()).toBe(before);
  });

  it('retains the complete prior graph when an included revision changes during analysis', async () => {
    const before = inventory();
    let changed = false;
    await expect(
      runNexusAnalysis({
        repoPath: parent,
        includedRepositories: ['app'],
        onProgress() {
          if (changed) return;
          changed = true;
          fixtureGit(
            join(parent, 'app'),
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--allow-empty',
            '--quiet',
            '-m',
            'concurrent revision',
          );
        },
      }),
    ).rejects.toThrow('revision changed');
    expect(inventory()).toBe(before);
  });

  it.each([
    'edit',
    'add',
    'rename',
    'delete',
  ])('refuses an uncommitted %s made during the final Git check', async (change) => {
    const before = inventory();
    const actual = sourceRootsModule.resolveSourceRoots;
    let calls = 0;
    vi.spyOn(sourceRootsModule, 'resolveSourceRoots').mockImplementation(async (request) => {
      const observed = await actual(request);
      if (++calls === 2) {
        const file = join(parent, 'app/same.ts');
        if (change === 'edit') writeFileSync(file, 'export const changed = true;');
        if (change === 'add')
          writeFileSync(join(parent, 'app/added.ts'), 'export const added = true;');
        if (change === 'rename') renameSync(file, join(parent, 'app/renamed.ts'));
        if (change === 'delete') unlinkSync(file);
      }
      return observed;
    });
    await expect(
      runNexusAnalysis({ repoPath: parent, includedRepositories: ['app'] }),
    ).rejects.toThrow('Source files changed');
    expect(inventory()).toBe(before);
  });

  it('retains root diagnostics and refuses malformed stored revision evidence', async () => {
    const result = await runNexusAnalysis({ repoPath: parent, includedRepositories: ['app'] });
    expect(result.assessment?.sourceRoots?.roots[0]?.diagnostics).not.toHaveLength(0);
    const assessment = result.assessment!;
    const sourceRoots = assessment.sourceRoots!;
    native.prepare("UPDATE _nexus_meta SET value=? WHERE key='graph_assessment'").run(
      JSON.stringify({
        ...assessment,
        sourceRoots: {
          ...sourceRoots,
          roots: sourceRoots.roots.map((root) => ({ ...root, revision: 'fabricated' })),
        },
      }),
    );
    await expect(readKnowledgeIndexAssessment(parent)).rejects.toThrow();
  });

  it('marks an included empty commit stale through canonical coverage while preserving parent identity', async () => {
    await runNexusAnalysis({ repoPath: parent, includedRepositories: ['app'] });
    fixtureGit(
      join(parent, 'app'),
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '--quiet',
      '-m',
      'coverage revision',
    );
    const coverage = await assessKnowledgeCoverage(parent);
    expect(coverage.projectId).toBe('stable-parent-id');
    expect(coverage.status).toBe('stale');
    expect(coverage.reasons).toContain(
      `Source ownership or revision changed: ${join(parent, 'app')}`,
    );
    expect(
      coverage.evidence.some((evidence) => evidence.id === 'source_root:app' && evidence.revision),
    ).toBe(true);
  });

  it('preserves the inherited execution and deadline, rejecting cancellation before publication', async () => {
    const controller = new AbortController();
    const context = createOperationExecutionContext(
      {
        projectId: 'stable-parent-id',
        projectRoot: parent,
        actor: 'test',
        operation: 'nexus.analyze',
        idempotencyKey: 'scoped',
      },
      { budgetMs: 5000, signal: controller.signal },
    );
    const before = inventory();
    const actual = sourceRootsModule.resolveSourceRoots;
    let calls = 0;
    vi.spyOn(sourceRootsModule, 'resolveSourceRoots').mockImplementation(async (request) => {
      expect(worktreeScope.getStore()?.execution).toBe(context);
      expect(request.deadline).toBe(context.deadlineAt);
      const observed = await actual(request);
      if (++calls === 2) controller.abort();
      return observed;
    });
    try {
      await expect(
        worktreeScope.run(
          { worktreeRoot: parent, projectHash: 'stable-parent-hash', execution: context },
          () => runNexusAnalysis({ repoPath: parent, includedRepositories: ['app'] }),
        ),
      ).rejects.toThrow(/cancelled/i);
      expect(calls).toBe(2);
      expect(inventory()).toBe(before);
    } finally {
      context.close();
    }
  });

  it.each([
    'root',
    'identity',
    'deadline',
  ])('rejects incompatible or expired captured execution: %s', async (mismatch) => {
    const context = createOperationExecutionContext(
      {
        projectId: mismatch === 'identity' ? 'other-project' : 'stable-parent-id',
        projectRoot: mismatch === 'root' ? join(parent, 'wrong') : parent,
        actor: 'test',
        operation: 'nexus.analyze',
        idempotencyKey: 'scope-refusal',
      },
      { budgetMs: mismatch === 'deadline' ? 0 : 5000 },
    );
    const before = inventory();
    try {
      await expect(
        worktreeScope.run(
          {
            worktreeRoot: context.identity.projectRoot,
            projectHash: 'fixture',
            execution: context,
          },
          () => runNexusAnalysis({ repoPath: parent, includedRepositories: ['app'] }),
        ),
      ).rejects.toThrow(/scope|deadline/i);
      expect(inventory()).toBe(before);
    } finally {
      context.close();
    }
  });

  it('rejects an included root replaced with a symlink before publication', async () => {
    const actual = sourceRootsModule.resolveSourceRoots;
    const before = inventory();
    let calls = 0;
    vi.spyOn(sourceRootsModule, 'resolveSourceRoots').mockImplementation(async (request) => {
      if (++calls === 2) {
        renameSync(join(parent, 'app'), join(parent, 'moved'));
        await symlink(join(parent, 'moved'), join(parent, 'app'), 'dir');
      }
      return actual(request);
    });
    await expect(
      runNexusAnalysis({ repoPath: parent, includedRepositories: ['app'] }),
    ).rejects.toThrow('Ambiguous symlink ownership');
    expect(inventory()).toBe(before);
  });

  it('refuses unavailable stable identity and an unbound explicit identity', async () => {
    await rm(join(parent, '.cleo/project-info.json'));
    const before = inventory();
    for (const projectIdOverride of [undefined, 'unbound-id']) {
      await expect(
        runNexusAnalysis({ repoPath: parent, projectIdOverride, includedRepositories: ['app'] }),
      ).rejects.toThrow('Stable project identity is unavailable');
      expect(inventory()).toBe(before);
    }
  });

  it('validates explicit and saved identities against their project binding', async () => {
    await expect(
      runNexusAnalysis({
        repoPath: parent,
        projectIdOverride: 'other-project',
        includedRepositories: ['app'],
      }),
    ).rejects.toThrow('Explicit analysis identity differs');
    const result = await runNexusAnalysis({
      repoPath: parent,
      projectIdOverride: 'stable-parent-id',
      includedRepositories: ['app'],
    });
    await rm(join(parent, '.cleo/project-info.json'));
    expect(
      (
        await runNexusAnalysis({
          repoPath: parent,
          incremental: true,
          includedRepositories: ['app'],
        })
      ).projectId,
    ).toBe('stable-parent-id');
    const roots = result.assessment!.sourceRoots!;
    native.prepare("UPDATE _nexus_meta SET value=? WHERE key='graph_assessment'").run(
      JSON.stringify({
        ...result.assessment,
        sourceRoots: { ...roots, projectRoot: join(parent, 'foreign-parent') },
      }),
    );
    const before = inventory();
    await expect(
      runNexusAnalysis({ repoPath: parent, includedRepositories: ['app'] }),
    ).rejects.toThrow('Stored graph ownership differs');
    expect(inventory()).toBe(before);
  });

  it('refuses parent identity changes after staging and retains the complete graph', async () => {
    await runNexusAnalysis({ repoPath: parent, includedRepositories: ['app'] });
    const before = inventory();
    await expect(
      runNexusAnalysis({
        repoPath: parent,
        includedRepositories: ['app'],
        onProgress: () =>
          writeFileSync(
            join(parent, '.cleo/project-info.json'),
            JSON.stringify({
              projectId: 'rebound-project',
              projectHash: 'rebound-hash',
            }),
          ),
      }),
    ).rejects.toThrow(/identity/);
    expect(inventory()).toBe(before);
  });

  it('retains historical descriptors but refuses current coverage for mismatched project binding', async () => {
    const result = await runNexusAnalysis({ repoPath: parent, includedRepositories: ['app'] });
    for (const invalid of [
      { projectRoot: join(parent, 'foreign-parent') },
      { projectId: 'foreign-id' },
    ]) {
      native.prepare("UPDATE _nexus_meta SET value=? WHERE key='graph_assessment'").run(
        JSON.stringify({
          ...result.assessment,
          sourceRoots: { ...result.assessment!.sourceRoots!, ...invalid },
        }),
      );
      expect(await readKnowledgeIndexAssessment(parent)).not.toBeNull();
      const coverage = await assessKnowledgeCoverage(parent);
      expect(coverage.status).toBe('failed');
      expect(coverage.reasons.join(' ')).toContain('Recorded source ownership differs');
    }
  });

  it('surfaces malformed parent metadata instead of silently deriving another identity', async () => {
    await writeFile(join(parent, '.cleo/project-info.json'), '{broken');
    const before = inventory();
    await expect(
      runNexusAnalysis({ repoPath: parent, includedRepositories: ['app'] }),
    ).rejects.toThrow();
    expect(inventory()).toBe(before);
  });

  it('keeps legacy assessments readable and explicitly incomplete without fabricating roots', async () => {
    const result = await runNexusAnalysis({ repoPath: parent, includedRepositories: ['app'] });
    const { sourceRoots: _historicalRoots, ...legacy } = result.assessment!;
    native
      .prepare("UPDATE _nexus_meta SET value=? WHERE key='graph_assessment'")
      .run(JSON.stringify(legacy));
    expect((await readKnowledgeIndexAssessment(parent))?.sourceRoots).toBeUndefined();
    const coverage = await assessKnowledgeCoverage(parent, 'stable-parent-id');
    expect(coverage.status).toBe('partial');
    expect(coverage.reasons).toContain(
      'Legacy generation has no verified per-root ownership or revision observations.',
    );
  });
});
