/**
 * Unit tests for T361: cleo backup import <bundle>
 *
 * Verifies the `backup import` subcommand action handler in backup.ts:
 *   - pre-check aborts with E_DATA_EXISTS (78) when live files found and --force absent
 *   - --force bypasses the pre-check
 *   - unpackBundle is called with the correct passphrase from CLEO_BACKUP_PASSPHRASE
 *   - sets exit code 6 when encrypted bundle and no passphrase available (no TTY, no env var)
 *   - unpackBundle error propagates with BundleError exit code
 *   - DBs are atomically restored (copy + rename); WAL sidecars cleared
 *   - A/B regenerate-and-compare runs for each JSON file
 *   - conflict report is written after restore
 *   - raw JSON files are copied to .cleo/restore-imported/
 *   - staging dir is cleaned up after successful import
 *   - staging dir is cleaned up even when an error occurs mid-flow
 *
 * All @cleocode/core/internal calls are mocked — no real SQLite is touched.
 * File-system access is intercepted via vi.spyOn on node:fs methods.
 * Pattern mirrors backup-export.test.ts.
 *
 * @task T361
 * @epic T311
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShimCommand as Command } from '../../commander-shim.js';
import { registerBackupCommand } from '../backup.js';

// ---------------------------------------------------------------------------
// Mock @cleocode/core/internal — prevents tar / sqlite / lafs chain
// ---------------------------------------------------------------------------

const mockUnpackBundle = vi.fn();
const mockCleanupStaging = vi.fn();
const mockGetProjectRoot = vi.fn(() => '/tmp/test-project');
const mockGetCleoHome = vi.fn(() => '/tmp/test-cleo-home');
const mockGetCleoVersion = vi.fn(() => '2026.4.13');
const mockRegenerateConfigJson = vi.fn(() => ({
  filename: 'config.json',
  content: { version: 1 },
}));
const mockRegenerateProjectInfoJson = vi.fn(() => ({
  filename: 'project-info.json',
  content: { name: 'test' },
}));
const mockRegenerateProjectContextJson = vi.fn(() => ({
  filename: 'project-context.json',
  content: { schemaVersion: '1.0.0' },
}));
const mockRegenerateAndCompare = vi.fn((input: { filename: string }) => ({
  filename: input.filename,
  localGenerated: {},
  imported: {},
  classifications: [],
  applied: {},
  conflictCount: 0,
}));
const mockBuildConflictReport = vi.fn(() => '# Conflict Report\n');
const mockWriteConflictReport = vi.fn(() => '/tmp/test-project/.cleo/restore-conflicts.md');

/** Minimal BundleError class mirroring the real one in backup-unpack.ts. */
class MockBundleError extends Error {
  constructor(
    public readonly code: number,
    public readonly codeName: string,
    message: string,
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

vi.mock('@cleocode/core/internal', () => ({
  unpackBundle: (...args: unknown[]) => mockUnpackBundle(...args),
  cleanupStaging: (...args: unknown[]) => mockCleanupStaging(...args),
  getProjectRoot: () => mockGetProjectRoot(),
  getCleoHome: () => mockGetCleoHome(),
  getCleoVersion: () => mockGetCleoVersion(),
  regenerateConfigJson: (...args: unknown[]) => mockRegenerateConfigJson(...args),
  regenerateProjectInfoJson: (...args: unknown[]) => mockRegenerateProjectInfoJson(...args),
  regenerateProjectContextJson: (...args: unknown[]) => mockRegenerateProjectContextJson(...args),
  regenerateAndCompare: (...args: unknown[]) => mockRegenerateAndCompare(...args),
  buildConflictReport: (...args: unknown[]) => mockBuildConflictReport(...args),
  writeConflictReport: (...args: unknown[]) => mockWriteConflictReport(...args),
  BundleError: MockBundleError,
}));

// ---------------------------------------------------------------------------
// Mock dispatchFromCli — prevents @cleocode/lafs → @a2a-js/sdk chain
// ---------------------------------------------------------------------------

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helper — default unpackBundle result
// ---------------------------------------------------------------------------

const STAGING_DIR = '/tmp/cleo-unpack-test123';

const MOCK_MANIFEST = {
  $schema: './schemas/manifest-v1.json',
  manifestVersion: '1.0.0',
  backup: {
    createdAt: '2026-04-08T00:00:00Z',
    createdBy: 'cleo v2026.4.13',
    scope: 'project' as const,
    machineFingerprint: 'abc'.repeat(20) + 'ab',
    cleoVersion: '2026.4.13',
    encrypted: false,
  },
  databases: [
    {
      filename: 'databases/tasks.db',
      name: 'tasks',
      schemaVersion: '20260327000000',
      sha256: 'a'.repeat(64),
      size: 1024,
    },
    {
      filename: 'databases/brain.db',
      name: 'brain',
      schemaVersion: '20260321000001',
      sha256: 'b'.repeat(64),
      size: 512,
    },
  ],
  json: [
    { filename: 'json/config.json', sha256: 'c'.repeat(64), size: 256 },
    { filename: 'json/project-info.json', sha256: 'd'.repeat(64), size: 128 },
    { filename: 'json/project-context.json', sha256: 'e'.repeat(64), size: 64 },
  ],
  globalFiles: [],
  integrity: {
    algorithm: 'sha256',
    checksumsFile: 'checksums.sha256',
    manifestHash: 'f'.repeat(64),
  },
};

const MOCK_UNPACK_RESULT = {
  stagingDir: STAGING_DIR,
  manifest: MOCK_MANIFEST,
  verified: { encryptionAuth: true, manifestSchema: true, checksums: true, sqliteIntegrity: true },
  warnings: [],
};

// ---------------------------------------------------------------------------
// Helper — extract the `backup import` action handler
// ---------------------------------------------------------------------------

/**
 * Build the command tree and return the action registered on `backup import`.
 *
 * @returns The async action handler for testing.
 */
function getImportAction(): (bundle: string, opts: Record<string, unknown>) => Promise<void> {
  const program = new Command();
  registerBackupCommand(program);
  const backupCmd = program.commands.find((c) => c.name() === 'backup');
  if (!backupCmd) throw new Error('backup command not registered');
  const sub = backupCmd.commands.find((c) => c.name() === 'import');
  if (!sub?._action) throw new Error('backup import subcommand has no action registered');
  return sub._action as (bundle: string, opts: Record<string, unknown>) => Promise<void>;
}

// ---------------------------------------------------------------------------
// fs spy helpers
// ---------------------------------------------------------------------------

/** All fs spies collected for restoration in afterEach. */
type FsSpies = {
  existsSync: ReturnType<typeof vi.spyOn>;
  mkdirSync: ReturnType<typeof vi.spyOn>;
  copyFileSync: ReturnType<typeof vi.spyOn>;
  renameSync: ReturnType<typeof vi.spyOn>;
  openSync: ReturnType<typeof vi.spyOn>;
  readSync: ReturnType<typeof vi.spyOn>;
  closeSync: ReturnType<typeof vi.spyOn>;
  readFileSync: ReturnType<typeof vi.spyOn>;
  writeFileSync: ReturnType<typeof vi.spyOn>;
  unlinkSync: ReturnType<typeof vi.spyOn>;
};

let spies: FsSpies;

/**
 * Create a fresh set of fs spies with safe defaults for a standard
 * unencrypted-bundle import against a fresh target.
 *
 * @param existingFiles - Optional list of paths that should appear to exist.
 */
function setupFsSpies(existingFiles: string[] = []): FsSpies {
  const staged = new Set(
    [
      ...MOCK_MANIFEST.databases.map((d) => path.join(STAGING_DIR, d.filename)),
      ...MOCK_MANIFEST.json.map((j) => path.join(STAGING_DIR, j.filename)),
    ],
  );

  spies = {
    existsSync: vi
      .spyOn(fs, 'existsSync')
      .mockImplementation((p) =>
        staged.has(String(p)) || existingFiles.some((f) => String(p).includes(f)),
      ),
    mkdirSync: vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined),
    copyFileSync: vi.spyOn(fs, 'copyFileSync').mockReturnValue(undefined),
    renameSync: vi.spyOn(fs, 'renameSync').mockReturnValue(undefined),
    openSync: vi.spyOn(fs, 'openSync').mockReturnValue(42 as ReturnType<typeof fs.openSync>),
    readSync: vi
      .spyOn(fs, 'readSync')
      .mockImplementation(
        (_fd: number, buf: Buffer | NodeJS.ArrayBufferView, ..._rest: unknown[]) => {
          // Unencrypted header by default
          (buf as Buffer).write('NOTENCR1', 0, 'utf8');
          return 8;
        },
      ),
    closeSync: vi.spyOn(fs, 'closeSync').mockReturnValue(undefined),
    readFileSync: vi
      .spyOn(fs, 'readFileSync')
      .mockImplementation((p) => {
        if (String(p).endsWith('.json')) return JSON.stringify({ version: 1 });
        return Buffer.alloc(0);
      }),
    writeFileSync: vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined),
    unlinkSync: vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined),
  };
  return spies;
}

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  delete process.env['CLEO_BACKUP_PASSPHRASE'];
  mockUnpackBundle.mockResolvedValue(MOCK_UNPACK_RESULT);
  setupFsSpies(); // fresh target by default
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pre-check tests
// ---------------------------------------------------------------------------

