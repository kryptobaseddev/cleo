/**
 * End-to-end tests for `cleo docs find --similar <slug>` (T10163).
 *
 * Drives the compiled `cleo` CLI as a subprocess against an isolated tmp
 * `CLEO_PROJECT_ROOT` and verifies the AC contract from T10163:
 *
 *   (a) seeds 3 same-kind docs + 1 different-kind doc, then runs
 *       `cleo docs find --similar <seed> --limit 2` and asserts the
 *       envelope returns up to 2 ranked hits with the
 *       `{ slug, kind, score, summary, lifecycle_status }` shape, sorted
 *       descending by `score`, and that the seed itself is NEVER returned.
 *   (b) same fixture, runs without `--all-kinds` and asserts ONLY same-kind
 *       hits appear; then runs again with `--all-kinds` and asserts the
 *       different-kind doc becomes eligible.
 *   (c) `--threshold 0.99` drops every hit below the threshold (here the
 *       only matches will be near-duplicates of the seed; bumping the
 *       threshold to a near-impossible value collapses the hit list to 0
 *       even though candidates exist).
 *   (d) `--similar <missing>` returns `E_DOCS_SLUG_NOT_FOUND`.
 *
 * @task T10163 (Epic T10157 · Saga T9855 · E12.C6)
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PKG_ROOT = resolve(__dirname, '..', '..', '..', '..');
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function runCli(args: readonly string[], projectRoot: string): CliResult {
  const env = {
    ...process.env,
    CLEO_PROJECT_ROOT: projectRoot,
    CLEO_ROOT: projectRoot,
    CLEO_DIR: join(projectRoot, '.cleo'),
    CLEO_OUTPUT_FORMAT: 'json',
  };
  const result = spawnSync('node', [CLI_DIST, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 90_000,
    cwd: projectRoot,
    env,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

interface LafsEnvelope<TData = unknown> {
  readonly success: boolean;
  readonly data?: TData;
  readonly error?: {
    readonly code?: number | string;
    readonly codeName?: string;
    readonly message?: string;
  };
}

function parseEnvelope<T = unknown>(stdout: string): LafsEnvelope<T> {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try {
      return JSON.parse(line) as LafsEnvelope<T>;
    } catch {
      /* keep scanning */
    }
  }
  throw new Error(`parseEnvelope: no JSON envelope on stdout. Got:\n${stdout.slice(0, 2000)}`);
}

interface FindHit {
  id: string;
  slug: string;
  kind: string | null;
  score: number;
  summary: string | null;
  lifecycle_status: string;
}

interface FindResultShape {
  seedSlug: string;
  seedKind: string | null;
  totalCandidates: number;
  hits: FindHit[];
}

/**
 * Seed N markdown docs into the temp project so the find-similar fixture
 * has a deterministic corpus. `kind` maps to `--type` and content is large
 * enough that the n-gram fingerprint produces a meaningful score (> 0.5).
 */
async function seedDoc(
  projectRoot: string,
  ownerId: string,
  slug: string,
  kind: string,
  body: string,
): Promise<void> {
  const file = join(projectRoot, `${slug}.md`);
  await writeFile(file, body, 'utf-8');
  const res = runCli(['docs', 'add', ownerId, file, '--slug', slug, '--type', kind], projectRoot);
  if (res.status !== 0) {
    throw new Error(
      `seedDoc(${slug}) failed: status=${res.status} stdout=${res.stdout} stderr=${res.stderr}`,
    );
  }
}

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'cleo-T10163-'));
  await mkdir(join(projectRoot, '.cleo'), { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {
    /* never fail teardown */
  });
});

// Each test spawns 1-5 subprocess CLI invocations; each `docs add` can take
// 10-30s when the AttachmentStore initialises the project DB from a clean
// tmpdir, so allot generous per-test headroom.
const TEST_TIMEOUT_MS = 300_000;

