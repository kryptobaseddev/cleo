/**
 * `cleo decide sites` handler — flag validation and dispatch to core (T12662).
 *
 * The handler is thin (arch gate 6): it narrows `--rung` / `--mode` to the
 * contract enums, rejects anything else with exit 6, and renders what
 * `listDecisionSites` returns. Core is mocked.
 *
 * @task T12662
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockList = vi.fn(async () => ({ providerConfigured: false, total: 0, sites: [] }));
const mockCliOutput = vi.fn();
const mockCliError = vi.fn();

vi.mock('@cleocode/core/decide/index.js', () => ({
  askDecideDebug: vi.fn(),
  clearDecideConfig: vi.fn(),
  configureDecide: vi.fn(),
  describeDecideCredentials: vi.fn(),
  listDecisionSites: (...args: unknown[]) => mockList(...args),
  probeDecideProvider: vi.fn(),
}));

vi.mock('../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  cliError: (...args: unknown[]) => mockCliError(...args),
}));

const { decideCommand } = await import('../decide.js');

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;

/** The `decide sites` run handler. */
function sitesRun(): RunFn {
  const sub = (decideCommand.subCommands as Record<string, unknown> | undefined)?.['sites'] as
    | { run?: RunFn }
    | undefined;
  if (!sub?.run) throw new Error('decide sites subcommand not found');
  return sub.run;
}

beforeEach(() => {
  mockList.mockClear();
  mockCliOutput.mockClear();
  mockCliError.mockClear();
  process.exitCode = undefined;
});

afterEach(() => {
  // The handler sets exit code 6 on bad flags; never leak it into the runner.
  process.exitCode = undefined;
});

describe('cleo decide sites (T12662)', () => {
  it('passes the filters to listDecisionSites and renders the result', async () => {
    await sitesRun()({
      args: { rung: 'system-one', mode: 'shadow', id: 'tasks.duplicate-detection', evidence: true },
      rawArgs: [],
    });
    expect(mockList).toHaveBeenCalledWith({
      rung: 'system-one',
      mode: 'shadow',
      id: 'tasks.duplicate-detection',
      evidenceOnly: true,
    });
    expect(mockCliOutput).toHaveBeenCalledWith(
      { providerConfigured: false, total: 0, sites: [] },
      { command: 'decide', operation: 'decide.sites' },
    );
  });

  it('rejects an unknown rung with exit 6', async () => {
    await sitesRun()({ args: { rung: 'oracle' }, rawArgs: [] });
    expect(mockList).not.toHaveBeenCalled();
    expect(mockCliError.mock.calls[0]?.[0]).toMatch(/unknown rung 'oracle'/);
    expect(process.exitCode).toBe(6);
  });

  it('rejects an unknown mode with exit 6', async () => {
    await sitesRun()({ args: { mode: 'maybe' }, rawArgs: [] });
    expect(mockList).not.toHaveBeenCalled();
    expect(mockCliError.mock.calls[0]?.[0]).toMatch(/unknown mode 'maybe'/);
    expect(process.exitCode).toBe(6);
  });
});
