/**
 * A moved project keeps a usable code graph (T12474).
 *
 * `_nexus_meta` used to persist the absolute roots of the machine that last
 * analyzed the project, so after a move `cleo nexus status` walked the old path
 * (`scandir ENOENT /mnt/projects/cleocode`) and the next analysis rebuilt fully.
 * These tests analyze a fixture in one temp root, move it to another, and check
 * freshness, provenance and incremental reuse from the new location.
 */
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNexusAnalysis } from '../analyze-orchestrator.js';
import { assessNexusIndexFreshness } from '../freshness.js';
import { readFileManifest } from '../graph-manifest.js';
import { readKnowledgeIndexAssessment } from '../knowledge.js';

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
let parent: string;
let before: string;
let after: string;

beforeEach(async () => {
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
  `);
  // Canonical (realpath) roots: on macOS tmpdir() is a /var -> /private/var symlink.
  parent = await realpath(await mkdtemp(join(tmpdir(), 'nexus-relocate-')));
  before = join(parent, 'fedora', 'cleocode');
  after = join(parent, 'mac', 'projects', 'cleocode');
  await mkdir(join(before, '.cleo'), { recursive: true });
  await mkdir(join(after, '..'), { recursive: true });
  await writeFile(
    join(before, '.cleo/project-info.json'),
    JSON.stringify({ projectId: 'relocate-fixture', projectHash: 'relocate-hash' }),
  );
  await put('src/a.ts', 'export function alpha(): number { return 1; }\n');
  await put('src/b.ts', "import { alpha } from './a';\nexport const beta = () => alpha();\n");
  for (const name of ['c', 'd', 'e']) await put(`src/${name}.ts`, `export const ${name} = 1;\n`);
});

afterEach(async () => {
  native.close();
  vi.restoreAllMocks();
  await rm(parent, { recursive: true, force: true });
});

/** Write one fixture file under the original root. */
async function put(path: string, content: string): Promise<void> {
  await mkdir(join(before, path, '..'), { recursive: true });
  await writeFile(join(before, path), content);
}

/** Raw stored `_nexus_meta` value. */
function meta(key: string): string {
  const row = native.prepare('SELECT value FROM _nexus_meta WHERE key = ?').get(key);
  if (typeof row?.value !== 'string') throw new Error(`missing ${key}`);
  return row.value;
}

/** Move the project to its new location. */
async function move(): Promise<void> {
  await rename(before, after);
}

describe('relocated project graph (T12474)', () => {
  it('persists no absolute root in the manifest or the assessment', async () => {
    await runNexusAnalysis({ repoPath: before });
    for (const key of ['graph_file_manifest', 'graph_assessment']) {
      expect(meta(key)).not.toContain(parent);
      expect(meta(key)).not.toContain(tmpdir());
    }
    expect(JSON.parse(meta('graph_file_manifest')).sourceRoot).toBe('.');
    const stored = JSON.parse(meta('graph_assessment'));
    expect(stored.sourceRoot).toBe('.');
    expect(stored.sourceRoots).toMatchObject({ projectRoot: '.', sourceRoot: '.' });
    expect(stored.sourceRoots.roots[0]).toMatchObject({ requestedPath: '.', canonicalPath: '.' });
  });

  it('reports freshness from the new location without walking the old path', async () => {
    await runNexusAnalysis({ repoPath: before });
    await move();
    const freshness = await assessNexusIndexFreshness(after);
    expect(freshness.reason ?? '').not.toMatch(/ENOENT/);
    expect(freshness).toMatchObject({ indexed: true, status: 'fresh', staleFileCount: 0 });
    expect(readFileManifest(drizzle({ client: native }), after)?.sourceRoot).toBe(after);
    const assessment = await readKnowledgeIndexAssessment(after);
    expect(assessment?.sourceRoot).toBe(after);
    expect(assessment?.sourceRoots?.projectRoot).toBe(after);
  });

  it('keeps the ownership fingerprint across a move, so analysis stays incremental', async () => {
    await runNexusAnalysis({ repoPath: before });
    await move();
    const result = await runNexusAnalysis({ repoPath: after });
    expect(result.summary.mode).not.toBe('full');
    expect(result.summary.reason).not.toMatch(/ownership/);
  });

  it('rebases a legacy absolute manifest and assessment onto the live root', async () => {
    await runNexusAnalysis({ repoPath: before });
    // Rewrite both records the way pre-T12474 builds stored them: absolute paths.
    const legacyAssessment = await readKnowledgeIndexAssessment(before);
    const legacyManifest = { ...JSON.parse(meta('graph_file_manifest')), sourceRoot: before };
    const write = native.prepare('UPDATE _nexus_meta SET value = ? WHERE key = ?');
    write.run(JSON.stringify(legacyAssessment), 'graph_assessment');
    write.run(JSON.stringify(legacyManifest), 'graph_file_manifest');
    expect(meta('graph_file_manifest')).toContain(before);

    await move();
    const freshness = await assessNexusIndexFreshness(after);
    expect(freshness.reason ?? '').not.toMatch(/ENOENT/);
    expect(freshness).toMatchObject({ status: 'fresh', staleFileCount: 0 });
    const assessment = await readKnowledgeIndexAssessment(after);
    expect(assessment?.sourceRoots?.projectRoot).toBe(after);
    expect(assessment?.sourceRoots?.roots[0]?.canonicalPath).toBe(after);

    // The next analysis reuses the graph and rewrites both records portably.
    const result = await runNexusAnalysis({ repoPath: after });
    expect(result.summary.mode).not.toBe('full');
    expect(meta('graph_file_manifest')).not.toContain(parent);
    expect(meta('graph_assessment')).not.toContain(parent);
  });

  it('reports an unreachable source root as unknown instead of throwing', async () => {
    await runNexusAnalysis({ repoPath: before });
    const legacyManifest = {
      ...JSON.parse(meta('graph_file_manifest')),
      sourceRoot: join(parent, 'elsewhere', 'gone'),
    };
    native
      .prepare('UPDATE _nexus_meta SET value = ? WHERE key = ?')
      .run(JSON.stringify(legacyManifest), 'graph_file_manifest');
    const freshness = await assessNexusIndexFreshness(before);
    expect(freshness).toMatchObject({ indexed: true, status: 'unknown', staleFileCount: -1 });
    expect(freshness.reason).toMatch(/could not be walked/);
  });
});
