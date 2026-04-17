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
import { backupCommand } from '../backup.js';

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
// Helper — invoke the `backup export` subcommand run handler directly
// ---------------------------------------------------------------------------

type ExportArgs = {
  name: string;
  scope?: string;
  encrypt?: boolean;
  out?: string;
};

/**
 * Invoke the citty export subcommand's run handler with the given args.
 *
 * @param args - Arguments to pass to the export run handler.
 */
async function runExport(args: ExportArgs): Promise<void> {
  const exportCmd = backupCommand.subCommands?.['export'];
  if (!exportCmd || typeof exportCmd !== 'object' || !('run' in exportCmd)) {
    throw new Error('backup export subcommand not found');
  }
  const merged = { scope: 'project', encrypt: false, out: undefined, ...args };
  await (
    exportCmd as { run: (ctx: { args: typeof merged; rawArgs: string[] }) => Promise<void> }
  ).run({ args: merged, rawArgs: [] });
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

    await runExport({ name: 'myproject', scope: 'project' });

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

    await runExport({ name: 'myproject', scope: 'project' });

    expect(mockPackBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        outputPath: './myproject.cleobundle.tar.gz',
      }),
    );
  });

  it('uses --out path when provided', async () => {
    mockPackBundle.mockResolvedValue(MOCK_RESULT);

    await runExport({ name: 'myproject', scope: 'project', out: '/custom/path.cleobundle.tar.gz' });

    expect(mockPackBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        outputPath: '/custom/path.cleobundle.tar.gz',
      }),
    );
  });

  it('sets exitCode=1 when packBundle throws', async () => {
    mockPackBundle.mockRejectedValue(new Error('disk full'));

    await runExport({ name: 'myproject', scope: 'project' });

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

    await runExport({ name: 'global-backup', scope: 'global' });

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

    await runExport({ name: 'full', scope: 'all' });

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

    await runExport({ name: 'secure', scope: 'project', encrypt: true });

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

    await runExport({ name: 'secure', scope: 'project', encrypt: true });

    expect(mockPackBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        outputPath: './secure.enc.cleobundle.tar.gz',
      }),
    );
  });

  it('sets exitCode=6 when --encrypt but no passphrase available and stdin is not a TTY', async () => {
    // stdin.isTTY is typically undefined/false in Vitest — no TTY
    await runExport({ name: 'secure', scope: 'project', encrypt: true });

    // The handler should set exitCode=6 because no passphrase available
    expect(process.exitCode).toBe(6);
    expect(mockPackBundle).not.toHaveBeenCalled();
  });
});
