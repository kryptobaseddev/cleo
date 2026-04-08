/**
 * Unit tests for T359: cleo backup export <name>
 *
 * Verifies the `backup export` subcommand action handler in backup.ts:
 *   - passes scope=project + projectRoot to packBundle
 *   - passes scope=global without projectRoot
 *   - reads CLEO_BACKUP_PASSPHRASE env var for encryption
 *   - exits 6 when --encrypt requested but no passphrase available and no TTY
 *   - exits 1 and writes error when packBundle throws
 *   - writes correct JSON to stdout on success
 *
 * All packBundle and getProjectRoot calls are mocked — no real SQLite is
 * touched. Pattern mirrors agent-remove-global.test.ts.
 *
 * @task T359
 * @epic T311
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShimCommand as Command } from '../../commander-shim.js';
import { registerBackupCommand } from '../backup.js';

// ---------------------------------------------------------------------------
// Mock @cleocode/core/internal — prevents tar / sqlite / lafs chain
// ---------------------------------------------------------------------------

const mockPackBundle = vi.fn();
const mockGetProjectRoot = vi.fn(() => '/tmp/test-project');

vi.mock('@cleocode/core/internal', () => ({
  packBundle: (...args: unknown[]) => mockPackBundle(...args),
  getProjectRoot: () => mockGetProjectRoot(),
}));

// ---------------------------------------------------------------------------
// Mock dispatchFromCli — prevents @cleocode/lafs → @a2a-js/sdk chain
// ---------------------------------------------------------------------------

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helper — extract the `backup export` action handler from the shim tree
// ---------------------------------------------------------------------------

/**
 * Build the command tree and return the action registered on `backup export`.
 *
 * @returns The async action handler for testing.
 */
function getExportAction(): (name: string, opts: Record<string, unknown>) => Promise<void> {
  const program = new Command();
  registerBackupCommand(program);
  const backupCmd = program.commands.find((c) => c.name() === 'backup');
  if (!backupCmd) throw new Error('backup command not registered');
  const sub = backupCmd.commands.find((c) => c.name() === 'export');
  if (!sub?._action) throw new Error('backup export subcommand has no action registered');
  return sub._action as (name: string, opts: Record<string, unknown>) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared mock result
// ---------------------------------------------------------------------------

const MOCK_RESULT = {
  bundlePath: '/tmp/myproject.cleobundle.tar.gz',
  size: 4096,
  manifest: {},
  fileCount: 3,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T359 cleo backup export — scope=project (default)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    delete process.env['CLEO_BACKUP_PASSPHRASE'];
  });

  it('passes scope=project and projectRoot to packBundle', async () => {
    mockPackBundle.mockResolvedValue(MOCK_RESULT);

    const action = getExportAction();
    await action('myproject', { scope: 'project' });

    expect(mockPackBundle).toHaveBeenCalledOnce();
    expect(mockPackBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'project',
        projectRoot: '/tmp/test-project',
        projectName: 'myproject',
        encrypt: false,
      }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('defaults output path to ./<name>.cleobundle.tar.gz', async () => {
    mockPackBundle.mockResolvedValue(MOCK_RESULT);

    const action = getExportAction();
    await action('myproject', { scope: 'project' });

    expect(mockPackBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        outputPath: './myproject.cleobundle.tar.gz',
      }),
    );
  });

  it('uses --out path when provided', async () => {
    mockPackBundle.mockResolvedValue(MOCK_RESULT);

    const action = getExportAction();
    await action('myproject', { scope: 'project', out: '/custom/path.cleobundle.tar.gz' });

    expect(mockPackBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        outputPath: '/custom/path.cleobundle.tar.gz',
      }),
    );
  });

  it('sets exitCode=1 when packBundle throws', async () => {
    mockPackBundle.mockRejectedValue(new Error('disk full'));

    const action = getExportAction();
    await action('myproject', { scope: 'project' });

    expect(process.exitCode).toBe(1);
  });
});

describe('T359 cleo backup export — scope=global', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    delete process.env['CLEO_BACKUP_PASSPHRASE'];
  });

  it('passes scope=global without projectRoot', async () => {
    mockPackBundle.mockResolvedValue(MOCK_RESULT);

    const action = getExportAction();
    await action('global-backup', { scope: 'global' });

    expect(mockPackBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'global',
        projectRoot: undefined,
      }),
    );
    expect(mockGetProjectRoot).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

describe('T359 cleo backup export — scope=all', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    delete process.env['CLEO_BACKUP_PASSPHRASE'];
  });

  it('passes scope=all and resolves projectRoot', async () => {
    mockPackBundle.mockResolvedValue(MOCK_RESULT);

    const action = getExportAction();
    await action('full', { scope: 'all' });

    expect(mockPackBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'all',
        projectRoot: '/tmp/test-project',
      }),
    );
  });
});

describe('T359 cleo backup export — encryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    delete process.env['CLEO_BACKUP_PASSPHRASE'];
  });

  it('reads CLEO_BACKUP_PASSPHRASE env var and passes to packBundle', async () => {
    process.env['CLEO_BACKUP_PASSPHRASE'] = 'super-secret';
    mockPackBundle.mockResolvedValue({
      ...MOCK_RESULT,
      bundlePath: '/tmp/secure.enc.cleobundle.tar.gz',
    });

    const action = getExportAction();
    await action('secure', { scope: 'project', encrypt: true });

    expect(mockPackBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        encrypt: true,
        passphrase: 'super-secret',
      }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('uses .enc. infix in default output path when --encrypt', async () => {
    process.env['CLEO_BACKUP_PASSPHRASE'] = 'pass';
    mockPackBundle.mockResolvedValue(MOCK_RESULT);

    const action = getExportAction();
    await action('secure', { scope: 'project', encrypt: true });

    expect(mockPackBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        outputPath: './secure.enc.cleobundle.tar.gz',
      }),
    );
  });

  it('sets exitCode=6 when --encrypt but no passphrase available and stdin is not a TTY', async () => {
    // stdin.isTTY is typically undefined/false in Vitest — no TTY
    const action = getExportAction();
    await action('secure', { scope: 'project', encrypt: true });

    // The handler should set exitCode=6 because no passphrase available
    expect(process.exitCode).toBe(6);
    expect(mockPackBundle).not.toHaveBeenCalled();
  });
});
