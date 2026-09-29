/**
 * `cleo decide bench` handler — flag parsing and dispatch to core (T12495).
 *
 * The handler is thin (arch gate 6): it splits the comma lists, reads the
 * numeric flags and hands everything to `runDecideBenchOperation`; a
 * `DecideBenchInputError` becomes a validation error (exit 6). Core is mocked,
 * so no store is read and no provider is contacted.
 *
 * @task T12495
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeBenchInputError extends Error {
  readonly fix = 'cleo decide bench --profiles layahost,jev';
}

const mockRun = vi.fn(async (_input: Record<string, unknown>) => ({ ran: false }));
const mockCliOutput = vi.fn();
const mockCliError = vi.fn();

vi.mock('@cleocode/core/decide/bench/index.js', () => ({
  DecideBenchInputError: FakeBenchInputError,
  runDecideBenchOperation: (input: Record<string, unknown>) => mockRun(input),
}));

vi.mock('../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  cliError: (...args: unknown[]) => mockCliError(...args),
}));

const { decideCommand } = await import('../decide.js');

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;

/** The `decide bench` run handler. */
function benchRun(): RunFn {
  const sub = (decideCommand.subCommands as Record<string, unknown> | undefined)?.['bench'] as
    | { run?: RunFn }
    | undefined;
  if (!sub?.run) throw new Error('decide bench subcommand not found');
  return sub.run;
}

beforeEach(() => {
  mockRun.mockClear();
  mockCliOutput.mockClear();
  mockCliError.mockClear();
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe('cleo decide bench (T12495)', () => {
  it('passes parsed flags to the core operation and renders its summary', async () => {
    await benchRun()({
      args: {
        profiles: 'layahost, jev',
        sites: 'duplicateDetection,decisionContradiction',
        'max-usd': '2.5',
        runs: '3',
        out: '/tmp/bench',
        'batch-size': '8',
        corrections: 'c.json',
        seed: '7',
      },
      rawArgs: [],
    });
    expect(mockRun).toHaveBeenCalledWith({
      profiles: ['layahost', 'jev'],
      sites: ['duplicateDetection', 'decisionContradiction'],
      sampleOnly: false,
      correctionsPath: 'c.json',
      maxUsd: 2.5,
      runs: 3,
      outDir: '/tmp/bench',
      batchSize: 8,
      rebuild: false,
      seed: 7,
    });
    expect(mockCliOutput).toHaveBeenCalledWith(
      { ran: false },
      { command: 'decide', operation: 'decide.bench' },
    );
  });

  it('maps an input error to exit 6 with its fix', async () => {
    mockRun.mockRejectedValueOnce(new FakeBenchInputError('no providers to compare'));
    await benchRun()({ args: {}, rawArgs: [] });
    expect(mockCliError.mock.calls[0]?.[0]).toBe('no providers to compare');
    expect(process.exitCode).toBe(6);
  });
});
