/**
 * T11045 — Docs Dogfood Regression Fixture Harness
 *
 * Isolated-project harness for replaying 2026-05-25 docs command failures
 * without depending on local temp paths or the host cleocode checkout.
 *
 * Provides:
 *   - `createIsolatedProject()` — creates a temp CLEO project root
 *   - `runCleo()`              — spawns the compiled `cleo` CLI against the isolated root
 *   - `seedDoc() / publishDoc() / getDocStatus() / fetchDoc()` — deterministic docs helpers
 *   - `assertEnvelope()` / `assertErrorEnvelope()` — LAFS envelope validation
 *   - `DocsDogfoodContext`    — typed context for a single test scenario
 *   - Documentation of the six T10516 regression scenarios (see SIX REGRESSION SCENARIOS below)
 *
 * The harness uses `CLEO_PROJECT_ROOT` to pin `getProjectRoot()` so the CLI
 * never walks out of the temp dir. Each `createIsolatedProject()` call returns
 * a cleanup function — call it in `afterEach`.
 *
 * @task    T11045 (T10516-E1: build docs dogfood regression fixture harness)
 * @parent  T10521 (Docs dogfood regression harness from 2026-05-25 failures)
 * @saga    T10516 (SG-DOCS-CLI-SIMPLIFICATION)
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Paths ───────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to `packages/cleo/` root. */
const PKG_ROOT = resolve(__dirname, '..', '..', '..', '..');

/** Path to the compiled CLI entry point. */
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');

/** True when the compiled CLI dist bundle exists and can be spawned. */
export const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

export interface LafsEnvelope<TData = unknown> {
  readonly success: boolean;
  readonly data?: TData;
  readonly error?: {
    readonly code?: number | string;
    readonly codeName?: string;
    readonly message?: string;
  };
  readonly meta?: {
    readonly operation?: string;
    readonly command?: string;
    readonly timestamp?: string;
  };
}

/** Typed context for a single regression test scenario. */
export interface DocsDogfoodContext {
  /** Absolute path to the isolated CLEO project root. */
  readonly projectRoot: string;
  /** Teardown function — call in afterEach. */
  cleanup: () => Promise<void>;
}

/** A regression test scenario definition. */
export interface RegressionScenario {
  /** Stable identifier for the scenario. */
  readonly id: string;
  /** Short name. */
  readonly name: string;
  /** The 2026-05-25 failure class this scenario covers. */
  readonly failureClass: string;
  /** What the test should verify. */
  readonly description: string;
  /** Task reference for the dedicated test file. */
  readonly ownedBy: string;
}

// ─── SIX REGRESSION SCENARIOS (2026-05-25 docs failures) ─────────────────────

/**
 * The six docs failure classes from the 2026-05-25 dogfood session.
 *
 * These are documented here as the shared reference for the T10521 epic
 * test tasks (T11060–T11063). Each scenario gets a dedicated vitest file
 * that imports this harness.
 *
 * | # | Scenario                              | Failure Class            | Task   |
 * |---|---------------------------------------|--------------------------|--------|
 * | 1 | Outside-project file rejection        | Path traversal guard     | T11060 |
 * | 2 | Status enum mismatch                  | Drift state mismatch     | T11060 |
 * | 3 | Update without owner reference         | Slug→owner registration | T11061 |
 * | 4 | Publish selects older blob            | Version selection        | T11061 |
 * | 5 | Slug collision guidance               | Slug uniqueness UX       | T11062 |
 * | 6 | Hidden slug suffix behavior           | Auto-suffix transparency | T11062 |
 */
