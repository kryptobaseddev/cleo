/**
 * Unit tests for `cleo backup recover <role>` and the backward-compatible
 * `cleo backup recover brain` leaf (T10318 — generalised from T10304).
 *
 * Verifies the CLI dispatch wiring:
 *   - `cleo backup recover brain` continues to work (backward compat).
 *   - `cleo backup recover <role>` accepts any role from DB_INVENTORY.
 *   - `--dry-run`, `--from-snapshot`, `--no-delta` are plumbed through.
 *   - Missing role surfaces E_VALIDATION (exit code 6).
 *   - Unknown role surfaces E_UNKNOWN_ROLE.
 *   - BackupRecoverError instances are mapped to their stable exit codes.
 *   - Generic errors fall back to exit code 1.
 *
 * The core `runBackupRecover` helper is mocked so this test exercises only
 * the CLI command's wiring (arg parsing, envelope shape, exit codes).
 *
 * @task T10318
 * @epic T10284
 * @saga T10281
 */

import type { BackupRecoverResult, DbRecoveredRowCounts } from '@cleocode/contracts';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupCommand } from '../backup.js';

// ---------------------------------------------------------------------------
// Mocks — keep all real SQLite, file I/O, and dispatch off the table
// ---------------------------------------------------------------------------

const mockRunBackupRecover = vi.fn();

vi.mock('@cleocode/core/store/backup-recover.js', () => {
  class BackupRecoverErrorMock extends Error {
    constructor(
      message: string,
      public readonly code: number,
      public readonly codeName: string,
      public readonly fix?: string,
    ) {
      super(message);
      this.name = 'BackupRecoverError';
    }
  }
  return {
    runBackupRecover: (...args: unknown[]) => mockRunBackupRecover(...args),
    BackupRecoverError: BackupRecoverErrorMock,
  };
});

/**
 * Constructor signature for the mocked `BackupRecoverError` class.
 *
 * The test body needs the SAME class reference the production code sees
 * via `instanceof BackupRecoverError` so thrown errors are routed
 * through the mapped-error branch rather than the generic catch.
 */
type MockBackupRecoverErrorCtor = new (
  message: string,
  code: number,
  codeName: string,
  fix?: string,
) => Error;

let MockBackupRecoverError: MockBackupRecoverErrorCtor;

beforeAll(async () => {
  const mod: { BackupRecoverError: MockBackupRecoverErrorCtor } = await import(
    '@cleocode/core/store/backup-recover.js'
  );
  MockBackupRecoverError = mod.BackupRecoverError;
});

const mockGetProjectRoot = vi.fn(() => '/tmp/test-project');
const mockGetLogger = vi.fn(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@cleocode/core', async () => {
  // Pull through the real exit codes etc. but stub out path resolvers + logger.
  const actual = await vi.importActual<Record<string, unknown>>('@cleocode/core');
  return {
    ...actual,
    getProjectRoot: () => mockGetProjectRoot(),
    getLogger: (channel: string) => mockGetLogger(channel),
  };
});

// Stub the dispatch adapter — backup.ts pulls it in for the parent group's
// default `run` action even though we never exercise that path here.
vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: vi.fn().mockResolvedValue(undefined),
  dispatchRaw: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers — invoke either the brain leaf or the generic recover group
// ---------------------------------------------------------------------------

interface RecoverArgs {
  role?: string;
  'dry-run'?: boolean;
  'from-snapshot'?: string;
  'no-delta'?: boolean;
  force?: boolean;
}

interface CittyLeaf {
  run: (ctx: { args: RecoverArgs; rawArgs: string[] }) => Promise<void>;
}

/**
 * Resolve the `cleo backup recover brain` subcommand and invoke its run
 * handler with the supplied flags merged onto defaults.
 */
