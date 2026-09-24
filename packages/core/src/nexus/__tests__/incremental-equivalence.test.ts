/**
 * Incremental indexing must publish EXACTLY what a full rebuild publishes (T12315).
 *
 * Every scenario edits a fixture repository, runs the default (incremental)
 * analysis, snapshots the published generation, then runs a full rebuild of the
 * same bytes and requires the two snapshots to be identical — node sets and
 * relation sets compared by stable keys, never row ids or timestamps. The
 * scenarios target the ways a patch-style incremental index goes wrong: a
 * changed body, a renamed export still imported elsewhere, a deleted file, an
 * added file and a changed barrel re-export.
 */
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type NexusAnalysisResult, runNexusAnalysis } from '../analyze-orchestrator.js';

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
let repo: string;

/** The published tables, including the parse cache added by T12315. */
const SCHEMA = `
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
`;

/** A small TypeScript project exercising imports, a barrel, heritage, calls and accesses. */
const FIXTURE: Record<string, string> = {
  'src/util.ts': [
    'export function helper(x: number): number { return x + 1; }',
    'export function unused(): string { return "u"; }',
    'export const config = { depth: 3 };',
  ].join('\n'),
  'src/shapes.ts': [
    'export interface Shape { area(): number }',
    'export class Base { size = 1; area(): number { return this.size; } }',
  ].join('\n'),
  'src/index.ts': ["export { helper, config } from './util';", "export * from './shapes';"].join(
    '\n',
  ),
  'src/circle.ts': [
    "import { Base, type Shape } from './index';",
    "import { helper } from './index';",
    'export class Circle extends Base implements Shape {',
    '  area(): number { return helper(this.size); }',
    '}',
  ].join('\n'),
  'src/app.ts': [
    "import { helper, config } from './index';",
    "import { Circle } from './circle';",
    'export function main(): number {',
    '  const c = new Circle();',
    '  return c.area() + helper(config.depth);',
    '}',
    'export function start(): number { return main(); }',
    '// Anonymous scopes embed the publication generation in their identity.',
    'export const handlers = [1, 2].map((n) => helper(n));',
  ].join('\n'),
  'README.md': '# fixture\n',
};

beforeEach(async () => {
  native = new DatabaseSync(':memory:');
  native.exec(SCHEMA);
  repo = await mkdtemp(join(tmpdir(), 'nexus-incremental-equivalence-'));
  await mkdir(join(repo, '.cleo'));
  await writeFile(
    join(repo, '.cleo/project-info.json'),
    JSON.stringify({ projectId: 'equivalence-fixture', projectHash: 'equivalence-hash' }),
  );
  for (const [path, content] of Object.entries(FIXTURE)) await put(path, content);
});

afterEach(async () => {
  native.close();
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true });
});

/** Write one fixture file, creating parent directories. */
async function put(path: string, content: string): Promise<void> {
  await mkdir(join(repo, path, '..'), { recursive: true });
  await writeFile(join(repo, path), content);
}

type Row = Record<string, unknown>;

/** Replace every occurrence of the publication generation with a stable token. */
function normalize(value: unknown, generation: string): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.split(generation).join('<generation>');
}

/**
 * Snapshot the published generation by stable keys.
 *
 * Row ids and timestamps differ between any two publications; the generation
 * token embedded in anonymous identities is normalized; everything else —
 * every node column, every relation's endpoints, type, confidence, reason and
 * step, the per-file assessment and retained references — must match.
 */
function snapshot(): {
  nodes: string[];
  relations: string[];
  files: string[];
  references: string[];
  cache: string[];
} {
  const generation = String(
    (native.prepare("SELECT value FROM _nexus_meta WHERE key = 'graph_generation'").get() as Row)
      .value,
  );
  const assessment = JSON.parse(
    String(
      (native.prepare("SELECT value FROM _nexus_meta WHERE key = 'graph_assessment'").get() as Row)
        .value,
    ),
  ) as { files: Row[]; references?: Row[] };
  const nodes = (native.prepare('SELECT * FROM nexus_nodes').all() as Row[])
    .map(({ indexed_at: _indexedAt, ...row }) => normalize(row, generation))
    .sort();
  const relations = (native.prepare('SELECT * FROM nexus_relations').all() as Row[])
    .map(({ id: _id, indexed_at: _indexedAt, ...row }) => normalize(row, generation))
    .sort();
  const files = assessment.files.map((file) => normalize(file, generation)).sort();
  // T12348: the reference list is stored beside the summary; read it where it
  // lives so this comparison keeps covering it.
  const storedReferences = native
    .prepare("SELECT value FROM _nexus_meta WHERE key = 'graph_assessment_references'")
    .get() as Row | undefined;
  const referenceList =
    assessment.references ??
    (storedReferences ? (JSON.parse(String(storedReferences.value)) as Row[]) : []);
  const references = referenceList.map((reference) => normalize(reference, generation)).sort();
  const cache = (native.prepare('SELECT path, content_hash FROM _nexus_parse_cache').all() as Row[])
    .map((row) => `${String(row.path)}@${String(row.content_hash)}`)
    .sort();
  return { nodes, relations, files, references, cache };
}

