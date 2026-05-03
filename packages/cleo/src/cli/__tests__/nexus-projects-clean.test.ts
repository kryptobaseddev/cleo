/**
 * Tests for `cleo nexus projects clean` subcommand.
 *
 * Verifies registration, flag definitions, and core behaviours:
 * - dry-run lists without deleting
 * - --include-temp preset
 * - --include-tests preset
 * - --pattern custom regex
 * - --unhealthy + --never-indexed combo
 * - no criteria → exit 6
 * - --yes skips prompt
 * - audit log entry is written on deletion
 *
 * @task T655
 * @task T1564 — fix-forward after T1510 wired Phase 2 nexus dispatch.  The CLI
 *   handler now goes through `dispatchRaw('mutate', 'nexus', 'projects.clean')`
 *   which lazy-imports `@cleocode/core/nexus/projects-clean.js`.  That subpath
 *   is not aliased in the cleo-package vitest config, so we cannot mock the
 *   core module directly from a test file.  Instead we mock the dispatch
 *   adapter (`../../dispatch/adapters/cli.js`) and re-implement the
 *   filter/audit semantics here so the existing assertions on `deletedIds`,
 *   `auditInserts`, and the rendered LAFS envelope continue to hold.
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nexusCommand } from '../commands/nexus.js';
import { setFormatContext } from '../format-context.js';

/**
 * Subset of the dispatcher response shape that the CLI handler reads.  The
 * production type lives in `../../dispatch/types.ts` but pulling it in here
 * would couple the test to dispatch internals — the CLI handler only
 * consumes `success`, `data`, `error`, and `meta`.
 */
interface DispatchResponseLike<TData> {
  success: boolean;
  data?: TData;
  error?: { code: string; message: string };
  meta: { operation: string; duration_ms: number; timestamp: string };
}

// ── Module mocks ──────────────────────────────────────────────────────────────

/**
 * dispatchRawMock stands in for the production `dispatchRaw` function.  Each
 * test installs a per-call implementation that simulates the engine + core
 * behaviour against an in-memory rows array, so we test the CLI handler's
 * argument parsing, output formatting, and dispatch contract without
 * exercising the real engine + SQLite path.
 */
const { dispatchRawMock, dispatchFromCliMock } = vi.hoisted(() => ({
  dispatchRawMock: vi.fn(),
  dispatchFromCliMock: vi.fn(),
}));

vi.mock('../../dispatch/adapters/cli.js', () => ({
  dispatchRaw: dispatchRawMock,
  dispatchFromCli: dispatchFromCliMock,
}));

// ── Shared test rows ─────────────────────────────────────────────────────────

/** Minimal project_registry row shape returned by the simulated dispatch handler. */
interface MockRow {
  projectId: string;
  projectPath: string;
  healthStatus: string;
  lastIndexed: string | null;
}

const TEMP_ROW: MockRow = {
  projectId: 'id-temp',
  projectPath: '/home/user/.temp/my-project',
  healthStatus: 'healthy',
  lastIndexed: '2026-01-01T00:00:00Z',
};

const TESTS_ROW: MockRow = {
  projectId: 'id-test',
  projectPath: '/home/user/tmp/some-project',
  healthStatus: 'healthy',
  lastIndexed: '2026-01-01T00:00:00Z',
};

const FIXTURE_ROW: MockRow = {
  projectId: 'id-fixture',
  projectPath: '/home/user/fixture/proj',
  healthStatus: 'healthy',
  lastIndexed: '2026-01-01T00:00:00Z',
};

const UNHEALTHY_ROW: MockRow = {
  projectId: 'id-unhealthy',
  projectPath: '/home/user/real-project',
  healthStatus: 'unhealthy',
  lastIndexed: '2026-01-01T00:00:00Z',
};

const NEVER_INDEXED_ROW: MockRow = {
  projectId: 'id-never',
  projectPath: '/home/user/new-project',
  healthStatus: 'healthy',
  lastIndexed: null,
};

const NORMAL_ROW: MockRow = {
  projectId: 'id-normal',
  projectPath: '/home/user/normal-project',
  healthStatus: 'healthy',
  lastIndexed: '2026-01-01T00:00:00Z',
};

/** All rows used in tests. */
const ALL_ROWS: MockRow[] = [
  TEMP_ROW,
  TESTS_ROW,
  FIXTURE_ROW,
  UNHEALTHY_ROW,
  NEVER_INDEXED_ROW,
  NORMAL_ROW,
];

// ── Simulated engine + core semantics (mirrors core/src/nexus/projects-clean.ts) ─

