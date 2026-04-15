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
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShimCommand } from '../commander-shim.js';
import { ShimCommand as Command } from '../commander-shim.js';
import { registerNexusCommand } from '../commands/nexus.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

// getNexusDbMock is the vi.fn() that the production code calls.
// We hold a hoisted reference so each test can configure what it resolves with.
const { getNexusDbMock } = vi.hoisted(() => ({ getNexusDbMock: vi.fn() }));

// Mock nexus-sqlite: stub all exports so no real DB is opened.
vi.mock('@cleocode/core/store/nexus-sqlite', () => ({
  getNexusDb: getNexusDbMock,
  getNexusDbPath: vi.fn().mockReturnValue('/mock/nexus.db'),
  resolveNexusMigrationsFolder: vi.fn().mockReturnValue('/mock/migrations'),
  closeNexusDb: vi.fn(),
  resetNexusDbState: vi.fn(),
  getNexusNativeDb: vi.fn().mockReturnValue(null),
  nexusSchema: {},
  NEXUS_SCHEMA_VERSION: '1.0.0',
}));

// Stub nexus-schema with simple column-name strings — Drizzle schema objects
// are only used as pass-through keys in the production code.
vi.mock('@cleocode/core/store/nexus-schema', () => ({
  projectRegistry: {
    projectId: 'projectId',
    projectPath: 'projectPath',
    healthStatus: 'healthStatus',
    lastIndexed: 'lastIndexed',
  },
  nexusAuditLog: {},
}));

// Partial mock: spread real drizzle-orm exports so sql/eq/etc. stay intact,
// but tag inArray's return value so the mock db.where() can read the IDs.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    inArray: vi.fn().mockImplementation((_col: unknown, ids: string[]) => {
      return { _ids: ids };
    }),
  };
});

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn().mockReturnValue('test-uuid-1234'),
}));

// ── Shared test rows ─────────────────────────────────────────────────────────

/** Minimal project_registry row shape returned by the mock db.select chain. */
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

// ── Mock db factory ───────────────────────────────────────────────────────────

/** Captured delete calls: each entry is the IDs array passed to inArray. */
let deletedIds: string[][] = [];
/** Captured audit log inserts. */
let auditInserts: Record<string, unknown>[] = [];

/**
 * Build a minimal mock Drizzle db that records operations for assertion.
 * `rows` is what db.select().from() resolves with.
 */
function makeMockDb(rows: MockRow[]) {
  deletedIds = [];
  auditInserts = [];

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue(rows),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation((condition: { _ids?: string[] }) => {
        deletedIds.push(condition._ids ?? []);
        return Promise.resolve();
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        auditInserts.push(vals);
        return Promise.resolve();
      }),
    }),
  };
}

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Find the `clean` ShimCommand under `nexus projects`.
 * Throws if the command tree is not found (test setup error).
 */
function getCleanCmd(): ShimCommand {
  const program = new Command();
  registerNexusCommand(program);
  const nexusCmd = program.commands.find((c) => c.name() === 'nexus');
  if (!nexusCmd) throw new Error('nexus command not registered');
  const projectsCmd = nexusCmd.commands.find((c) => c.name() === 'projects');
  if (!projectsCmd) throw new Error('nexus projects command not registered');
  const cleanCmd = projectsCmd.commands.find((c) => c.name() === 'clean');
  if (!cleanCmd) throw new Error('nexus projects clean command not registered');
  return cleanCmd;
}

// ── Helper: invoke the clean action directly ─────────────────────────────────

/**
 * Invoke the `cleo nexus projects clean` action with the given opts.
 * Captures stdout/stderr and the exit code set by process.exitCode.
 *
 * @param rows - Rows the mock db will return from select.
 * @param opts - Parsed option values passed to the action (mirrors Commander opts).
 */