/** Run the default analysis, then a full rebuild, and require identical publications. */
async function expectIncrementalEqualsFull(): Promise<NexusAnalysisResult> {
  const incremental = await runNexusAnalysis({ repoPath: repo });
  const afterIncremental = snapshot();
  const full = await runNexusAnalysis({ repoPath: repo, full: true });
  expect(full.summary.mode).toBe('full');
  expect(full.summary.reason).toBe('full rebuild requested (--full)');
  const afterFull = snapshot();
  expect(afterIncremental.nodes).toEqual(afterFull.nodes);
  expect(afterIncremental.relations).toEqual(afterFull.relations);
  expect(afterIncremental.files).toEqual(afterFull.files);
  expect(afterIncremental.references).toEqual(afterFull.references);
  // Non-vacuous: the fixture retains references, so the comparison compared something.
  expect(afterFull.references.length).toBeGreaterThan(0);
  expect(afterIncremental.cache).toEqual(afterFull.cache);
  return incremental;
}

/** Relations of one type as `source -> target`, for asserting the edit was observed. */
function edges(type: string): string[] {
  return (
    native
      .prepare('SELECT source_id, target_id FROM nexus_relations WHERE type = ?')
      .all(type) as Row[]
  )
    .map((row) => `${String(row.source_id)} -> ${String(row.target_id)}`)
    .sort();
}