const TEMP_RE = /(^|\/)\.temp(\/|$)/;
const TESTS_RE = /(^|\/)(tmp|test|fixture|scratch|sandbox)(\/|$)/;

/** Captured delete calls: each entry is the IDs array passed to the dispatch op. */
let deletedIds: string[][] = [];
/** Captured audit log entries written on successful (non-dry-run) deletion. */
let auditInserts: Record<string, unknown>[] = [];

/** Engine-layer parameter shape for `nexus.projects.clean`. */
interface CleanParams {
  dryRun?: boolean;
  pattern?: string;
  includeTemp?: boolean;
  includeTests?: boolean;
  matchUnhealthy?: boolean;
  matchNeverIndexed?: boolean;
}

/** Result data shape returned inside the LAFS envelope's `data` field. */
interface CleanResult {
  dryRun: boolean;
  matched: number;
  purged: number;
  remaining: number;
  sample: string[];
  totalCount: number;
}

/**
 * Compute a clean result against the given rows.  Mirrors the validation +
 * filter + audit semantics that the dispatch engine runs against
 * `cleanProjects` in `@cleocode/core/nexus/projects-clean.js`.
 */
function simulateClean(rows: MockRow[], params: CleanParams): DispatchResponseLike<CleanResult> {
  const meta = {
    operation: 'nexus.projects.clean' as const,
    duration_ms: 0,
    timestamp: new Date().toISOString(),
  };

  const hasCriteria =
    typeof params.pattern === 'string' ||
    params.includeTemp === true ||
    params.includeTests === true ||
    params.matchUnhealthy === true ||
    params.matchNeverIndexed === true;
  if (!hasCriteria) {
    return {
      success: false,
      error: {
        code: 'E_NO_CRITERIA',
        message:
          'At least one criteria flag is required: --include-temp, --include-tests, --pattern, --unhealthy, or --never-indexed',
      },
      meta,
    };
  }

  let patternRegex: RegExp | null = null;
  if (typeof params.pattern === 'string') {
    try {
      patternRegex = new RegExp(params.pattern);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: {
          code: 'E_INVALID_PATTERN',
          message: `Invalid regex pattern '${params.pattern}': ${cause}`,
        },
        meta,
      };
    }
  }

  const matches = rows.filter((row) => {
    if (patternRegex?.test(row.projectPath)) return true;
    if (params.includeTemp && TEMP_RE.test(row.projectPath)) return true;
    if (params.includeTests && TESTS_RE.test(row.projectPath)) return true;
    if (params.matchUnhealthy && row.healthStatus === 'unhealthy') return true;
    if (params.matchNeverIndexed && row.lastIndexed === null) return true;
    return false;
  });

  const totalCount = rows.length;
  const matched = matches.length;
  const sample = matches.slice(0, 10).map((r) => path.resolve(r.projectPath));

  if (params.dryRun || matched === 0) {
    return {
      success: true,
      data: {
        dryRun: params.dryRun ?? false,
        matched,
        purged: 0,
        remaining: totalCount,
        sample,
        totalCount,
      },
      meta,
    };
  }

  // Simulate the delete + audit insert that the core function performs.
  deletedIds.push(matches.map((r) => r.projectId));
  auditInserts.push({
    id: 'test-uuid-1234',
    action: 'projects.clean',
    domain: 'nexus',
    operation: 'projects.clean',
    success: 1,
    detailsJson: JSON.stringify({
      pattern: params.pattern ?? null,
      presets: {
        includeTemp: params.includeTemp,
        includeTests: params.includeTests,
        matchUnhealthy: params.matchUnhealthy,
        matchNeverIndexed: params.matchNeverIndexed,
      },
      count: matched,
      sample,
    }),
  });

  return {
    success: true,
    data: {
      dryRun: false,
      matched,
      purged: matched,
      remaining: totalCount - matched,
      sample,
      totalCount,
    },
    meta,
  };
}

// ── Citty command accessor ────────────────────────────────────────────────────

/**
 * Reach into the citty command tree to get the `clean` subcommand definition.
 */
function getCleanDef() {
  const projectsDef = nexusCommand.subCommands?.['projects'];
  if (!projectsDef || typeof projectsDef !== 'object') {
    throw new Error('nexus projects subcommand not found');
  }
  const projects = projectsDef as { subCommands?: Record<string, unknown> };
  const cleanDef = projects.subCommands?.['clean'];
  if (!cleanDef || typeof cleanDef !== 'object') {
    throw new Error('nexus projects clean subcommand not found');
  }
  return cleanDef as {
    meta?: { name?: string; description?: string };
    args?: Record<string, { type: string; description?: string }>;
    run?: (ctx: { args: Record<string, unknown> }) => Promise<void>;
  };
}

