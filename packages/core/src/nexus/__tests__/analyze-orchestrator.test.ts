/** Regression coverage for staged Nexus graph replacement and recovery. */
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GraphPublicationRows } from '@cleocode/contracts';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishNexusGraph } from '../analyze-orchestrator.js';
import { resolveSourceRoots } from '../source-roots.js';

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