describe('incremental analysis equals a full rebuild (T12315)', () => {
  it('first analysis is full and says why; an unchanged tree publishes nothing', async () => {
    const first = await runNexusAnalysis({ repoPath: repo });
    expect(first.summary.mode).toBe('full');
    expect(first.summary.reason).toBe('no previous generation to reuse');
    const generation = first.assessment?.generation;
    const again = await runNexusAnalysis({ repoPath: repo });
    expect(again.summary.mode).toBe('unchanged');
    expect(again.assessment?.generation).toBe(generation);
  });

  it('a changed function body re-parses one file and matches a full rebuild', async () => {
    await runNexusAnalysis({ repoPath: repo });
    await put(
      'src/util.ts',
      FIXTURE['src/util.ts']!.replace('return x + 1;', 'return unused().length + x;'),
    );
    const result = await expectIncrementalEqualsFull();
    expect(result.summary).toMatchObject({
      mode: 'incremental',
      changedFiles: 1,
      addedFiles: 0,
      deletedFiles: 0,
      parsedFiles: 1,
      reusedFiles: 4,
      resolvedFiles: 5,
    });
    expect(edges('calls')).toContain('src/util.ts::helper -> src/util.ts::unused');
  });

  it('renaming an export another file imports re-resolves the unchanged importer', async () => {
    await runNexusAnalysis({ repoPath: repo });
    expect(edges('calls')).toContain('src/app.ts::main -> src/util.ts::helper');
    await put('src/util.ts', FIXTURE['src/util.ts']!.replace('function helper', 'function assist'));
    const result = await expectIncrementalEqualsFull();
    expect(result.summary).toMatchObject({ mode: 'incremental', parsedFiles: 1 });
    // app.ts was NOT re-parsed, yet its call to the vanished export is gone.
    expect(edges('calls')).not.toContain('src/app.ts::main -> src/util.ts::helper');
  });

  it('deleting a file removes its nodes and every edge into them', async () => {
    await runNexusAnalysis({ repoPath: repo });
    await unlink(join(repo, 'src/circle.ts'));
    const result = await expectIncrementalEqualsFull();
    expect(result.summary).toMatchObject({ mode: 'incremental', deletedFiles: 1, parsedFiles: 0 });
    expect(
      (
        native
          .prepare("SELECT COUNT(*) AS n FROM nexus_nodes WHERE file_path = 'src/circle.ts'")
          .get() as Row
      ).n,
    ).toBe(0);
  });

  it('adding a file that calls existing code links it to unchanged targets', async () => {
    await runNexusAnalysis({ repoPath: repo });
    await put(
      'src/extra.ts',
      "import { start } from './app';\nexport function extra(): number { return start(); }\n",
    );
    const result = await expectIncrementalEqualsFull();
    expect(result.summary).toMatchObject({ mode: 'incremental', addedFiles: 1, parsedFiles: 1 });
    expect(edges('calls')).toContain('src/extra.ts::extra -> src/app.ts::start');
  });

  it('changing a barrel re-export re-routes resolution through the new barrel', async () => {
    await runNexusAnalysis({ repoPath: repo });
    await put('src/other.ts', 'export function helper(x: number): number { return x * 2; }\n');
    await put(
      'src/index.ts',
      "export { config } from './util';\nexport { helper } from './other';\nexport * from './shapes';\n",
    );
    const result = await expectIncrementalEqualsFull();
    expect(result.summary).toMatchObject({ mode: 'incremental', addedFiles: 1, changedFiles: 1 });
    expect(edges('calls')).toContain('src/app.ts::main -> src/other.ts::helper');
    expect(edges('calls')).not.toContain('src/app.ts::main -> src/util.ts::helper');
  });

  it('falls back to a full rebuild, and says why, when most files changed', async () => {
    await runNexusAnalysis({ repoPath: repo });
    for (const path of ['src/util.ts', 'src/shapes.ts', 'src/app.ts'])
      await put(path, `${FIXTURE[path]}\n// edited\n`);
    const result = await runNexusAnalysis({ repoPath: repo });
    expect(result.summary.mode).toBe('full');
    expect(result.summary.reason).toMatch(
      /3 of 6 files differ .*above the 30% incremental threshold/,
    );
  });

  it('rebuilds an unchanged tree whose graph came from a different extractor build', async () => {
    await runNexusAnalysis({ repoPath: repo });
    native.exec(
      "UPDATE _nexus_meta SET value = 'older-build' WHERE key = 'graph_extractor_fingerprint'",
    );
    const result = await runNexusAnalysis({ repoPath: repo });
    expect(result.summary.mode).toBe('full');
    expect(result.summary.reason).toMatch(/produced by a different extractor build/);
    expect(result.summary.parsedFiles).toBe(5);
    expect((await runNexusAnalysis({ repoPath: repo })).summary.mode).toBe('unchanged');
  });

  it('falls back to a full rebuild when the parse cache is missing', async () => {
    await runNexusAnalysis({ repoPath: repo });
    native.exec('DELETE FROM _nexus_parse_cache');
    await put('src/app.ts', `${FIXTURE['src/app.ts']}\n// edited\n`);
    const result = await runNexusAnalysis({ repoPath: repo });
    expect(result.summary.mode).toBe('full');
    expect(result.summary.reason).toBe('no parse cache was committed with the previous generation');
  });

  it('re-parses a file whose cache entry came from a different extractor build', async () => {
    await runNexusAnalysis({ repoPath: repo });
    native.exec(
      "UPDATE _nexus_parse_cache SET fingerprint = 'older-build' WHERE path = 'src/app.ts'",
    );
    await put('src/util.ts', `${FIXTURE['src/util.ts']}\n// edited\n`);
    const result = await expectIncrementalEqualsFull();
    expect(result.summary).toMatchObject({ mode: 'incremental', parsedFiles: 2, reusedFiles: 3 });
  });

  it('a failed publication leaves the previous graph and parse cache untouched', async () => {
    await runNexusAnalysis({ repoPath: repo });
    const before = snapshot();
    await put('src/app.ts', `${FIXTURE['src/app.ts']}\n// edited\n`);
    native.exec(`CREATE TRIGGER reject_cache BEFORE INSERT ON _nexus_parse_cache
      BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END;`);
    const failure = await runNexusAnalysis({ repoPath: repo }).then(
      () => null,
      (error: Error) => error,
    );
    // The driver wraps the trigger's abort as the failed query's cause.
    expect(String(failure?.cause ?? failure)).toMatch(/injected publication failure/);
    expect(snapshot()).toEqual(before);
  });
});