export const SIX_REGRESSION_SCENARIOS: readonly RegressionScenario[] = [
  {
    id: 'S1',
    name: 'Outside-project file rejection',
    failureClass: 'Path traversal guard',
    description:
      '`cleo docs add` with a file path outside the project root MUST ' +
      'emit a clear error message, not a cryptic ENOENT or silent failure. ' +
      'Also covers `cleo docs publish --to` path-escape guard.',
    ownedBy: 'T11060',
  },
  {
    id: 'S2',
    name: 'Status enum mismatch',
    failureClass: 'Drift state mismatch',
    description:
      '`cleo docs status` must consistently report drift states ' +
      '(`in-sync`, `modified`, `deleted`) and the envelope `allInSync` ' +
      'boolean must match the items array. Covers the case where status ' +
      'reported in-sync while fetch returned a different SHA.',
    ownedBy: 'T11060',
  },
  {
    id: 'S3',
    name: 'Update without owner reference',
    failureClass: 'Slug→owner registration',
    description:
      '`cleo docs update --file` must register an owner-attachment version ' +
      'that `cleo docs publish` can find. The bug: update succeeded but ' +
      'publish couldn\'t locate the blob because the owner ref wasn\'t written.',
    ownedBy: 'T11061',
  },
  {
    id: 'S4',
    name: 'Publish selects older blob',
    failureClass: 'Version selection',
    description:
      'When two attachments share a slug, `cleo docs publish` default ' +
      'must select the latest-by-uploaded_at version, not an older blob. ' +
      'The bug: older blob was selected, causing SHA mismatch on fetch.',
    ownedBy: 'T11061',
  },
  {
    id: 'S5',
    name: 'Slug collision guidance',
    failureClass: 'Slug uniqueness UX',
    description:
      'When a slug is already reserved, the error message must guide ' +
      'the agent toward `docs update` or `docs sync --from` rather than ' +
      'just saying it\'s taken. Covers `E_SLUG_RESERVED` envelope quality.',
    ownedBy: 'T11062',
  },
  {
    id: 'S6',
    name: 'Hidden slug suffix behavior',
    failureClass: 'Auto-suffix transparency',
    description:
      'The `-home-<owner>` auto-suffix applied to slugs must be ' +
      'documented in CLI output/help so agents know their slug was ' +
      'transformed. Also covers the North Star update/publish round-trip.',
    ownedBy: 'T11062',
  },
];

// ─── CLI Subprocess Helper ───────────────────────────────────────────────────

/**
 * Run `node dist/cli/index.js <args>` against an isolated tmp project root.
 *
 * `CLEO_PROJECT_ROOT` pins `getProjectRoot()` so the subprocess never walks
 * out of the tmp dir. Also sets `CLEO_DIR` to prevent inheritance from an
 * outer test runner.
 */
