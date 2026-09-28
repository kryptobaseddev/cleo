/**
 * Regression test for T12520: `cleo orchestrate spawn <id> --no-worktree` must
 * forward `noWorktree: true` to the dispatch layer.
 *
 * citty parses a `--no-<flag>` token as the NEGATION of `<flag>`
 * (`{ worktree: false }`), not as `{ 'no-worktree': true }`. The handler used
 * to read only `args['no-worktree']`, so the opt-out was a silent no-op: a
 * worktree was provisioned and the prompt's Worktree Setup block emitted.
 *
 * The args are parsed with citty's own `parseArgs` against the command's real
 * `args` definition, so the test exercises the parser the CLI actually uses
 * rather than a hand-built args object that would encode the same mistake.
 *
 * @task T12520
 */

import { type ArgsDef, parseArgs } from 'citty';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDispatchFromCli = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
  dispatchRaw: vi.fn(),
  handleRawError: vi.fn(),
  maybeEmitDescribe: () => false,
}));

import { orchestrateCommand } from '../orchestrate.js';

/** Resolve the spawn subcommand and run it on citty-parsed argv. */
async function runSpawn(argv: string[]): Promise<Record<string, unknown>> {
  const subCommands = orchestrateCommand.subCommands as Record<
    string,
    { args?: ArgsDef; run?: (ctx: { args: unknown; rawArgs: string[] }) => Promise<void> }
  >;
  const spawn = subCommands['spawn'];
  if (!spawn?.args || !spawn.run) throw new Error('spawn subcommand missing args/run');
  const args = parseArgs(argv, spawn.args);
  await spawn.run({ args, rawArgs: argv });
  const call = mockDispatchFromCli.mock.calls[0];
  if (!call) throw new Error('dispatchFromCli was not called');
  return call[3] as Record<string, unknown>;
}

describe('cleo orchestrate spawn --no-worktree (T12520)', () => {
  beforeEach(() => {
    mockDispatchFromCli.mockReset();
  });

  it('citty parses --no-worktree as the negation of `worktree`', () => {
    const spawn = (orchestrateCommand.subCommands as Record<string, { args: ArgsDef }>)['spawn'];
    const parsed = parseArgs(['T1', '--no-worktree'], spawn?.args ?? {});
    expect(parsed['worktree']).toBe(false);
    expect(parsed['no-worktree']).toBeUndefined();
  });

  it('forwards noWorktree: true when --no-worktree is passed', async () => {
    const params = await runSpawn(['T1', '--no-worktree']);
    expect(params['noWorktree']).toBe(true);
  });

  it('forwards noWorktree: false when the flag is absent', async () => {
    const params = await runSpawn(['T1']);
    expect(params['noWorktree']).toBe(false);
  });
});