async function runRecoverBrain(args: RecoverArgs): Promise<void> {
  const recoverGroup = backupCommand.subCommands?.['recover'];
  if (!recoverGroup || typeof recoverGroup !== 'object' || !('subCommands' in recoverGroup)) {
    throw new Error('backup recover group subcommand not found');
  }
  const subCommands = (recoverGroup as { subCommands?: Record<string, unknown> }).subCommands;
  const brainCmd = subCommands?.['brain'];
  if (!brainCmd || typeof brainCmd !== 'object' || !('run' in brainCmd)) {
    throw new Error('backup recover brain subcommand not found');
  }
  const merged: RecoverArgs = {
    'dry-run': false,
    'from-snapshot': '',
    'no-delta': false,
    force: false,
    ...args,
  };
  await (brainCmd as CittyLeaf).run({ args: merged, rawArgs: [] });
}

/**
 * Resolve the `cleo backup recover` parent and invoke its run handler with
 * the supplied positional `role` arg and flags. Exercises the generic
 * `cleo backup recover <role>` dispatch path.
 */
async function runRecoverGeneric(args: RecoverArgs): Promise<void> {
  const recoverGroup = backupCommand.subCommands?.['recover'];
  if (!recoverGroup || typeof recoverGroup !== 'object' || !('run' in recoverGroup)) {
    throw new Error('backup recover group subcommand not found');
  }
  const merged: RecoverArgs = {
    role: '',
    'dry-run': false,
    'from-snapshot': '',
    'no-delta': false,
    force: false,
    ...args,
  };
  await (recoverGroup as CittyLeaf).run({ args: merged, rawArgs: [] });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BRAIN_ROW_COUNTS: DbRecoveredRowCounts = {
  brain_observations: 142,
  brain_decisions: 8,
  brain_learnings: 17,
};

const ZERO_ROW_COUNTS: DbRecoveredRowCounts = {};

const HAPPY_RESULT: BackupRecoverResult = {
  role: 'brain',
  restoredFrom:
    '/tmp/test-project/.cleo/backups/snapshot/brain.db.snapshot-2026-05-23T08-00-55-563Z',
  rowsRecovered: BRAIN_ROW_COUNTS,
  dataLossWindowHours: 5.2,
  integrityOK: true,
  quarantinedTo: '/tmp/test-project/.cleo/quarantine/brain-malformed-2026-05-23T13-12-00-000Z',
  dryRun: false,
};

const DRY_RUN_PLAN: BackupRecoverResult = {
  ...HAPPY_RESULT,
  quarantinedTo: '',
  dryRun: true,
};

const TASKS_HAPPY_RESULT: BackupRecoverResult = {
  ...HAPPY_RESULT,
  role: 'tasks',
  restoredFrom:
    '/tmp/test-project/.cleo/backups/snapshot/tasks.db.snapshot-2026-05-23T08-00-55-563Z',
  rowsRecovered: { tasks: 250 } satisfies DbRecoveredRowCounts,
};

// ---------------------------------------------------------------------------
// Tests — backward-compat `cleo backup recover brain` leaf
// ---------------------------------------------------------------------------

describe('cleo backup recover brain — dry-run mode (T10318 backward compat)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('returns a plan envelope with dryRun=true without mutating state', async () => {
    mockRunBackupRecover.mockReturnValue(DRY_RUN_PLAN);

    await runRecoverBrain({ 'dry-run': true });

    expect(mockRunBackupRecover).toHaveBeenCalledOnce();
    const call = mockRunBackupRecover.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      role: 'brain',
      projectRoot: '/tmp/test-project',
      dryRun: true,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('plumbs --from-snapshot through to the core helper', async () => {
    mockRunBackupRecover.mockReturnValue(DRY_RUN_PLAN);

    await runRecoverBrain({
      'dry-run': true,
      'from-snapshot': '2026-05-22',
    });

    const call = mockRunBackupRecover.mock.calls[0]?.[0];
    expect(call?.fromSnapshot).toBe('2026-05-22');
  });

  it('plumbs --no-delta through to the core helper', async () => {
    mockRunBackupRecover.mockReturnValue(DRY_RUN_PLAN);

    await runRecoverBrain({ 'dry-run': true, 'no-delta': true });

    const call = mockRunBackupRecover.mock.calls[0]?.[0];
    expect(call?.noDelta).toBe(true);
  });
});