export function runCleo(args: readonly string[], projectRoot: string): CliResult {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLEO_PROJECT_ROOT: projectRoot,
    CLEO_ROOT: projectRoot,
    CLEO_DIR: join(projectRoot, '.cleo'),
    // Force JSON output for predictable envelope parsing.
    CLEO_OUTPUT_FORMAT: 'json',
    // Prevent the subprocess from inheriting the host's CLEO session.
    CLEO_NO_SESSION: '1',
  };
  const result = spawnSync('node', [CLI_DIST, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 30_000,
    cwd: projectRoot,
    env,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

// ─── Envelope Helpers ────────────────────────────────────────────────────────

/**
 * Extract the JSON LAFS envelope from CLI stdout.
 *
 * Scans for the first `{`-prefixed line that successfully parses as JSON.
 */
export function parseEnvelope<T = unknown>(stdout: string): LafsEnvelope<T> {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try {
      return JSON.parse(line) as LafsEnvelope<T>;
    } catch {
      // Not a JSON line — keep scanning.
    }
  }
  throw new Error(
    `parseEnvelope: no JSON envelope on stdout. Got:\n${stdout.slice(0, 2000)}`,
  );
}

/**
 * Assert the LAFS envelope is a success envelope and return its data.
 */
export function assertEnvelope<T = unknown>(stdout: string): T {
  const env = parseEnvelope<T>(stdout);
  if (!env.success) {
    throw new Error(
      `Expected success envelope, got error: ${JSON.stringify(env.error)}`,
    );
  }
  expect(env.success).toBe(true);
  // ADR-039: meta MUST be present on every envelope.
  expect(env.meta).toBeDefined();
  return env.data as T;
}

/**
 * Assert the LAFS envelope is an error envelope with the expected codeName.
 */
export function assertErrorEnvelope(
  stdout: string,
  expectedCodeName?: string,
): LafsEnvelope<unknown> {
  const env = parseEnvelope(stdout);
  expect(env.success).toBe(false);
  expect(env.error).toBeDefined();
  // ADR-039: meta MUST be present on every envelope, success or failure.
  expect(env.meta).toBeDefined();
  if (expectedCodeName) {
    expect(env.error?.codeName).toBe(expectedCodeName);
  }
  return env;
}

// ─── Project Fixture ─────────────────────────────────────────────────────────

/**
 * Create an isolated CLEO project root in a temp directory.
 *
 * Returns a context with `projectRoot` and a `cleanup` function.
 * Call cleanup in `afterEach` to remove the temp dir.
 *
 * The isolated project has:
 *   - A `.cleo/` directory (created)
 *   - `CLEO_PROJECT_ROOT` env var honored by all subsequent `runCleo()` calls
 *   - No dependency on `/mnt/projects/cleocode` or any fixed path
 *
 * @param prefix - Temp dir prefix (default: `'cleo-dogfood-'`)
 */
export async function createIsolatedProject(
  prefix = 'cleo-dogfood-',
): Promise<DocsDogfoodContext> {
  const projectRoot = await mkdtemp(join(tmpdir(), prefix));
  // The blob store stats `<projectRoot>/.cleo/` to derive its data dir,
  // and getProjectRoot() walks back to whatever holds `.cleo/`.
  await mkdir(join(projectRoot, '.cleo'), { recursive: true });

  return {
    projectRoot,
    cleanup: async () => {
      await rm(projectRoot, { recursive: true, force: true }).catch(() => {
        /* never fail teardown */
      });
    },
  };
}

// ─── Docs Operation Helpers ──────────────────────────────────────────────────

/**
 * Seed a doc blob by writing a temp file + invoking `cleo docs add`.
 *
 * Writes the file under `__seeds/<ownerId>/<filename>` inside projectRoot
 * so the path is always inside the project (avoids outside-project rejection).
 *
 * @returns The SHA-256 content address of the seeded blob.
 */
export async function seedDoc(
  ctx: DocsDogfoodContext,
  ownerId: string,
  filename: string,
  content: string,
): Promise<string> {
  const seedDir = join(ctx.projectRoot, '__seeds', ownerId);
  await mkdir(seedDir, { recursive: true });
  const fixturePath = join(seedDir, filename);
  await writeFile(fixturePath, content, 'utf-8');

  const res = runCleo(['docs', 'add', ownerId, fixturePath], ctx.projectRoot);
  if (res.status !== 0) {
    throw new Error(
      `seedDoc failed (exit ${res.status}). stdout=${res.stdout.slice(0, 500)} stderr=${res.stderr.slice(0, 500)}`,
    );
  }

  const data = assertEnvelope<{ sha256: string }>(res.stdout);
  const expectedSha = createHash('sha256').update(content).digest('hex');
  // Cross-check: the envelope sha must match our computed sha.
  if (data.sha256 !== expectedSha) {
    throw new Error(
      `seedDoc SHA mismatch: envelope=${data.sha256} computed=${expectedSha}`,
    );
  }
  return data.sha256;
}

/**
 * Publish a doc via `cleo docs publish`.
 *
 * @returns The publish envelope data (publishedPath, sha256, blobSha256, bytes).
 */
export async function publishDoc(
  ctx: DocsDogfoodContext,
  ownerId: string,
  destPath: string,
): Promise<{ publishedPath: string; sha256: string; blobSha256: string; bytes: number }> {
  const res = runCleo(
    ['docs', 'publish', '--for', ownerId, '--to', destPath],
    ctx.projectRoot,
  );

  const data = assertEnvelope<{
    publishedPath: string;
    sha256: string;
    blobSha256: string;
    bytes: number;
  }>(res.stdout);

  expect(res.status).toBe(0);

  // Verify the file exists on disk.
  const absPath = join(ctx.projectRoot, destPath);
  expect(existsSync(absPath)).toBe(true);

  return data;
}

/**
 * Get docs status via `cleo docs status`.
 *
 * @returns The status envelope data (items, allInSync).
 */
export async function getDocStatus(
  ctx: DocsDogfoodContext,
): Promise<{
  items: Array<{ ownerId: string; drift: string; fileSha?: string | null }>;
  allInSync: boolean;
}> {
  const res = runCleo(['docs', 'status'], ctx.projectRoot);

  // Status can exit 0 (in-sync) or 2 (drift detected).
  // Both are valid envelopes.
  return assertEnvelope<{
    items: Array<{ ownerId: string; drift: string; fileSha?: string | null }>;
    allInSync: boolean;
  }>(res.stdout);
}

/**
 * Fetch a doc via `cleo docs fetch <slug>`.
 *
 * @returns The raw text content of the fetched doc.
 */
export async function fetchDoc(
  ctx: DocsDogfoodContext,
  slugOrSha: string,
): Promise<string> {
  const res = runCleo(['docs', 'fetch', slugOrSha], ctx.projectRoot);

  if (res.status !== 0) {
    // Fetch may fail for valid reasons (doc not found, etc).
    // Caller should check the envelope.
    const env = parseEnvelope(res.stdout);
    if (!env.success) {
      throw new Error(
        `fetchDoc failed: ${env.error?.codeName ?? 'unknown'} — ${env.error?.message ?? ''}`,
      );
    }
  }

  // docs fetch may return raw content or a JSON envelope depending on flags.
  // Try JSON first, fall back to raw text.
  try {
    const env = JSON.parse(res.stdout.trim()) as LafsEnvelope<{ content?: string }>;
    if (env.success && env.data) {
      if (typeof env.data === 'string') return env.data;
      if (env.data.content) return env.data.content;
      return JSON.stringify(env.data);
    }
  } catch {
    // Not JSON — return raw stdout as content.
  }

  return res.stdout.trim();
}

/**
 * Compute the SHA-256 hex digest of a string.
 */
export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute the SHA-256 hex digest of a file on disk.
 */
export async function fileSha256(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}
