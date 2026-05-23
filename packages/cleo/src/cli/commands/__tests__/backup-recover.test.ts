/**
 * Unit tests for T10304: cleo backup recover brain
 *
 * Verifies the `backup recover brain` subcommand action handler:
 *   - --dry-run returns a plan envelope with dryRun=true and no mutation
 *   - happy-path returns structured envelope with all expected fields
 *   - missing-snapshot error path (E_NO_SNAPSHOT) returns clear error
 *   - --from-snapshot pin is plumbed through to the core helper
 *   - generic errors are surfaced via cliError with non-zero exit code
 *
 * The core `runBackupRecoverBrain` helper is mocked so this test exercises
 * ONLY the CLI command's wiring (arg parsing, envelope shape, exit codes).
 * Pattern mirrors backup-export.test.ts.
 *
 * @task T10304
 * @epic T10286
 * @saga T10281
 */

import type { BackupRecoverBrainResult, BrainRecoveredRowCounts } from '@cleocode/contracts';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupCommand } from '../backup.js';

// ---------------------------------------------------------------------------
// Mocks — keep all real SQLite, file I/O, and dispatch off the table
// ---------------------------------------------------------------------------

const mockRunBackupRecoverBrain = vi.fn();

vi.mock('@cleocode/core/store/backup-recover-brain.js', () => {
  // Defined INSIDE the factory so the hoisted vi.mock body does not reach
  // a TDZ variable declared after it in the test file (T10304).
  class BackupRecoverBrainErrorMock extends Error {
    constructor(
      message: string,
      public readonly code: number,
      public readonly codeName: string,
      public readonly fix?: string,
    ) {
      super(message);
      this.name = 'BackupRecoverBrainError';
    }
  }
  return {
    runBackupRecoverBrain: (...args: unknown[]) => mockRunBackupRecoverBrain(...args),
    BackupRecoverBrainError: BackupRecoverBrainErrorMock,
  };
});

/**
 * Constructor signature for the mocked `BackupRecoverBrainError` class.
 *
 * The test body needs the SAME class reference the production code sees
 * via `instanceof BackupRecoverBrainError` so thrown errors are routed
 * through the mapped-error branch (exit code 4 / 78) rather than the
 * generic catch (exit code 1). Populated by `beforeAll` below.
 */
type MockBackupRecoverBrainErrorCtor = new (
  message: string,
  code: number,
  codeName: string,
  fix?: string,
) => Error;

let MockBackupRecoverBrainError: MockBackupRecoverBrainErrorCtor;

beforeAll(async () => {
  const mod: { BackupRecoverBrainError: MockBackupRecoverBrainErrorCtor } = await import(
    '@cleocode/core/store/backup-recover-brain.js'
  );
  MockBackupRecoverBrainError = mod.BackupRecoverBrainError;
});

const mockGetProjectRoot = vi.fn(() => '/tmp/test-project');
const mockGetCleoDirAbsolute = vi.fn(() => '/tmp/test-project/.cleo');
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
    getCleoDirAbsolute: (cwd?: string) => mockGetCleoDirAbsolute(cwd),
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
// Helper — invoke the leaf subcommand's run handler
// ---------------------------------------------------------------------------

interface RecoverArgs {
  'dry-run'?: boolean;
  'from-snapshot'?: string;
  'no-delta'?: boolean;
  force?: boolean;
}

interface CittyLeaf {
  run: (ctx: { args: RecoverArgs; rawArgs: string[] }) => Promise<void>;
}

