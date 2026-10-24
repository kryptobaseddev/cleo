/**
 * Index freshness disclosure and bounded inline refresh (T12316).
 */
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GraphIndexFreshness } from '@cleocode/contracts';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainWarnings } from '../../output.js';
import { runNexusAnalysis } from '../analyze-orchestrator.js';
import {
  assessNexusFreshnessForQuery,
  assessNexusIndexFreshness,
  discloseNexusFreshness,
  ensureNexusIndexFresh,
  judgeSymbolFiles,
  querySymbolFiles,
  runRefreshInChild,
  runRefreshInProcess,
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

// The real owned-process port: the mock above only keeps analysis parsing in-process.
const { createParserExecutionPort } = await vi.importActual<
  typeof import('../../resources/spawn-wrapper.js')
>('../../resources/spawn-wrapper.js');
const port = createParserExecutionPort();

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
    // T14014: re-parse only the stale files; the whole graph is re-resolved.
    expect(freshness.refreshEstimate).toMatch(
      /^~\d+s \(re-parses ~3 file\(s\), re-resolves the whole graph\)$/,
    );
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
    const { freshness } = await ensureNexusIndexFresh(repo, ON, runRefreshInProcess);
    expect(freshness.status).toBe('fresh');
    expect(freshness.autoRefresh).toMatchObject({ refreshed: true, staleFiles: 1 });
    expect(freshness.autoRefresh?.reason).toMatch(/^incremental: 1 changed/);
  });

  it('answers from the stale index, saying why, over budget or when disabled; maxFiles is retired', async () => {
    await runNexusAnalysis({ repoPath: repo });
    await put('src/a.ts', 'export function alpha(): number { return 4; }\n');
    const budget = await ensureNexusIndexFresh(repo, { ...ON, budgetMs: 1 });
    expect(budget.freshness.status).toBe('stale');
    expect(budget.freshness.autoRefresh?.reason).toMatch(/exceeds nexus.autoRefresh.budgetMs = 1/);
    const disabled = await ensureNexusIndexFresh(repo, { ...ON, enabled: false });
    expect(disabled.freshness.autoRefresh?.reason).toMatch(/auto-refresh is disabled/);
    // Neither touched the graph.
    expect((await assessNexusIndexFreshness(repo)).status).toBe('stale');
    // T14014: the file-count cap no longer stops a refresh the budget allows.
    const capped = await ensureNexusIndexFresh(repo, { ...ON, maxFiles: 0 }, runRefreshInProcess);
    expect(capped.freshness.status).toBe('fresh');
    expect(capped.freshness.autoRefresh?.refreshed).toBe(true);
  });

  it('a stale index with no run-cost row answers without running analysis (T13523)', async () => {
    await runNexusAnalysis({ repoPath: repo });
    native.exec("DELETE FROM _nexus_meta WHERE key = 'graph_run_summary'");
    await put('src/a.ts', 'export function alpha(): number { return 5; }\n');
    // The impact/context path, with auto-refresh on by default.
    const { freshness } = await assessNexusFreshnessForQuery(repo);
    expect(freshness.status).toBe('stale');
    expect(freshness.autoRefresh).toMatchObject({ refreshed: false, durationMs: 0 });
    expect(freshness.autoRefresh?.reason).toMatch(/no previous analysis cost recorded/);
    expect((await assessNexusIndexFreshness(repo)).status).toBe('stale');
  });

  it('--no-refresh and CLEO_NEXUS_AUTO_REFRESH=false answer from the stale index and say so (T13523)', async () => {
    await runNexusAnalysis({ repoPath: repo });
    await put('src/a.ts', 'export function alpha(): number { return 6; }\n');
    const flag = await assessNexusFreshnessForQuery(repo, { refresh: false });
    expect(flag.freshness.status).toBe('stale');
    expect(flag.freshness.autoRefresh?.reason).toMatch(/disabled \(--no-refresh\)/);
    try {
      for (const off of ['false', '0', 'no']) {
        vi.stubEnv('CLEO_NEXUS_AUTO_REFRESH', off);
        const env = await assessNexusFreshnessForQuery(repo);
        expect(env.freshness.autoRefresh?.reason).toMatch(/disabled \(CLEO_NEXUS_AUTO_REFRESH\)/);
      }
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await assessNexusIndexFreshness(repo)).status).toBe('stale');
    // Without either, the same index refreshes inline.
    const on = await ensureNexusIndexFresh(repo, undefined, runRefreshInProcess);
    expect(on.freshness.status).toBe('fresh');
  });

  it('refreshes a large stale set, or a rebuild fallback, when the estimate fits the budget (T14014)', async () => {
    await runNexusAnalysis({ repoPath: repo });
    for (const name of ['a', 'd', 'e']) await put(`src/${name}.ts`, `export const ${name}2 = 1;\n`);
    // Half the files are stale: no ratio gate any more; the budget decides.
    const many = await ensureNexusIndexFresh(repo, ON, runRefreshInProcess);
    expect(many.freshness.status).toBe('fresh');
    expect(many.freshness.autoRefresh?.refreshed).toBe(true);
    // No parse cache: the pipeline falls back to a rebuild, bounded by the same budget.
    native.exec('DELETE FROM _nexus_parse_cache');
    await put('src/a.ts', 'export const a3 = 1;\n');
    const fallback = await ensureNexusIndexFresh(repo, ON, runRefreshInProcess);
    expect(fallback.freshness.status).toBe('fresh');
    expect(fallback.freshness.autoRefresh?.reason).toMatch(/^full: /);
    // The same stale set over budget is refused, not started.
    await put('src/d.ts', 'export const d3 = 1;\n');
    const over = await ensureNexusIndexFresh(repo, { ...ON, budgetMs: 1 }, runRefreshInProcess);
    expect(over.freshness.status).toBe('stale');
    expect(over.freshness.autoRefresh).toMatchObject({ refreshed: false, durationMs: 0 });
  });

  it('a refresh that exceeds its heap bound answers from the stale index; the process survives (T13537)', async () => {
    await runNexusAnalysis({ repoPath: repo });
    await put('src/a.ts', 'export const a4 = 1;\n');
    const hog = new URL('./fixtures/heap-hog-child.mjs', import.meta.url);
    const { freshness } = await ensureNexusIndexFresh(repo, ON, (input) =>
      runRefreshInChild(input, { entry: hog, heapMb: 32, port }),
    );
    expect(freshness.status).toBe('stale');
    expect(freshness.autoRefresh?.refreshed).toBe(false);
    expect(freshness.autoRefresh?.reason).toMatch(
      /refresh failed, previous graph retained: the refresh exceeded its 32 MB heap bound; run cleo nexus analyze/,
    );
    expect((await assessNexusIndexFreshness(repo)).status).toBe('stale');
  });

  it('never falls back to an unbounded in-process refresh when no worker is built (T13537)', async () => {
    await runNexusAnalysis({ repoPath: repo });
    await put('src/a.ts', 'export const a5 = 1;\n');
    // Tests run from TypeScript source, where no refresh-worker.js sits beside freshness.
    const { freshness } = await assessNexusFreshnessForQuery(repo);
    expect(freshness.status).toBe('stale');
    expect(freshness.autoRefresh?.reason).toMatch(
      /no bounded refresh process at .*refresh-child\.js/,
    );
  });

  it('resolves on the worker result even when the worker keeps a handle open (T13539)', async () => {
    const started = Date.now();
    const summary = await runRefreshInChild(
      { projectRoot: repo, repoPath: repo, budgetMs: 60_000 },
      { entry: new URL('./fixtures/hold-open-child.mjs', import.meta.url), port },
    );
    expect(summary).toEqual({ mode: 'incremental', reason: 'posted, then held open' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('terminates a synchronously stalled worker after the budget plus a margin (T13539)', async () => {
    await runNexusAnalysis({ repoPath: repo });
    await put('src/a.ts', 'export const a6 = 1;\n');
    const stall = new URL('./fixtures/stall-child.mjs', import.meta.url);
    const started = Date.now();
    const { freshness } = await ensureNexusIndexFresh(repo, { ...ON, budgetMs: 3_000 }, (input) =>
      runRefreshInChild(input, { entry: stall, port }),
    );
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(freshness.status).toBe('stale');
    expect(freshness.autoRefresh?.reason).toMatch(
      /refresh failed, previous graph retained: the refresh did not finish within 4000 ms; run cleo nexus analyze/,
    );
  }, 15_000);

  it('a timer kill mid-publish releases the write lock: a later write does not wait (T13548)', async () => {
    const file = join(repo, 'lock.db');
    const setup = new DatabaseSync(file);
    setup.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (v INTEGER);');
    setup.close();
    const refresh = runRefreshInChild(
      { projectRoot: repo, repoPath: file, budgetMs: 1_000 },
      { entry: new URL('./fixtures/lock-holder-child.mjs', import.meta.url), port },
    );
    const refused = expect(refresh).rejects.toThrow(/did not finish within 2000 ms/);
    // While the child lives it holds the write lock.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const during = new DatabaseSync(file);
    try {
      expect(() => during.exec('INSERT INTO t VALUES (9)')).toThrow(/locked|busy/i);
    } finally {
      during.close();
    }
    await refused;
    const after = new DatabaseSync(file);
    try {
      after.exec('PRAGMA busy_timeout = 10000');
      const started = Date.now();
      after.exec('INSERT INTO t VALUES (2)');
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(after.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 1 });
    } finally {
      after.close();
    }
  }, 20_000);

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

describe('discloseNexusFreshness keeps stdout/stderr clean (T9775 · T12316)', () => {
  const base: GraphIndexFreshness = {
    indexed: true,
    status: 'fresh',
    lastIndexedAt: '2026-09-24T00:00:00.000Z',
    fileCount: 2,
    staleFileCount: 0,
    stalePaths: [],
    refreshCommand: 'cleo nexus analyze',
    refreshEstimate: 'about 1s',
    checkMs: 1,
  };

  /** Disclose; return the envelope warnings drained and whether stderr was written. */
  const disclose = (freshness: GraphIndexFreshness) => {
    drainWarnings();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      discloseNexusFreshness('nexus impact', freshness);
      return { warnings: drainWarnings() ?? [], stderrCalls: stderr.mock.calls.length };
    } finally {
      stderr.mockRestore();
    }
  };

  it('reports an inline refresh as an info warning, not on stderr', () => {
    const { warnings, stderrCalls } = disclose({
      ...base,
      autoRefresh: { refreshed: true, staleFiles: 1, durationMs: 12, reason: '1 stale file' },
    });
    expect(stderrCalls).toBe(0);
    expect(warnings.map((w) => [w.code, w.severity])).toEqual([
      ['W_NEXUS_INDEX_REFRESHED', 'info'],
    ]);
  });

  it('reports a stale index once, as a warning only', () => {
    const { warnings, stderrCalls } = disclose({
      ...base,
      status: 'stale',
      staleFileCount: 1,
      stalePaths: ['a.ts'],
    });
    expect(stderrCalls).toBe(0);
    expect(warnings.map((w) => w.code)).toEqual(['W_NEXUS_INDEX_STALE']);
  });
});