describe('cleo backup recover brain — happy path (T10318 backward compat)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('returns structured envelope with all expected fields on success', async () => {
    mockRunBackupRecover.mockReturnValue(HAPPY_RESULT);

    await runRecoverBrain({});

    expect(mockRunBackupRecover).toHaveBeenCalledOnce();
    const call = mockRunBackupRecover.mock.calls[0]?.[0];
    expect(call?.role).toBe('brain');
    expect(call?.dryRun).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('passes role=brain and projectRoot through', async () => {
    mockRunBackupRecover.mockReturnValue(HAPPY_RESULT);

    await runRecoverBrain({});

    const call = mockRunBackupRecover.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      role: 'brain',
      projectRoot: '/tmp/test-project',
    });
  });
});

describe('cleo backup recover brain — error paths (T10318 backward compat)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('surfaces E_NO_SNAPSHOT with exit code 4 when no snapshots present', async () => {
    mockRunBackupRecover.mockImplementation(() => {
      throw new MockBackupRecoverError(
        'No snapshots found for role "brain"',
        4,
        'E_NO_SNAPSHOT',
        'Run `cleo backup add` to create a snapshot for role "brain" before attempting recovery.',
      );
    });

    await runRecoverBrain({});

    expect(process.exitCode).toBe(4);
  });

  it('surfaces E_NO_SNAPSHOT_MATCH with exit code 4 when --from-snapshot pin matches zero candidates', async () => {
    mockRunBackupRecover.mockImplementation(() => {
      throw new MockBackupRecoverError(
        'Snapshot pin "1970-01-01" matched zero candidates for role "brain"',
        4,
        'E_NO_SNAPSHOT_MATCH',
      );
    });

    await runRecoverBrain({ 'from-snapshot': '1970-01-01' });

    expect(process.exitCode).toBe(4);
  });

  it('surfaces generic errors with exit code 1', async () => {
    mockRunBackupRecover.mockImplementation(() => {
      throw new Error('disk full');
    });

    await runRecoverBrain({});

    // GENERAL_ERROR = 1
    expect(process.exitCode).toBe(1);
  });

  it('returns empty-counts envelope when restoration produced empty tables', async () => {
    mockRunBackupRecover.mockReturnValue({
      ...HAPPY_RESULT,
      rowsRecovered: ZERO_ROW_COUNTS,
    });

    await runRecoverBrain({});

    expect(process.exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — new generic `cleo backup recover <role>` surface
// ---------------------------------------------------------------------------

describe('cleo backup recover <role> — generic surface (T10318)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('accepts an explicit positional role from DB_INVENTORY', async () => {
    mockRunBackupRecover.mockReturnValue(TASKS_HAPPY_RESULT);

    await runRecoverGeneric({ role: 'tasks' });

    expect(mockRunBackupRecover).toHaveBeenCalledOnce();
    const call = mockRunBackupRecover.mock.calls[0]?.[0];
    expect(call?.role).toBe('tasks');
    expect(process.exitCode).toBeUndefined();
  });

  it('surfaces E_VALIDATION with exit code 6 when no role is supplied', async () => {
    await runRecoverGeneric({ role: '' });

    expect(mockRunBackupRecover).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(6);
  });

  it('surfaces E_UNKNOWN_ROLE when an unknown role is supplied', async () => {
    await runRecoverGeneric({ role: 'not-a-real-role' });

    expect(mockRunBackupRecover).not.toHaveBeenCalled();
    expect(typeof process.exitCode).toBe('number');
    expect(process.exitCode).not.toBe(0);
  });

  it('plumbs --dry-run, --from-snapshot, --no-delta into the generic path', async () => {
    mockRunBackupRecover.mockReturnValue({
      ...TASKS_HAPPY_RESULT,
      dryRun: true,
      quarantinedTo: '',
    });

    await runRecoverGeneric({
      role: 'tasks',
      'dry-run': true,
      'from-snapshot': '2026-05-22',
      'no-delta': true,
    });

    const call = mockRunBackupRecover.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      role: 'tasks',
      dryRun: true,
      fromSnapshot: '2026-05-22',
      noDelta: true,
    });
  });
});