describe('T361 cleo backup import — pre-check (E_DATA_EXISTS)', () => {
  it('aborts with exit code 78 when tasks.db exists and --force absent', async () => {
    vi.restoreAllMocks();
    setupFsSpies(['.cleo/tasks.db']);

    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    expect(process.exitCode).toBe(78);
    expect(mockUnpackBundle).not.toHaveBeenCalled();
  });

  it('lists the conflicting files in the error output', async () => {
    vi.restoreAllMocks();
    setupFsSpies(['.cleo/tasks.db', '.cleo/brain.db']);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('E_DATA_EXISTS');
    expect(process.exitCode).toBe(78);
    stderrSpy.mockRestore();
  });

  it('proceeds without aborting when --force is set even with existing files', async () => {
    vi.restoreAllMocks();
    setupFsSpies(['.cleo/tasks.db']);

    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', { force: true });

    expect(process.exitCode).toBeUndefined();
    expect(mockUnpackBundle).toHaveBeenCalledOnce();
  });

  it('proceeds on a fresh target with no existing files', async () => {
    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    expect(mockUnpackBundle).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Encryption / passphrase tests
// ---------------------------------------------------------------------------

describe('T361 cleo backup import — encryption detection', () => {
  it('calls unpackBundle WITHOUT passphrase for unencrypted bundle', async () => {
    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    expect(mockUnpackBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        bundlePath: '/some/bundle.cleobundle.tar.gz',
        passphrase: undefined,
      }),
    );
  });

  it('reads CLEO_BACKUP_PASSPHRASE and passes to unpackBundle for encrypted bundle', async () => {
    // Simulate encrypted header
    spies.readSync.mockImplementation(
      (_fd: number, buf: Buffer | NodeJS.ArrayBufferView, ..._rest: unknown[]) => {
        (buf as Buffer).write('CLEOENC1', 0, 'utf8');
        return 8;
      },
    );
    process.env['CLEO_BACKUP_PASSPHRASE'] = 'my-secret-pass';

    const action = getImportAction();
    await action('/some/bundle.enc.cleobundle.tar.gz', {});

    expect(mockUnpackBundle).toHaveBeenCalledWith(
      expect.objectContaining({ passphrase: 'my-secret-pass' }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('sets exit code 6 when bundle is encrypted, no env var, stdin not TTY', async () => {
    spies.readSync.mockImplementation(
      (_fd: number, buf: Buffer | NodeJS.ArrayBufferView, ..._rest: unknown[]) => {
        (buf as Buffer).write('CLEOENC1', 0, 'utf8');
        return 8;
      },
    );
    // process.stdin.isTTY is falsy in Vitest

    const action = getImportAction();
    await action('/some/bundle.enc.cleobundle.tar.gz', {});

    expect(process.exitCode).toBe(6);
    expect(mockUnpackBundle).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// unpackBundle error propagation
// ---------------------------------------------------------------------------

describe('T361 cleo backup import — unpackBundle error propagation', () => {
  it('exits with BundleError code (70) when decryption fails', async () => {
    mockUnpackBundle.mockRejectedValue(
      new MockBundleError(70, 'E_BUNDLE_DECRYPT', 'bad passphrase'),
    );

    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    expect(process.exitCode).toBe(70);
  });

  it('exits with BundleError code (72) when checksum mismatch', async () => {
    mockUnpackBundle.mockRejectedValue(
      new MockBundleError(72, 'E_CHECKSUM_MISMATCH', 'sha256 mismatch'),
    );

    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    expect(process.exitCode).toBe(72);
  });

  it('exits with code 1 on unexpected non-BundleError', async () => {
    mockUnpackBundle.mockRejectedValue(new Error('unexpected disk error'));

    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DB restore
// ---------------------------------------------------------------------------

describe('T361 cleo backup import — DB atomic restore', () => {
  it('copies each DB from staging to a tmp path then renames to final destination', async () => {
    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    // copyFileSync called for the two DBs (src → tmp)
    const copySrcs = (spies.copyFileSync.mock.calls as Array<[string, string]>).map((c) => c[0]);
    expect(copySrcs.some((s) => s.endsWith('tasks.db'))).toBe(true);
    expect(copySrcs.some((s) => s.endsWith('brain.db'))).toBe(true);

    // renameSync called (tmp → final) for the two DBs
    const renameDsts = (spies.renameSync.mock.calls as Array<[string, string]>).map((c) => c[1]);
    expect(renameDsts.some((d) => d.endsWith('tasks.db'))).toBe(true);
    expect(renameDsts.some((d) => d.endsWith('brain.db'))).toBe(true);
  });

  it('routes nexus.db and signaldock.db to cleoHome (global tier)', async () => {
    const globalManifest = {
      ...MOCK_MANIFEST,
      databases: [
        {
          filename: 'databases/nexus.db',
          name: 'nexus',
          schemaVersion: 'unknown',
          sha256: 'a'.repeat(64),
          size: 512,
        },
        {
          filename: 'databases/signaldock.db',
          name: 'signaldock',
          schemaVersion: 'unknown',
          sha256: 'b'.repeat(64),
          size: 256,
        },
      ],
      json: [],
    };
    mockUnpackBundle.mockResolvedValue({ ...MOCK_UNPACK_RESULT, manifest: globalManifest });

    // Update existsSync to handle the global manifest files
    const staged = new Set([
      path.join(STAGING_DIR, 'databases/nexus.db'),
      path.join(STAGING_DIR, 'databases/signaldock.db'),
    ]);
    spies.existsSync.mockImplementation((p) => staged.has(String(p)));

    const action = getImportAction();
    await action('/some/global.cleobundle.tar.gz', {});

    const renameDsts = (spies.renameSync.mock.calls as Array<[string, string]>).map((c) => c[1]);

    expect(
      renameDsts.some((p) => p.includes('/tmp/test-cleo-home') && p.endsWith('nexus.db')),
    ).toBe(true);
    expect(
      renameDsts.some((p) => p.includes('/tmp/test-cleo-home') && p.endsWith('signaldock.db')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A/B regenerate-and-compare
// ---------------------------------------------------------------------------

describe('T361 cleo backup import — A/B regenerate-and-compare', () => {
  it('calls regenerateAndCompare for each JSON file in the manifest', async () => {
    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    expect(mockRegenerateAndCompare).toHaveBeenCalledTimes(3);
    const filenames = mockRegenerateAndCompare.mock.calls.map(
      (c) => (c[0] as { filename: string }).filename,
    );
    expect(filenames).toContain('config.json');
    expect(filenames).toContain('project-info.json');
    expect(filenames).toContain('project-context.json');
  });

  it('writes applied merge to .cleo/<filename>', async () => {
    mockRegenerateAndCompare.mockReturnValue({
      filename: 'config.json',
      localGenerated: { a: 1 },
      imported: { a: 2 },
      classifications: [],
      applied: { a: 1 },
      conflictCount: 0,
    });

    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    const writeCalls = spies.writeFileSync.mock.calls as Array<[string, string, string]>;
    expect(writeCalls.some((c) => String(c[0]).includes(path.join('.cleo', 'config.json')))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Conflict report
// ---------------------------------------------------------------------------

describe('T361 cleo backup import — conflict report', () => {
  it('calls buildConflictReport with correct machine fingerprints and schema warnings', async () => {
    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    expect(mockBuildConflictReport).toHaveBeenCalledOnce();
    const arg = mockBuildConflictReport.mock.calls[0][0] as {
      sourceMachineFingerprint: string;
      cleoVersion: string;
    };
    expect(arg.sourceMachineFingerprint).toBe(MOCK_MANIFEST.backup.machineFingerprint);
    expect(arg.cleoVersion).toBe('2026.4.13');
  });

  it('calls writeConflictReport to persist the report', async () => {
    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    expect(mockWriteConflictReport).toHaveBeenCalledOnce();
    expect(mockWriteConflictReport).toHaveBeenCalledWith('/tmp/test-project', expect.any(String));
  });

  it('emits finalize reminder to stderr when totalConflicts > 0', async () => {
    mockRegenerateAndCompare.mockReturnValue({
      filename: 'config.json',
      localGenerated: {},
      imported: {},
      classifications: [],
      applied: {},
      conflictCount: 2,
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('cleo restore finalize');
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// restore-imported directory
// ---------------------------------------------------------------------------

describe('T361 cleo backup import — .cleo/restore-imported', () => {
  it('copies raw imported JSON files to .cleo/restore-imported/', async () => {
    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    const importedDir = path.join('/tmp/test-project', '.cleo', 'restore-imported');
    const copyCalls = spies.copyFileSync.mock.calls as Array<[string, string]>;

    // Should have a copy from staging json/ to restore-imported/
    expect(
      copyCalls.some(
        (c) =>
          String(c[0]).includes(path.join(STAGING_DIR, 'json')) &&
          String(c[1]).startsWith(importedDir),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Staging cleanup
// ---------------------------------------------------------------------------

describe('T361 cleo backup import — staging cleanup', () => {
  it('calls cleanupStaging after a successful import', async () => {
    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    expect(mockCleanupStaging).toHaveBeenCalledOnce();
    expect(mockCleanupStaging).toHaveBeenCalledWith(STAGING_DIR);
  });

  it('calls cleanupStaging even when DB copy throws mid-flow', async () => {
    spies.copyFileSync.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const action = getImportAction();
    await expect(action('/some/bundle.cleobundle.tar.gz', {})).resolves.not.toThrow();

    expect(mockCleanupStaging).toHaveBeenCalledOnce();
    expect(mockCleanupStaging).toHaveBeenCalledWith(STAGING_DIR);
  });

  it('does NOT call cleanupStaging when unpackBundle fails (unpackBundle cleans up internally)', async () => {
    mockUnpackBundle.mockRejectedValue(
      new MockBundleError(74, 'E_MANIFEST_MISSING', 'no manifest'),
    );

    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    // cleanupStaging should NOT be called — unpackBundle already cleaned up
    expect(mockCleanupStaging).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// stdout output shape
// ---------------------------------------------------------------------------

describe('T361 cleo backup import — stdout output shape', () => {
  it('writes valid JSON to stdout on success', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const action = getImportAction();
    await action('/some/bundle.cleobundle.tar.gz', {});

    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(written.trim()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect((parsed['r'] as Record<string, unknown>)['imported']).toBe(
      '/some/bundle.cleobundle.tar.gz',
    );
    expect(typeof (parsed['r'] as Record<string, unknown>)['dbsRestored']).toBe('number');
    stdoutSpy.mockRestore();
  });
});