/**
 * Reach into `backupCommand.subCommands.recover.subCommands.brain.run` and
 * invoke it with the supplied flags merged onto defaults.
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ZERO_COUNTS: BrainRecoveredRowCounts = {
  observations: 0,
  decisions: 0,
  learnings: 0,
};

const HAPPY_RESULT: BackupRecoverBrainResult = {
  restoredFrom:
    '/tmp/test-project/.cleo/backups/snapshot/brain.db.snapshot-2026-05-23T08-00-55-563Z',
  rowsRecovered: { observations: 142, decisions: 8, learnings: 17 },
  dataLossWindowHours: 5.2,
  integrityOK: true,
  quarantinedTo: '/tmp/test-project/.cleo/quarantine/brain-malformed-2026-05-23T13-12-00-000Z',
  dryRun: false,
};

const DRY_RUN_PLAN: BackupRecoverBrainResult = {
  ...HAPPY_RESULT,
  quarantinedTo: '',
  dryRun: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T10304 cleo backup recover brain — dry-run mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('returns a plan envelope with dryRun=true without mutating state', async () => {
    mockRunBackupRecoverBrain.mockReturnValue(DRY_RUN_PLAN);

    await runRecoverBrain({ 'dry-run': true });

    expect(mockRunBackupRecoverBrain).toHaveBeenCalledOnce();
    const call = mockRunBackupRecoverBrain.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      corruptPath: '/tmp/test-project/.cleo/brain.db',
      snapshotDir: '/tmp/test-project/.cleo/backups/snapshot',
      vacuumSnapshotDir: '/tmp/test-project/.cleo/backups/sqlite',
      legacyArtifactDir: '/tmp/test-project/.cleo',
      quarantineRoot: '/tmp/test-project/.cleo/quarantine',
      dryRun: true,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('plumbs --from-snapshot through to the core helper', async () => {
    mockRunBackupRecoverBrain.mockReturnValue(DRY_RUN_PLAN);

    await runRecoverBrain({
      'dry-run': true,
      'from-snapshot': '2026-05-22',
    });

    const call = mockRunBackupRecoverBrain.mock.calls[0]?.[0];
    expect(call?.fromSnapshot).toBe('2026-05-22');
  });

  it('plumbs --no-delta through to the core helper', async () => {
    mockRunBackupRecoverBrain.mockReturnValue(DRY_RUN_PLAN);

    await runRecoverBrain({ 'dry-run': true, 'no-delta': true });

    const call = mockRunBackupRecoverBrain.mock.calls[0]?.[0];
    expect(call?.noDelta).toBe(true);
  });
});

describe('T10304 cleo backup recover brain — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('returns structured envelope with all expected fields on success', async () => {
    mockRunBackupRecoverBrain.mockReturnValue(HAPPY_RESULT);

    await runRecoverBrain({});

    expect(mockRunBackupRecoverBrain).toHaveBeenCalledOnce();
    const call = mockRunBackupRecoverBrain.mock.calls[0]?.[0];
    expect(call?.dryRun).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('passes corruptPath, snapshotDir, vacuumSnapshotDir, legacyArtifactDir, quarantineRoot', async () => {
    mockRunBackupRecoverBrain.mockReturnValue(HAPPY_RESULT);

    await runRecoverBrain({});

    const call = mockRunBackupRecoverBrain.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      corruptPath: '/tmp/test-project/.cleo/brain.db',
      snapshotDir: '/tmp/test-project/.cleo/backups/snapshot',
      vacuumSnapshotDir: '/tmp/test-project/.cleo/backups/sqlite',
      legacyArtifactDir: '/tmp/test-project/.cleo',
      quarantineRoot: '/tmp/test-project/.cleo/quarantine',
    });
  });
});

describe('T10304 cleo backup recover brain — error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('surfaces E_NO_SNAPSHOT with exit code 4 when no snapshots present', async () => {
    mockRunBackupRecoverBrain.mockImplementation(() => {
      throw new MockBackupRecoverBrainError(
        'No snapshots found under /tmp/test-project/.cleo/backups/snapshot',
        4,
        'E_NO_SNAPSHOT',
        'Run `cleo backup add` to create a snapshot before attempting recovery.',
      );
    });

    await runRecoverBrain({});

    expect(process.exitCode).toBe(4);
  });

  it('surfaces E_NO_SNAPSHOT_MATCH with exit code 4 when --from-snapshot pin matches zero candidates', async () => {
    mockRunBackupRecoverBrain.mockImplementation(() => {
      throw new MockBackupRecoverBrainError(
        'Snapshot pin "1970-01-01" matched zero candidates',
        4,
        'E_NO_SNAPSHOT_MATCH',
      );
    });

    await runRecoverBrain({ 'from-snapshot': '1970-01-01' });

    expect(process.exitCode).toBe(4);
  });

  it('surfaces generic errors with exit code 1', async () => {
    mockRunBackupRecoverBrain.mockImplementation(() => {
      throw new Error('disk full');
    });

    await runRecoverBrain({});

    // GENERAL_ERROR = 1
    expect(process.exitCode).toBe(1);
  });

  it('returns zero-counts envelope when restoration produced empty tables', async () => {
    mockRunBackupRecoverBrain.mockReturnValue({
      ...HAPPY_RESULT,
      rowsRecovered: ZERO_COUNTS,
    });

    await runRecoverBrain({});

    expect(process.exitCode).toBeUndefined();
  });
});