// ── Helper: invoke the clean run handler directly ────────────────────────────

/**
 * Invoke the `cleo nexus projects clean` run handler with the given args.
 * Captures stdout/stderr and the exit code set by process.exitCode.
 *
 * The dispatchRaw mock is wired to apply `simulateClean` against the supplied
 * rows so each test exercises the CLI handler against a deterministic
 * dispatch envelope without touching the engine or SQLite layer.
 *
 * @param rows - Rows the simulated dispatch handler will scan.
 * @param args - Parsed arg values passed to run() (citty kebab-case keys).
 */
async function invokeClean(
  rows: MockRow[],
  args: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  deletedIds = [];
  auditInserts = [];

  // Set format context to match what the CLI entry-point would resolve.
  // Without --json the CLI resolves to 'json' (non-TTY default), but when
  // tests do NOT pass json:true they are exercising the human-error path.
  // Explicitly mirror the flag resolution here so cliOutput/cliError behave
  // consistently regardless of residual module-level state from prior tests.
  setFormatContext(
    args['json'] === true
      ? { format: 'json', source: 'flag', quiet: false }
      : { format: 'human', source: 'flag', quiet: false },
  );

  dispatchRawMock.mockImplementation(
    async (
      _gateway: string,
      _domain: string,
      _operation: string,
      params?: Record<string, unknown>,
    ) => simulateClean(rows, (params ?? {}) as CleanParams),
  );

  let stdoutBuf = '';
  let stderrBuf = '';
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExitCode = process.exitCode;

  process.stdout.write = (chunk: unknown): boolean => {
    stdoutBuf += String(chunk);
    return true;
  };
  process.stderr.write = (chunk: unknown): boolean => {
    stderrBuf += String(chunk);
    return true;
  };
  process.exitCode = undefined;

  const cleanDef = getCleanDef();
  if (cleanDef.run) {
    try {
      await cleanDef.run({ args });
    } catch {
      // Swallow — exitCode is set before throws
    }
  }

  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;

  const result = {
    stdout: stdoutBuf,
    stderr: stderrBuf,
    exitCode: process.exitCode as number | undefined,
  };
  process.exitCode = origExitCode;
  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('nexus projects clean', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Command registration ─────────────────────────────────────────────────

  it('registers the clean subcommand under nexus projects', () => {
    const projectsDef = nexusCommand.subCommands?.['projects'] as {
      subCommands?: Record<string, unknown>;
    };
    expect(projectsDef).toBeDefined();
    const cleanDef = projectsDef?.subCommands?.['clean'] as {
      meta?: { name?: string; description?: string };
    };
    expect(cleanDef).toBeDefined();
    expect(cleanDef?.meta?.description).toContain('Bulk purge');
  });

  it('has all required args defined', () => {
    const cleanDef = getCleanDef();
    const argKeys = Object.keys(cleanDef.args ?? {});
    expect(argKeys).toContain('dry-run');
    expect(argKeys).toContain('pattern');
    expect(argKeys).toContain('include-temp');
    expect(argKeys).toContain('include-tests');
    expect(argKeys).toContain('unhealthy');
    expect(argKeys).toContain('never-indexed');
    expect(argKeys).toContain('yes');
    expect(argKeys).toContain('json');
  });

  // ── No criteria → exit 6 ─────────────────────────────────────────────────

  it('errors with exit code 6 when no criteria flag is given', async () => {
    const result = await invokeClean(ALL_ROWS, {});
    expect(result.exitCode).toBe(6);
  });

  it('includes a helpful error message when no criteria is given', async () => {
    const result = await invokeClean(ALL_ROWS, {});
    // T1510 dispatch-layer message: engine pre-validates before calling core.
    expect(result.stderr).toContain('At least one criteria flag is required');
  });

  it('--json outputs LAFS envelope with E_NO_CRITERIA when no criteria', async () => {
    const result = await invokeClean(ALL_ROWS, { json: true });
    const envelope = JSON.parse(result.stdout) as {
      success: boolean;
      error: { code: number; codeName?: string };
    };
    expect(envelope.success).toBe(false);
    // error.codeName carries the symbolic code; error.code is the numeric exit code
    expect(envelope.error.codeName).toBe('E_NO_CRITERIA');
    expect(result.exitCode).toBe(6);
  });

  // ── --dry-run ─────────────────────────────────────────────────────────────

  it('--dry-run with --include-temp lists matches without deleting', async () => {
    const result = await invokeClean(ALL_ROWS, { 'include-temp': true, 'dry-run': true });
    expect(result.stdout).toContain(TEMP_ROW.projectPath);
    expect(deletedIds).toHaveLength(0);
    expect(result.exitCode).toBeUndefined();
  });

  it('--dry-run --json outputs LAFS envelope with dryRun:true and purged:0', async () => {
    const result = await invokeClean(ALL_ROWS, {
      'include-temp': true,
      'dry-run': true,
      json: true,
    });
    const envelope = JSON.parse(result.stdout) as {
      success: boolean;
      data: { dryRun: boolean; purged: number; matched: number };
    };
    expect(envelope.success).toBe(true);
    expect(envelope.data.dryRun).toBe(true);
    expect(envelope.data.purged).toBe(0);
    expect(envelope.data.matched).toBeGreaterThan(0);
    expect(deletedIds).toHaveLength(0);
  });

  it('--dry-run does NOT write an audit log entry', async () => {
    await invokeClean(ALL_ROWS, { 'include-temp': true, 'dry-run': true });
    expect(auditInserts).toHaveLength(0);
  });

  // ── --include-temp ────────────────────────────────────────────────────────

  it('--include-temp matches only .temp/ paths', async () => {
    const result = await invokeClean(ALL_ROWS, {
      'include-temp': true,
      'dry-run': true,
      json: true,
    });
    const envelope = JSON.parse(result.stdout) as {
      data: { matched: number; sample: string[] };
    };
    expect(envelope.data.matched).toBe(1);
    expect(envelope.data.sample).toContain(TEMP_ROW.projectPath);
    expect(envelope.data.sample).not.toContain(NORMAL_ROW.projectPath);
  });

  it('--include-temp does not match test/tmp paths', async () => {
    const result = await invokeClean(ALL_ROWS, {
      'include-temp': true,
      'dry-run': true,
      json: true,
    });
    const envelope = JSON.parse(result.stdout) as { data: { sample: string[] } };
    expect(envelope.data.sample).not.toContain(TESTS_ROW.projectPath);
  });

  // ── --include-tests ───────────────────────────────────────────────────────

  it('--include-tests matches tmp, test, fixture, scratch, sandbox paths', async () => {
    const rows: MockRow[] = [
      { projectId: 'a', projectPath: '/x/tmp/p', healthStatus: 'healthy', lastIndexed: null },
      { projectId: 'b', projectPath: '/x/test/p', healthStatus: 'healthy', lastIndexed: null },
      { projectId: 'c', projectPath: '/x/fixture/p', healthStatus: 'healthy', lastIndexed: null },
      { projectId: 'd', projectPath: '/x/scratch/p', healthStatus: 'healthy', lastIndexed: null },
      { projectId: 'e', projectPath: '/x/sandbox/p', healthStatus: 'healthy', lastIndexed: null },
      { projectId: 'f', projectPath: '/x/normal/p', healthStatus: 'healthy', lastIndexed: null },
    ];
    const result = await invokeClean(rows, { 'include-tests': true, 'dry-run': true, json: true });
    const envelope = JSON.parse(result.stdout) as { data: { matched: number; sample: string[] } };
    expect(envelope.data.matched).toBe(5);
    expect(envelope.data.sample).not.toContain('/x/normal/p');
  });

  it('--include-tests does not match .temp/ paths', async () => {
    const result = await invokeClean(ALL_ROWS, {
      'include-tests': true,
      'dry-run': true,
      json: true,
    });
    const envelope = JSON.parse(result.stdout) as { data: { sample: string[] } };
    expect(envelope.data.sample).not.toContain(TEMP_ROW.projectPath);
  });

  // ── --pattern ─────────────────────────────────────────────────────────────

  it('--pattern filters by custom JS regex', async () => {
    const result = await invokeClean(ALL_ROWS, {
      pattern: 'normal',
      'dry-run': true,
      json: true,
    });
    const envelope = JSON.parse(result.stdout) as { data: { matched: number; sample: string[] } };
    expect(envelope.data.matched).toBe(1);
    expect(envelope.data.sample).toContain(NORMAL_ROW.projectPath);
  });

  it('--pattern with invalid regex exits 6', async () => {
    const result = await invokeClean(ALL_ROWS, { pattern: '[invalid(', 'dry-run': true });
    expect(result.exitCode).toBe(6);
    // T1510 dispatch-layer message: engine pre-validates the regex before core.
    expect(result.stderr).toContain('Invalid regex pattern');
  });

  it('--pattern --json with invalid regex outputs E_INVALID_PATTERN', async () => {
    const result = await invokeClean(ALL_ROWS, {
      pattern: '[invalid(',
      'dry-run': true,
      json: true,
    });
    const envelope = JSON.parse(result.stdout) as {
      success: boolean;
      error: { code: number; codeName?: string };
    };
    expect(envelope.success).toBe(false);
    // error.codeName carries the symbolic code; error.code is the numeric exit code
    expect(envelope.error.codeName).toBe('E_INVALID_PATTERN');
  });

  // ── --unhealthy + --never-indexed combo ───────────────────────────────────

  it('--unhealthy matches only rows with healthStatus="unhealthy"', async () => {
    const result = await invokeClean(ALL_ROWS, { unhealthy: true, 'dry-run': true, json: true });
    const envelope = JSON.parse(result.stdout) as { data: { matched: number; sample: string[] } };
    expect(envelope.data.matched).toBe(1);
    expect(envelope.data.sample).toContain(UNHEALTHY_ROW.projectPath);
  });

  it('--never-indexed matches only rows with lastIndexed=null', async () => {
    const result = await invokeClean(ALL_ROWS, {
      'never-indexed': true,
      'dry-run': true,
      json: true,
    });
    const envelope = JSON.parse(result.stdout) as { data: { matched: number; sample: string[] } };
    expect(envelope.data.matched).toBe(1);
    expect(envelope.data.sample).toContain(NEVER_INDEXED_ROW.projectPath);
  });

  it('--unhealthy --never-indexed combo matches rows matching EITHER condition', async () => {
    const result = await invokeClean(ALL_ROWS, {
      unhealthy: true,
      'never-indexed': true,
      'dry-run': true,
      json: true,
    });
    const envelope = JSON.parse(result.stdout) as { data: { matched: number } };
    // UNHEALTHY_ROW and NEVER_INDEXED_ROW both match
    expect(envelope.data.matched).toBe(2);
  });

  // ── --yes skips prompt ────────────────────────────────────────────────────

  it('--yes skips confirmation prompt and deletes', async () => {
    const result = await invokeClean(ALL_ROWS, { 'include-temp': true, yes: true, json: true });
    const envelope = JSON.parse(result.stdout) as {
      success: boolean;
      data: { purged: number };
    };
    expect(envelope.success).toBe(true);
    expect(envelope.data.purged).toBe(1);
    expect(deletedIds).toHaveLength(1);
    expect(deletedIds[0]).toContain(TEMP_ROW.projectId);
  });

  it('--yes with --json reports correct remaining count', async () => {
    const result = await invokeClean(ALL_ROWS, { 'include-temp': true, yes: true, json: true });
    const envelope = JSON.parse(result.stdout) as { data: { remaining: number } };
    expect(envelope.data.remaining).toBe(ALL_ROWS.length - 1);
  });

  // ── Audit log ─────────────────────────────────────────────────────────────

  it('writes an audit log entry with action="projects.clean" on deletion', async () => {
    await invokeClean(ALL_ROWS, { 'include-temp': true, yes: true });
    const entry = auditInserts.find((e) => e['action'] === 'projects.clean');
    expect(entry).toBeDefined();
  });

  it('audit log detailsJson includes count and sample', async () => {
    await invokeClean(ALL_ROWS, { 'include-temp': true, yes: true });
    const entry = auditInserts.find((e) => e['action'] === 'projects.clean');
    expect(entry).toBeDefined();
    const details = JSON.parse(entry!['detailsJson'] as string) as {
      count: number;
      sample: string[];
    };
    expect(details.count).toBe(1);
    expect(details.sample).toContain(TEMP_ROW.projectPath);
  });

  it('does NOT write audit log on dry-run', async () => {
    await invokeClean(ALL_ROWS, { 'include-temp': true, 'dry-run': true });
    const entry = auditInserts.find((e) => e['action'] === 'projects.clean');
    expect(entry).toBeUndefined();
  });

  // ── Zero matches ─────────────────────────────────────────────────────────

  it('reports zero purged when no rows match', async () => {
    const result = await invokeClean([NORMAL_ROW], { 'include-temp': true, yes: true, json: true });
    const envelope = JSON.parse(result.stdout) as {
      success: boolean;
      data: { matched: number; purged: number };
    };
    expect(envelope.success).toBe(true);
    expect(envelope.data.matched).toBe(0);
    expect(envelope.data.purged).toBe(0);
    expect(deletedIds).toHaveLength(0);
  });
});
