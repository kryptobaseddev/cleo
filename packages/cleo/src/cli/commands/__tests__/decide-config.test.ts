/**
 * `cleo decide config` wizard path: Ctrl-C is a cancel, not a validation
 * failure (PR #1690 review). Core and the readline IO are mocked.
 *
 * @task T12713
 */

import { WizardInterruptError } from '@cleocode/core/setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWizard = vi.fn(async (): Promise<unknown> => ({}));
const mockCliOutput = vi.fn();
const mockCliError = vi.fn();
const ioStreams: unknown[][] = [];

vi.mock('@cleocode/core/decide/index.js', () => ({
  askDecideDebug: vi.fn(),
  clearDecideConfig: vi.fn(),
  configureDecide: vi.fn(),
  describeDecideCredentials: vi.fn(),
  listDecisionSites: vi.fn(),
  parseDecisionProviderKind: () => undefined,
  probeDecideProvider: vi.fn(),
  resetDecideBudget: vi.fn(),
  runDecideWizard: () => mockWizard(),
  SpendResetRefusedError: class extends Error {},
}));

vi.mock('../../lib/readline-wizard-io.js', () => ({
  ReadlineWizardIO: class {
    constructor(...streams: unknown[]) {
      ioStreams.push(streams);
    }
    close(): void {}
  },
}));

vi.mock('../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  cliError: (...args: unknown[]) => mockCliError(...args),
}));

const { decideCommand } = await import('../decide.js');

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;

/** The `decide config` run handler. */
function configRun(): RunFn {
  const sub = (decideCommand.subCommands as Record<string, unknown> | undefined)?.['config'] as
    | { run?: RunFn }
    | undefined;
  if (!sub?.run) throw new Error('decide config subcommand not found');
  return sub.run;
}

const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockWizard.mockReset();
  mockCliOutput.mockClear();
  mockCliError.mockClear();
  ioStreams.length = 0;
  process.exitCode = undefined;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.exitCode = undefined;
  stderrSpy.mockRestore();
  if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  if (stderrTTY) Object.defineProperty(process.stderr, 'isTTY', stderrTTY);
  else Reflect.deleteProperty(process.stderr, 'isTTY');
});

describe('cleo decide config — wizard interrupt (T12713)', () => {
  it('Ctrl-C exits 130 with a cancelled message, not a validation error', async () => {
    mockWizard.mockRejectedValue(new WizardInterruptError('interrupted by user'));
    await configRun()({ args: {}, rawArgs: [] });
    expect(process.exitCode).toBe(130);
    expect(mockCliError).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
  });

  it('other wizard failures stay validation errors (exit 6)', async () => {
    mockWizard.mockRejectedValue(new Error('probe failed'));
    await configRun()({ args: {}, rawArgs: [] });
    expect(process.exitCode).toBe(6);
    expect(mockCliError.mock.calls[0]?.[0]).toBe('probe failed');
  });

  it('prompts on stderr: the IO is built on stdin + stderr', async () => {
    await configRun()({ args: {}, rawArgs: [] });
    expect(ioStreams[0]).toEqual([process.stdin, process.stderr]);
  });
});
