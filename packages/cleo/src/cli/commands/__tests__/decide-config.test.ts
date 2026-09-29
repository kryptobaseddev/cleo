/**
 * `cleo decide config` wizard path: Ctrl-C is a cancel, not a validation
 * failure (PR #1690 review). Core and the readline IO are mocked. Also the
 * profile verbs (T12733): `decide use`, `decide profiles`, `config --remove`.
 *
 * @task T12713
 * @task T12733
 */

import { WizardInterruptError } from '@cleocode/core/setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWizard = vi.fn(async (): Promise<unknown> => ({}));
const mockCliOutput = vi.fn();
const mockCliError = vi.fn();
const ioStreams: unknown[][] = [];
const mockUse = vi.fn(async (_name: string): Promise<unknown> => ({}));
const mockRemove = vi.fn(async (_name: string, _use?: string): Promise<unknown> => ({}));
const mockProfiles = vi.fn(async (_opts: unknown): Promise<unknown> => ({}));

class FakeCredentialsError extends Error {}

vi.mock('@cleocode/core/decide/index.js', () => ({
  askDecideDebug: vi.fn(),
  clearDecideConfig: vi.fn(),
  configureDecide: vi.fn(),
  DecideCredentialsError: FakeCredentialsError,
  describeDecideCredentials: vi.fn(),
  listDecideProfilesReport: (opts: unknown) => mockProfiles(opts),
  removeDecideProfile: (name: string, use?: string) => mockRemove(name, use),
  useDecideProfile: (name: string) => mockUse(name),
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

/** A `decide <name>` run handler. */
function subRun(name: string): RunFn {
  const sub = (decideCommand.subCommands as Record<string, unknown> | undefined)?.[name] as
    | { run?: RunFn }
    | undefined;
  if (!sub?.run) throw new Error(`decide ${name} subcommand not found`);
  return sub.run;
}

/** The `decide config` run handler. */
function configRun(): RunFn {
  return subRun('config');
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

describe('cleo decide profile verbs (T12733)', () => {
  it('use <profile> switches through core and renders the list', async () => {
    mockUse.mockResolvedValueOnce({ active: 'jev', profiles: [] });
    await subRun('use')({ args: { profile: 'jev' }, rawArgs: ['jev'] });
    expect(mockUse).toHaveBeenCalledWith('jev');
    expect(mockCliOutput.mock.calls[0]?.[0]).toEqual({ active: 'jev', profiles: [] });
    expect(mockCliOutput.mock.calls[0]?.[1]).toMatchObject({ operation: 'decide.use' });
  });

  it('use <unknown> is a validation error (exit 6)', async () => {
    mockUse.mockRejectedValueOnce(new FakeCredentialsError("no System One profile named 'x'"));
    await subRun('use')({ args: { profile: 'x' }, rawArgs: ['x'] });
    expect(process.exitCode).toBe(6);
    expect(mockCliError.mock.calls[0]?.[0]).toMatch(/no System One profile/);
  });

  it('config --remove passes --use; refusing the active profile exits 6', async () => {
    await configRun()({ args: { remove: 'layahost', use: 'jev' }, rawArgs: [] });
    expect(mockRemove).toHaveBeenCalledWith('layahost', 'jev');
    mockRemove.mockRejectedValueOnce(new FakeCredentialsError("'jev' is the active profile"));
    await configRun()({ args: { remove: 'jev' }, rawArgs: [] });
    expect(process.exitCode).toBe(6);
  });

  it('profiles probes only with --probe', async () => {
    await subRun('profiles')({ args: {}, rawArgs: [] });
    await subRun('profiles')({ args: { probe: true, 'timeout-ms': '500' }, rawArgs: [] });
    expect(mockProfiles.mock.calls).toEqual([
      [{ probe: false, timeoutMs: undefined }],
      [{ probe: true, timeoutMs: 500 }],
    ]);
  });
});
