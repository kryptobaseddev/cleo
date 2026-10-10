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
 * The core helpers are mocked so this test exercises only the CLI command's
 * wiring (arg parsing, envelope shape, exit codes). `tasks`, `brain` and
 * `conduit` all live in the project cleo.db and go through
 * `recoverProjectStore` (T13245); every other role through `runBackupRecover`.
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
const mockRecoverProjectStore = vi.fn();

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
    recoverProjectStore: (...args: unknown[]) => mockRecoverProjectStore(...args),
    PROJECT_STORE_ROLES: new Set(['tasks', 'brain', 'conduit']),
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

describe('cleo backup recover brain — the project store (T10318 backward compat, T13245)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('a dry run plans the live store recovery without the legacy decoy path', async () => {
    mockRecoverProjectStore.mockResolvedValue({ dryRun: true, restored: false });

    await runRecoverBrain({ 'dry-run': true });

    expect(mockRunBackupRecover).not.toHaveBeenCalled();
    expect(mockRecoverProjectStore).toHaveBeenCalledOnce();
    expect(mockRecoverProjectStore.mock.calls[0]?.[0]).toMatchObject({
      role: 'brain',
      projectRoot: '/tmp/test-project',
      dryRun: true,
      force: false,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('plumbs --from-snapshot and --force through', async () => {
    mockRecoverProjectStore.mockResolvedValue({ dryRun: false, restored: true });

    await runRecoverBrain({ 'from-snapshot': '2026-05-22', force: true });

    expect(mockRecoverProjectStore.mock.calls[0]?.[0]).toMatchObject({
      role: 'brain',
      fromSnapshot: '2026-05-22',
      force: true,
      dryRun: false,
    });
  });

  it('surfaces a BackupRecoverError with its exit code', async () => {
    mockRecoverProjectStore.mockRejectedValue(
      new MockBackupRecoverError('No valid brain snapshot', 4, 'E_NO_SNAPSHOT'),
    );

    await runRecoverBrain({});

    expect(process.exitCode).toBe(4);
  });

  it('surfaces generic errors with exit code 1', async () => {
    mockRecoverProjectStore.mockRejectedValue(new Error('disk full'));

    await runRecoverBrain({});

    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — generic `cleo backup recover <role>` surface
// ---------------------------------------------------------------------------

describe('cleo backup recover <role> — generic surface (T10318)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it.each([
    'tasks',
    'conduit',
  ])('the %s leaf recovers the live project store (T13245)', async (role) => {
    mockRecoverProjectStore.mockResolvedValue({ dryRun: false, restored: true });
    const recoverGroup = backupCommand.subCommands?.['recover'] as {
      subCommands: Record<string, CittyLeaf>;
    };
    const leaf = recoverGroup.subCommands[role];
    if (!leaf) throw new Error(`backup recover ${role} leaf not found`);

    await leaf.run({ args: { 'dry-run': false, 'from-snapshot': '', force: false }, rawArgs: [] });

    expect(mockRunBackupRecover).not.toHaveBeenCalled();
    expect(mockRecoverProjectStore).toHaveBeenCalledOnce();
    expect(mockRecoverProjectStore.mock.calls[0]?.[0]).toMatchObject({ role });
  });

  it.each([
    'brain',
    'tasks',
    'conduit',
  ])('the parent run after the %s leaf (citty passes the leaf name as the positional) recovers nothing again', async (role) => {
    await runRecoverGeneric({ role });

    expect(mockRecoverProjectStore).not.toHaveBeenCalled();
    expect(mockRunBackupRecover).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('a non-store role keeps the generic pipeline', async () => {
    mockRunBackupRecover.mockReturnValue({ ...TASKS_HAPPY_RESULT, role: 'nexus' });

    await runRecoverGeneric({ role: 'nexus' });

    expect(mockRecoverProjectStore).not.toHaveBeenCalled();
    expect(mockRunBackupRecover.mock.calls[0]?.[0]?.role).toBe('nexus');
    expect(process.exitCode).toBeUndefined();
  });

  it('surfaces E_VALIDATION with exit code 6 when no role is supplied', async () => {
    await runRecoverGeneric({ role: '' });

    expect(mockRunBackupRecover).not.toHaveBeenCalled();
    expect(mockRecoverProjectStore).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(6);
  });

  it('surfaces E_UNKNOWN_ROLE when an unknown role is supplied', async () => {
    await runRecoverGeneric({ role: 'not-a-real-role' });

    expect(mockRunBackupRecover).not.toHaveBeenCalled();
    expect(typeof process.exitCode).toBe('number');
    expect(process.exitCode).not.toBe(0);
  });

  it('plumbs --dry-run, --from-snapshot, --no-delta into the generic pipeline', async () => {
    mockRunBackupRecover.mockReturnValue({ ...TASKS_HAPPY_RESULT, role: 'nexus', dryRun: true });

    await runRecoverGeneric({
      role: 'nexus',
      'dry-run': true,
      'from-snapshot': '2026-05-22',
      'no-delta': true,
    });

    expect(mockRunBackupRecover.mock.calls[0]?.[0]).toMatchObject({
      role: 'nexus',
      dryRun: true,
      fromSnapshot: '2026-05-22',
      noDelta: true,
    });
  });

  // T12528: real argv `--no-delta` parses to `{ delta: false }`, never `{ 'no-delta': true }`.
  it('plumbs a citty-parsed --no-delta through to the generic pipeline (T12528)', async () => {
    mockRunBackupRecover.mockReturnValue({ ...TASKS_HAPPY_RESULT, role: 'nexus', dryRun: true });
    const { parseArgs } = await import('citty');
    const recoverGroup = backupCommand.subCommands?.['recover'] as {
      args: import('citty').ArgsDef;
      run: CittyLeaf['run'];
    };
    const argv = ['nexus', '--dry-run', '--no-delta'];
    const args = parseArgs(argv, recoverGroup.args);
    expect(args['no-delta']).not.toBe(true);

    await recoverGroup.run({ args: args as RecoverArgs, rawArgs: argv });

    expect(mockRunBackupRecover.mock.calls[0]?.[0]?.noDelta).toBe(true);
  });
});
