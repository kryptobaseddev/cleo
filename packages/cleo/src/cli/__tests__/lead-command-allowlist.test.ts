/**
 * Lead command allow-list vs the live CLI (T14374).
 *
 * The runner parses argv against `LEAD_COMMAND_ALLOWLIST`; citty then parses
 * it again. They must agree, or a word the runner reads as a flag value can
 * reach citty as a subcommand (`cleo briefing --scope inject` runs
 * `briefing inject`). So every `cleo` rule must name a leaf command with no
 * subcommands, and every flag it lists (and every global flag the command
 * also declares) must have the arity of the command's own arg definition.
 *
 * @task T14374
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import {
  LEAD_CLEO_GLOBAL_FLAGS,
  LEAD_COMMAND_ALLOWLIST,
  type LeadFlagArity,
} from '@cleocode/contracts/operations/orchestrate.js';
import { runCommand } from 'citty';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { orchestrateCommand } from '../commands/orchestrate.js';
import { COMMAND_MANIFEST } from '../generated/command-manifest.js';

vi.mock('../../dispatch/adapters/cli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../dispatch/adapters/cli.js')>()),
  dispatchFromCli: vi.fn<typeof dispatchFromCli>(),
}));

/** The slice of a citty arg definition this test reads. */
interface ArgDef {
  readonly type?: string;
  readonly alias?: string | readonly string[];
}

/** The slice of a citty command definition this test reads. */
interface CommandShape {
  readonly args?: Readonly<Record<string, ArgDef>>;
  readonly subCommands?: Readonly<Record<string, Resolvable>>;
}

/** A citty value: the thing itself, a promise of it, or a function returning either. */
type Resolvable =
  | CommandShape
  | Promise<CommandShape>
  | (() => CommandShape | Promise<CommandShape>);

async function resolve(value: Resolvable | undefined): Promise<CommandShape | undefined> {
  return typeof value === 'function' ? await value() : await value;
}

async function loadLeaf(verb: readonly string[]): Promise<CommandShape | undefined> {
  const entry = COMMAND_MANIFEST.find((m) => m.name === verb[0]);
  if (!entry) return undefined;
  let cmd: CommandShape | undefined = (await entry.load()) as CommandShape;
  for (const word of verb.slice(1)) cmd = await resolve(cmd?.subCommands?.[word]);
  return cmd;
}

/** The arg a `--flag` token selects (by key or alias), if the command declares one. */
function argFor(cmd: CommandShape, flag: string): ArgDef | undefined {
  const name = flag.replace(/^--/, '');
  for (const [key, def] of Object.entries(cmd.args ?? {})) {
    const aliases = def.alias === undefined ? [] : [def.alias].flat();
    if (key === name || aliases.includes(name)) return def;
  }
  return undefined;
}

function arityOf(def: ArgDef): LeadFlagArity | 'positional' {
  if (def.type === 'positional') return 'positional';
  return def.type === 'boolean' ? 'boolean' : 'value';
}

describe('LEAD_COMMAND_ALLOWLIST matches the CLI (T14374)', () => {
  it.each(
    LEAD_COMMAND_ALLOWLIST.cleo.map((rule) => [rule.verb.join(' '), rule] as const),
  )('cleo %s is a leaf whose flags match its arg definitions', async (_name, rule) => {
    const cmd = await loadLeaf(rule.verb);
    expect(cmd, `cleo ${rule.verb.join(' ')} exists`).toBeDefined();
    if (!cmd) return;
    expect(Object.keys(cmd.subCommands ?? {}), 'a leaf has no subcommands').toEqual([]);

    for (const [flag, arity] of Object.entries(rule.flags ?? {})) {
      const def = argFor(cmd, flag);
      expect(def, `${flag} is declared`).toBeDefined();
      if (def) expect(arityOf(def), `${flag} arity`).toBe(arity);
    }
    for (const [flag, arity] of Object.entries(LEAD_CLEO_GLOBAL_FLAGS)) {
      const def = argFor(cmd, flag);
      if (def) expect(arityOf(def), `global ${flag} arity`).toBe(arity);
    }
    const positionals = Object.values(cmd.args ?? {}).filter((d) => d.type === 'positional');
    if ((rule.positionals ?? 0) > 0) expect(positionals.length).toBeGreaterThan(0);
  });
});

describe('orchestrate status epic scope (T14478)', () => {
  beforeEach(() => {
    vi.mocked(dispatchFromCli).mockClear();
  });

  it.each([
    { argv: [], epicId: undefined },
    { argv: ['T1'], epicId: 'T1' },
    { argv: ['--epic', 'T1'], epicId: 'T1' },
    { argv: ['--epic=T1'], epicId: 'T1' },
    { argv: ['T1', '--epic', 'T1'], epicId: 'T1' },
  ])('dispatches the parsed scope for $argv', async ({ argv, epicId }) => {
    await runCommand(orchestrateCommand, { rawArgs: ['status', ...argv] });
    expect(dispatchFromCli).toHaveBeenCalledExactlyOnceWith(
      'query',
      'orchestrate',
      'status',
      { epicId },
      { command: 'orchestrate' },
    );
  });

  it('refuses a positional epic beside a different --epic (T14533)', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const before = process.exitCode;
    try {
      await runCommand(orchestrateCommand, { rawArgs: ['status', 'T1', '--epic', 'T2'] });
      expect(dispatchFromCli).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(ExitCode.INVALID_INPUT);
    } finally {
      process.exitCode = before;
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