describe.skipIf(!CLI_DIST_AVAILABLE)('T10163 — cleo docs find --similar <slug>', () => {
  it(
    '(a) ranks same-kind docs in descending score order, excludes the seed, honours --limit',
    async () => {
      // Seed: an ADR-like note about "release pipeline planning".
      await seedDoc(
        projectRoot,
        'T-T10163-a-seed',
        't10163-seed-release-pipeline',
        'note',
        [
          '# Release pipeline planning',
          '',
          'This document describes the release pipeline planning process,',
          'including the four-verb model (plan, open, reconcile, rollback),',
          'changeset aggregation, and CHANGELOG composition.',
          'Release planning, release pipeline, release planning pipeline.',
        ].join('\n'),
      );
      // Near-duplicate (should rank #1).
      await seedDoc(
        projectRoot,
        'T-T10163-a-near',
        't10163-near-release-pipeline',
        'note',
        [
          '# Release pipeline planning v2',
          '',
          'The release pipeline planning process uses the four-verb model',
          '(plan, open, reconcile, rollback), changeset aggregation, and',
          'CHANGELOG composition. Release planning, release pipeline.',
        ].join('\n'),
      );
      // Loosely related (should rank lower).
      await seedDoc(
        projectRoot,
        'T-T10163-a-loose',
        't10163-loose-changeset',
        'note',
        [
          '# Changeset DSL primer',
          '',
          'Changeset entries are written as YAML with a task field and a',
          'summary. Aggregation feeds the CHANGELOG composer at release time.',
        ].join('\n'),
      );
      // Kind filter is exercised end-to-end by test (b); skip the cross-kind
      // doc here to keep the per-test wall-clock under the 5 min budget. The
      // 3-doc fixture is enough to assert ranking, slug exclusion, and shape.

      const res = runCli(
        [
          'docs',
          'find',
          '--similar',
          't10163-seed-release-pipeline',
          '--limit',
          '2',
          '--threshold',
          '0',
        ],
        projectRoot,
      );
      expect(res.status, `find failed; stdout=${res.stdout} stderr=${res.stderr}`).toBe(0);

      const env = parseEnvelope<FindResultShape>(res.stdout);
      expect(env.success).toBe(true);
      expect(env.data?.seedSlug).toBe('t10163-seed-release-pipeline');
      expect(env.data?.seedKind).toBe('note');

      const hits = env.data?.hits ?? [];
      expect(hits.length).toBeLessThanOrEqual(2);
      expect(hits.length).toBeGreaterThan(0);

      // Seed must never appear in its own results.
      expect(hits.find((h) => h.slug === 't10163-seed-release-pipeline')).toBeUndefined();

      // Each hit carries the AC-mandated shape.
      for (const h of hits) {
        expect(typeof h.slug).toBe('string');
        // Default filter keeps same-kind only; the seed is `note`.
        expect(h.kind).toBe('note');
        expect(typeof h.score).toBe('number');
        expect(h.score).toBeGreaterThanOrEqual(0);
        expect(h.score).toBeLessThanOrEqual(1);
        expect(typeof h.lifecycle_status).toBe('string');
        // `summary` may be null — only assert it is the right type.
        expect(h.summary === null || typeof h.summary === 'string').toBe(true);
      }

      // Sorted descending by score.
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '(b) default same-kind filter excludes different DocKinds; --all-kinds includes them',
    async () => {
      await seedDoc(
        projectRoot,
        'T-T10163-b-seed',
        't10163b-seed-architecture',
        'note',
        'Architecture overview for the dispatch layer. Architecture, architecture, architecture, dispatch routing.',
      );
      await seedDoc(
        projectRoot,
        'T-T10163-b-same',
        't10163b-same-architecture',
        'note',
        'Architecture notes for the dispatch routing layer. Architecture, dispatch, architecture.',
      );
      await seedDoc(
        projectRoot,
        'T-T10163-b-other',
        't10163b-other-architecture',
        'spec',
        'Architecture specification covering dispatch routing. Architecture, dispatch, architecture spec.',
      );

      // Default — same-kind only.
      const defaultRes = runCli(
        ['docs', 'find', '--similar', 't10163b-seed-architecture', '--threshold', '0'],
        projectRoot,
      );
      expect(defaultRes.status, `default find failed; stdout=${defaultRes.stdout}`).toBe(0);
      const defaultHits = parseEnvelope<FindResultShape>(defaultRes.stdout).data?.hits ?? [];
      for (const h of defaultHits) {
        expect(h.kind).toBe('note');
      }
      expect(defaultHits.find((h) => h.slug === 't10163b-other-architecture')).toBeUndefined();

      // --all-kinds — every DocKind eligible.
      const allRes = runCli(
        [
          'docs',
          'find',
          '--similar',
          't10163b-seed-architecture',
          '--all-kinds',
          '--threshold',
          '0',
        ],
        projectRoot,
      );
      expect(allRes.status, `--all-kinds find failed; stdout=${allRes.stdout}`).toBe(0);
      const allHits = parseEnvelope<FindResultShape>(allRes.stdout).data?.hits ?? [];
      const kinds = new Set(allHits.map((h) => h.kind));
      // The fixture is deterministic enough that the spec doc must be a candidate.
      expect(kinds.has('spec')).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '(c) --threshold above every achievable score collapses hits to []',
    async () => {
      await seedDoc(
        projectRoot,
        'T-T10163-c-seed',
        't10163c-seed',
        'note',
        'Seed body — distinctive enough.',
      );
      await seedDoc(
        projectRoot,
        'T-T10163-c-other',
        't10163c-other',
        'note',
        'Wholly unrelated content about kitchens, recipes, and herbs.',
      );

      const res = runCli(
        ['docs', 'find', '--similar', 't10163c-seed', '--threshold', '0.999'],
        projectRoot,
      );
      expect(res.status, `find failed; stdout=${res.stdout}`).toBe(0);
      const env = parseEnvelope<FindResultShape>(res.stdout);
      expect(env.success).toBe(true);
      expect(env.data?.hits ?? []).toHaveLength(0);
      // totalCandidates must still reflect that one non-seed doc existed.
      expect(env.data?.totalCandidates).toBeGreaterThanOrEqual(1);
    },
    TEST_TIMEOUT_MS,
  );

  it('(d) --similar against an unknown slug returns E_DOCS_SLUG_NOT_FOUND', async () => {
    const res = runCli(['docs', 'find', '--similar', 'no-such-slug'], projectRoot);
    expect(res.status).not.toBe(0);
    const env = parseEnvelope(res.stdout);
    expect(env.success).toBe(false);
    const symbolic = env.error?.codeName ?? String(env.error?.code ?? '');
    expect(symbolic).toBe('E_DOCS_SLUG_NOT_FOUND');
  });

  it('(e) --similar with missing value returns E_VALIDATION', async () => {
    const res = runCli(['docs', 'find'], projectRoot);
    expect(res.status).not.toBe(0);
    const env = parseEnvelope(res.stdout);
    expect(env.success).toBe(false);
    const symbolic = env.error?.codeName ?? String(env.error?.code ?? '');
    expect(symbolic).toBe('E_VALIDATION');
  });
});
