/**
 * `--no-<flag>` regression tests for the dispatch-routed commands (T12528).
 *
 * citty parses `--no-<name>` as `{ <name>: false }` and never sets
 * `'no-<name>'`, so each of these handlers — which read `args['no-<name>']` —
 * silently ignored its opt-out. Every case parses REAL argv with citty's own
 * `parseArgs` against the command's real `args` definition, runs the real
 * handler, and asserts on what reached `dispatchFromCli`. A hand-built
 * `{ 'no-x': true }` object would encode the very mistake under test.
 *
 * @task T12528
 */

import { type ArgsDef, type CommandDef, parseArgs } from 'citty';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDispatchFromCli = vi.fn();
const mockHumanLine = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
  dispatchRaw: vi.fn(),
  handleRawError: vi.fn(),
  maybeEmitDescribe: () => false,
}));

vi.mock('../../renderers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../renderers/index.js')>()),
  humanLine: (...args: unknown[]) => mockHumanLine(...args),
}));

import { dashCommand } from '../dash.js';
import { diagnosticsCommand } from '../diagnostics.js';
import { importTasksCommand } from '../import-tasks.js';
import { pivotCommand } from '../pivot.js';
import { relatesCommand } from '../relates.js';
import { releaseCommand } from '../release.js';
import { safestopCommand } from '../safestop.js';

/** Minimal runnable command shape — citty types `run`/`args` as optional/resolvable. */
interface RunnableCommand {
  args?: ArgsDef;
  run?: (ctx: { args: unknown; rawArgs: string[]; cmd: unknown }) => Promise<void> | void;
  subCommands?: Record<string, RunnableCommand>;
}

/** Resolve a (possibly nested) subcommand by path. */
function resolveCommand(root: CommandDef, path: readonly string[]): RunnableCommand {
  let cmd = root as unknown as RunnableCommand;
  for (const name of path) {
    const next = cmd.subCommands?.[name];
    if (!next) throw new Error(`subcommand ${path.join(' ')} missing`);
    cmd = next;
  }
  return cmd;
}

/** Parse argv with citty against the command's real args and run its handler. */
async function runParsed(root: CommandDef, path: readonly string[], argv: string[]): Promise<void> {
  const cmd = resolveCommand(root, path);
  if (!cmd.args || !cmd.run) throw new Error(`${path.join(' ')} has no args/run`);
  const args = parseArgs(argv, cmd.args);
  await cmd.run({ args, rawArgs: argv, cmd });
}

/** Params object passed to the first dispatchFromCli call. */
function dispatchedParams(): Record<string, unknown> {
  const call = mockDispatchFromCli.mock.calls[0];
  if (!call) throw new Error('dispatchFromCli was not called');
  return call[3] as Record<string, unknown>;
}

beforeEach(() => {
  mockDispatchFromCli.mockReset();
  mockHumanLine.mockReset();
});

describe('cleo dash --no-hygiene', () => {
  it('suppresses the hygiene note', async () => {
    await runParsed(dashCommand, [], ['--no-hygiene']);
    expect(mockHumanLine).not.toHaveBeenCalled();
  });

  it('prints the hygiene note without the flag', async () => {
    await runParsed(dashCommand, [], []);
    expect(mockHumanLine).toHaveBeenCalledTimes(1);
  });
});

describe('cleo diagnostics analyze --no-brain', () => {
  it('forwards noBrain: true', async () => {
    await runParsed(diagnosticsCommand, ['analyze'], ['--no-brain']);
    expect(dispatchedParams()['noBrain']).toBe(true);
  });

  it('forwards noBrain: false without the flag', async () => {
    await runParsed(diagnosticsCommand, ['analyze'], []);
    expect(dispatchedParams()['noBrain']).toBe(false);
  });
});

describe('cleo import-tasks --no-provenance', () => {
  it('forwards provenance: false', async () => {
    await runParsed(importTasksCommand, [], ['pkg.json', '--no-provenance']);
    expect(dispatchedParams()['provenance']).toBe(false);
  });

  it('leaves provenance undefined without the flag', async () => {
    await runParsed(importTasksCommand, [], ['pkg.json']);
    expect(dispatchedParams()['provenance']).toBeUndefined();
  });
});

describe('cleo pivot --no-blocks-from', () => {
  it('forwards blocksFrom: false', async () => {
    await runParsed(pivotCommand, [], ['T1', 'T2', '--reason', 'r', '--no-blocks-from']);
    expect(dispatchedParams()['blocksFrom']).toBe(false);
  });

  it('forwards blocksFrom: true without the flag', async () => {
    await runParsed(pivotCommand, [], ['T1', 'T2', '--reason', 'r']);
    expect(dispatchedParams()['blocksFrom']).toBe(true);
  });
});

describe('cleo safestop --no-session-end', () => {
  it('forwards noSessionEnd: true', async () => {
    await runParsed(safestopCommand, [], ['--reason', 'ctx', '--no-session-end']);
    expect(dispatchedParams()['noSessionEnd']).toBe(true);
  });

  it('forwards noSessionEnd: false without the flag', async () => {
    await runParsed(safestopCommand, [], ['--reason', 'ctx']);
    expect(dispatchedParams()['noSessionEnd']).toBe(false);
  });
});

describe('cleo relates list --no-depends', () => {
  it('forwards includeDependencies: false', async () => {
    await runParsed(relatesCommand, ['list'], ['T1', '--no-depends']);
    expect(dispatchedParams()['includeDependencies']).toBe(false);
  });

  it('still honours the declared --noDepends spelling', async () => {
    await runParsed(relatesCommand, ['list'], ['T1', '--noDepends']);
    expect(dispatchedParams()['includeDependencies']).toBe(false);
  });

  it('forwards includeDependencies: true without the flag', async () => {
    await runParsed(relatesCommand, ['list'], ['T1']);
    expect(dispatchedParams()['includeDependencies']).toBe(true);
  });
});

describe('cleo release plan --no-changelog', () => {
  it('forwards writeChangelog: false', async () => {
    await runParsed(
      releaseCommand,
      ['plan'],
      ['v2026.9.99', '--epic', 'T1', '--skip-readiness', '--no-changelog'],
    );
    expect(dispatchedParams()['writeChangelog']).toBe(false);
  });

  it('forwards writeChangelog: true without the flag', async () => {
    await runParsed(releaseCommand, ['plan'], ['v2026.9.99', '--epic', 'T1', '--skip-readiness']);
    expect(dispatchedParams()['writeChangelog']).toBe(true);
  });
});