async function invokeClean(
  rows: MockRow[],
  opts: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const mockDb = makeMockDb(rows);
  getNexusDbMock.mockResolvedValue(mockDb);

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

  const cleanCmd = getCleanCmd();
  // The ShimCommand action is stored as _action. Invoke it directly.
  if (cleanCmd._action) {
    try {
      await (cleanCmd._action as (opts: Record<string, unknown>) => Promise<void>)(opts);
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
    const program = new Command();
    registerNexusCommand(program);
    const nexusCmd = program.commands.find((c) => c.name() === 'nexus');
    expect(nexusCmd).toBeDefined();
    const projectsCmd = nexusCmd!.commands.find((c) => c.name() === 'projects');
    expect(projectsCmd).toBeDefined();
    const cleanCmd = projectsCmd!.commands.find((c) => c.name() === 'clean');
    expect(cleanCmd).toBeDefined();
    expect(cleanCmd!.description()).toContain('Bulk purge');
  });

  it('has all required flags', () => {
    const cleanCmd = getCleanCmd();
    const optionLongs = cleanCmd.options.map((o) => o.long);
    expect(optionLongs).toContain('--dry-run');
    expect(optionLongs).toContain('--pattern');
    expect(optionLongs).toContain('--include-temp');
    expect(optionLongs).toContain('--include-tests');
    expect(optionLongs).toContain('--unhealthy');
    expect(optionLongs).toContain('--never-indexed');
    expect(optionLongs).toContain('--yes');
    expect(optionLongs).toContain('--json');
  });

  // ── No criteria → exit 6 ─────────────────────────────────────────────────

  it('errors with exit code 6 when no criteria flag is given', async () => {
    const result = await invokeClean(ALL_ROWS, {});
    expect(result.exitCode).toBe(6);
  });

  it('includes a helpful error message when no criteria is given', async () => {
    const result = await invokeClean(ALL_ROWS, {});
    expect(result.stderr).toContain('No filter criteria');
  });

  it('--json outputs LAFS envelope with E_NO_CRITERIA when no criteria', async () => {
    const result = await invokeClean(ALL_ROWS, { json: true });
    const envelope = JSON.parse(result.stdout) as {
      success: boolean;
      error: { code: string };
    };
    expect(envelope.success).toBe(false);
    expect(envelope.error.code).toBe('E_NO_CRITERIA');
    expect(result.exitCode).toBe(6);
  });

  // ── --dry-run ─────────────────────────────────────────────────────────────

  it('--dry-run with --include-temp lists matches without deleting', async () => {
    const result = await invokeClean(ALL_ROWS, { includeTemp: true, dryRun: true });
    expect(result.stdout).toContain(TEMP_ROW.projectPath);
    expect(deletedIds).toHaveLength(0);
    expect(result.exitCode).toBeUndefined();
  });

  it('--dry-run --json outputs LAFS envelope with dryRun:true and purged:0', async () => {
    const result = await invokeClean(ALL_ROWS, { includeTemp: true, dryRun: true, json: true });
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
    await invokeClean(ALL_ROWS, { includeTemp: true, dryRun: true });
    expect(auditInserts).toHaveLength(0);
  });

  // ── --include-temp ────────────────────────────────────────────────────────

  it('--include-temp matches only .temp/ paths', async () => {
    const result = await invokeClean(ALL_ROWS, { includeTemp: true, dryRun: true, json: true });
    const envelope = JSON.parse(result.stdout) as {
      data: { matched: number; sample: string[] };
    };
    expect(envelope.data.matched).toBe(1);
    expect(envelope.data.sample).toContain(TEMP_ROW.projectPath);
    expect(envelope.data.sample).not.toContain(NORMAL_ROW.projectPath);
  });

  it('--include-temp does not match test/tmp paths', async () => {
    const result = await invokeClean(ALL_ROWS, { includeTemp: true, dryRun: true, json: true });
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
    const result = await invokeClean(rows, { includeTests: true, dryRun: true, json: true });
    const envelope = JSON.parse(result.stdout) as { data: { matched: number; sample: string[] } };
    expect(envelope.data.matched).toBe(5);
    expect(envelope.data.sample).not.toContain('/x/normal/p');
  });

  it('--include-tests does not match .temp/ paths', async () => {
    const result = await invokeClean(ALL_ROWS, { includeTests: true, dryRun: true, json: true });
    const envelope = JSON.parse(result.stdout) as { data: { sample: string[] } };
    expect(envelope.data.sample).not.toContain(TEMP_ROW.projectPath);
  });

  // ── --pattern ─────────────────────────────────────────────────────────────

  it('--pattern filters by custom JS regex', async () => {
    const result = await invokeClean(ALL_ROWS, {
      pattern: 'normal',
      dryRun: true,
      json: true,
    });
    const envelope = JSON.parse(result.stdout) as { data: { matched: number; sample: string[] } };
    expect(envelope.data.matched).toBe(1);
    expect(envelope.data.sample).toContain(NORMAL_ROW.projectPath);
  });

  it('--pattern with invalid regex exits 6', async () => {
    const result = await invokeClean(ALL_ROWS, { pattern: '[invalid(', dryRun: true });
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain('Invalid --pattern regex');
  });

  it('--pattern --json with invalid regex outputs E_INVALID_PATTERN', async () => {
    const result = await invokeClean(ALL_ROWS, {
      pattern: '[invalid(',
      dryRun: true,
      json: true,
    });
    const envelope = JSON.parse(result.stdout) as { success: boolean; error: { code: string } };
    expect(envelope.success).toBe(false);
    expect(envelope.error.code).toBe('E_INVALID_PATTERN');
  });

  // ── --unhealthy + --never-indexed combo ───────────────────────────────────

  it('--unhealthy matches only rows with healthStatus="unhealthy"', async () => {
    const result = await invokeClean(ALL_ROWS, { unhealthy: true, dryRun: true, json: true });
    const envelope = JSON.parse(result.stdout) as { data: { matched: number; sample: string[] } };
    expect(envelope.data.matched).toBe(1);
    expect(envelope.data.sample).toContain(UNHEALTHY_ROW.projectPath);
  });

  it('--never-indexed matches only rows with lastIndexed=null', async () => {
    const result = await invokeClean(ALL_ROWS, { neverIndexed: true, dryRun: true, json: true });
    const envelope = JSON.parse(result.stdout) as { data: { matched: number; sample: string[] } };
    expect(envelope.data.matched).toBe(1);
    expect(envelope.data.sample).toContain(NEVER_INDEXED_ROW.projectPath);
  });

  it('--unhealthy --never-indexed combo matches rows matching EITHER condition', async () => {
    const result = await invokeClean(ALL_ROWS, {
      unhealthy: true,
      neverIndexed: true,
      dryRun: true,
      json: true,
    });
    const envelope = JSON.parse(result.stdout) as { data: { matched: number } };
    // UNHEALTHY_ROW and NEVER_INDEXED_ROW both match
    expect(envelope.data.matched).toBe(2);
  });

  // ── --yes skips prompt ────────────────────────────────────────────────────

  it('--yes skips confirmation prompt and deletes', async () => {
    const result = await invokeClean(ALL_ROWS, { includeTemp: true, yes: true, json: true });
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
    const result = await invokeClean(ALL_ROWS, { includeTemp: true, yes: true, json: true });
    const envelope = JSON.parse(result.stdout) as { data: { remaining: number } };
    expect(envelope.data.remaining).toBe(ALL_ROWS.length - 1);
  });

  // ── Audit log ─────────────────────────────────────────────────────────────

  it('writes an audit log entry with action="projects.clean" on deletion', async () => {
    await invokeClean(ALL_ROWS, { includeTemp: true, yes: true });
    const entry = auditInserts.find((e) => e['action'] === 'projects.clean');
    expect(entry).toBeDefined();
  });

  it('audit log detailsJson includes count and sample', async () => {
    await invokeClean(ALL_ROWS, { includeTemp: true, yes: true });
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
    await invokeClean(ALL_ROWS, { includeTemp: true, dryRun: true });
    const entry = auditInserts.find((e) => e['action'] === 'projects.clean');
    expect(entry).toBeUndefined();
  });

  // ── Zero matches ─────────────────────────────────────────────────────────

  it('reports zero purged when no rows match', async () => {
    const result = await invokeClean([NORMAL_ROW], { includeTemp: true, yes: true, json: true });
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
