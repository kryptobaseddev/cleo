/**
 * `cleo nexus projects status` exits with the typed error's own exit code
 * (T12513 review): an unreadable registry exits 75, an unknown device 4 —
 * never a hard-coded mapping. The dispatcher is mocked; no database is opened.
 *
 * @task T12513
 * @task T12512
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDispatchRaw = vi.fn();
const mockCliError = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchRaw: (...args: unknown[]) => mockDispatchRaw(...args),
  dispatchFromCli: vi.fn(),
  maybeEmitDescribe: () => false,
  handleRawError: vi.fn(),
}));

vi.mock('../../renderers/index.js', () => ({
  cliOutput: vi.fn(),
  cliError: (...args: unknown[]) => mockCliError(...args),
  humanInfo: vi.fn(),
  humanWarn: vi.fn(),
}));

import { nexusCommand } from '../nexus.js';

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
interface CommandShape {
  run?: RunFn;
  subCommands?: Record<string, CommandShape>;
}

/** The `projects status` command's run function. */
function statusRun(): RunFn {
  const root = nexusCommand as CommandShape;
  const run = root.subCommands?.['projects']?.subCommands?.['status']?.run;
  if (run === undefined) throw new Error('nexus projects status not found');
  return run;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe('nexus projects status — exit code comes from the typed error', () => {
  it.each([
    ['E_NEXUS_REGISTRY_READ', 75],
    ['E_NEXUS_DEVICE_NOT_FOUND', 4],
  ])('%s exits %i', async (code, exitCode) => {
    mockDispatchRaw.mockResolvedValueOnce({
      success: false,
      error: { code, message: 'failed', exitCode },
    });
    await statusRun()({ args: {}, rawArgs: [] });
    expect(mockDispatchRaw).toHaveBeenCalledWith(
      'query',
      'nexus',
      'projects.fleet',
      expect.any(Object),
    );
    expect(process.exitCode).toBe(exitCode);
    expect(mockCliError).toHaveBeenCalledWith(
      'failed',
      exitCode,
      expect.objectContaining({ name: code }),
      expect.any(Object),
    );
    process.exitCode = undefined;
  });

  it('an error without an exit code exits 1', async () => {
    mockDispatchRaw.mockResolvedValueOnce({ success: false, error: { code: 'E_X', message: 'x' } });
    await statusRun()({ args: {}, rawArgs: [] });
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('a failed --refresh probe exits with its own code before reading', async () => {
    mockDispatchRaw.mockResolvedValueOnce({
      success: false,
      error: { code: 'E_NEXUS_REGISTRY_READ', message: 'failed', exitCode: 75 },
    });
    await statusRun()({ args: { refresh: true }, rawArgs: [] });
    expect(mockDispatchRaw).toHaveBeenCalledTimes(1);
    expect(mockDispatchRaw).toHaveBeenCalledWith(
      'mutate',
      'nexus',
      'projects.status',
      expect.any(Object),
    );
    expect(process.exitCode).toBe(75);
    process.exitCode = undefined;
  });
});
