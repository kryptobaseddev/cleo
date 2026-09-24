/**
 * Index freshness disclosure and bounded inline refresh (T12316).
 */
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNexusAnalysis } from '../analyze-orchestrator.js';
import {
  assessNexusIndexFreshness,
  ensureNexusIndexFresh,
  judgeSymbolFiles,
  querySymbolFiles,
} from '../freshness.js';

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
  repo = await mkdtemp(join(tmpdir(), 'nexus-freshness-'));
  await mkdir(join(repo, '.cleo'));
  await writeFile(
    join(repo, '.cleo/project-info.json'),
    JSON.stringify({ projectId: 'freshness-fixture', projectHash: 'freshness-hash' }),
  );
  await put('src/a.ts', 'export function alpha(): number { return 1; }\n');
  await put('src/b.ts', "import { alpha } from './a';\nexport const beta = () => alpha();\n");
  await put('README.md', '# fixture\n');
  // Enough files that one edit stays under the 30% full-rebuild threshold.
  for (const name of ['d', 'e', 'f'])
    await put(`src/${name}.ts`, `export const ${name} = '${name}';\n`);
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

const ON = { enabled: true, maxFiles: 25, budgetMs: 60_000 };

describe('index freshness (T12316)', () => {
  it('reports unknown — never fresh — before any generation records a manifest', async () => {
    const freshness = await assessNexusIndexFreshness(repo);
    expect(freshness).toMatchObject({ indexed: false, status: 'unknown', staleFileCount: -1 });
    expect(freshness.reason).toMatch(/run cleo nexus analyze once/);
  });

  it('is fresh right after analysis and names the refresh command', async () => {
    await runNexusAnalysis({ repoPath: repo });
    const freshness = await assessNexusIndexFreshness(repo);
    expect(freshness).toMatchObject({
      indexed: true,
      status: 'fresh',
      fileCount: 6,
      staleFileCount: 0,
      refreshCommand: 'cleo nexus analyze',
      refreshEstimate: 'none needed',
    });
    expect(freshness.lastIndexedAt).toEqual(expect.any(String));
  });

  it('counts modified, added and deleted files, and judges the symbol file', async () => {
    await runNexusAnalysis({ repoPath: repo });
    await put('src/a.ts', 'export function alpha(): number { return 2; }\n');
    await put('src/c.ts', 'export const gamma = 3;\n');
    await unlink(join(repo, 'README.md'));
    const freshness = await assessNexusIndexFreshness(repo, { symbolFiles: ['src/a.ts'] });
    expect(freshness.status).toBe('stale');
    expect(freshness.staleFileCount).toBe(3);
    expect(freshness.stalePaths).toEqual(['README.md', 'src/a.ts', 'src/c.ts']);
    expect(freshness).toMatchObject({ symbolFileStale: true, symbolFile: 'src/a.ts' });
    expect(freshness.refreshEstimate).toMatch(/^~\d+s \(full rebuild\)$/);
    const other = await assessNexusIndexFreshness(repo, { symbolFiles: ['src/b.ts'] });
    expect(other).toMatchObject({ symbolFileStale: false, symbolFile: 'src/b.ts' });
  });

  it('treats a touched-but-identical file as fresh by falling back to its hash', async () => {
    await runNexusAnalysis({ repoPath: repo });
    const later = new Date(Date.now() + 60_000);
    await utimes(join(repo, 'src/a.ts'), later, later);
    expect((await assessNexusIndexFreshness(repo)).status).toBe('fresh');
  });

  it('refreshes a few stale files inline and discloses it', async () => {
    await runNexusAnalysis({ repoPath: repo });
    await put('src/a.ts', 'export function alpha(): number { return 3; }\n');
    const { freshness } = await ensureNexusIndexFresh(repo, ON);
    expect(freshness.status).toBe('fresh');
    expect(freshness.autoRefresh).toMatchObject({ refreshed: true, staleFiles: 1 });
    expect(freshness.autoRefresh?.reason).toMatch(/^incremental: 1 changed/);
  });

  it('answers from the stale index, saying why, above the file bound, budget, or when disabled', async () => {
    await runNexusAnalysis({ repoPath: repo });
    await put('src/a.ts', 'export function alpha(): number { return 4; }\n');
    const bounded = await ensureNexusIndexFresh(repo, { ...ON, maxFiles: 0 });
    expect(bounded.freshness.status).toBe('stale');
    expect(bounded.freshness.autoRefresh?.reason).toMatch(/exceed nexus.autoRefresh.maxFiles = 0/);
    const budget = await ensureNexusIndexFresh(repo, { ...ON, budgetMs: 1 });
    expect(budget.freshness.autoRefresh?.reason).toMatch(/exceeds nexus.autoRefresh.budgetMs = 1/);
    const disabled = await ensureNexusIndexFresh(repo, { ...ON, enabled: false });
    expect(disabled.freshness.autoRefresh?.reason).toMatch(/auto-refresh is disabled/);
    // None of them touched the graph.
    expect((await assessNexusIndexFreshness(repo)).status).toBe('stale');
  });

  it('judges symbol files identified only after the query ran', async () => {
    await runNexusAnalysis({ repoPath: repo });
    await put('src/b.ts', 'export const beta = () => 0;\n');
    const assessment = await ensureNexusIndexFresh(repo, { ...ON, enabled: false });
    const files = querySymbolFiles({
      results: [{ nodeId: 'src/b.ts::beta', callers: [{ nodeId: 'src/a.ts::alpha' }] }],
    });
    expect(files).toEqual(['src/b.ts']);
    expect(judgeSymbolFiles(assessment, files)).toMatchObject({
      symbolFileStale: true,
      symbolFile: 'src/b.ts',
    });
    expect(querySymbolFiles({ targetNodeId: 'src/a.ts::alpha' })).toEqual(['src/a.ts']);
    expect(querySymbolFiles({ total: 3 })).toEqual([]);
  });
});
