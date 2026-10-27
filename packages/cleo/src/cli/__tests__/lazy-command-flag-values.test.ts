/**
 * A value passed to a value-taking flag is never re-parsed as a flag (T14044):
 * `cleo add --title "--field on ..."` failed E_UNKNOWN_FLAG naming the title.
 *
 * @task T14044
 */

import type { ArgsDef, CommandDef } from 'citty';
import { describe, expect, it } from 'vitest';
import { lazyCommand } from '../lazy-command.js';
import { parseArgs } from '../lib/define-cli-command.js';
import { assertKnownFlags, extractPositionalFlags } from '../lib/strict-args.js';

const schema: ArgsDef = {
  title: { type: 'positional', required: false },
  acceptance: { type: 'string' },
  'dry-run': { type: 'boolean' },
};

describe('flag values beginning with -- (T14044)', () => {
  it('assertKnownFlags never reads a string or positional flag value as a flag', () => {
    expect(() =>
      assertKnownFlags(['--title', '--x', '--acceptance', '--y', '--dry-run'], schema, 'add'),
    ).not.toThrow();
    // A real unknown flag still refuses, and a boolean consumes no value.
    expect(() => assertKnownFlags(['--dry-run', '--bogus'], schema, 'add')).toThrow(
      /unknown flag '--bogus'/,
    );
  });

  it('extractPositionalFlags takes a positional given in flag form, in both spellings', () => {
    expect(extractPositionalFlags(['--title', '--x', '--dry-run'], schema)).toEqual({
      rest: ['--dry-run'],
      values: { title: '--x' },
    });
    expect(extractPositionalFlags(['--title=--x'], schema)).toEqual({
      rest: [],
      values: { title: '--x' },
    });
    // After `--` everything is positional and left alone.
    expect(extractPositionalFlags(['--', '--title', 'y'], schema)).toEqual({
      rest: ['--', '--title', 'y'],
      values: {},
    });
  });

  it('a command run through lazyCommand receives --title "--x" as its title', async () => {
    let received: Record<string, unknown> = {};
    const loaded: CommandDef = {
      meta: { name: 'add' },
      args: schema,
      run: ({ args }) => {
        received = args;
      },
    };
    const command = lazyCommand({ name: 'add', description: 'add' }, async () => loaded);
    const rawArgs = ['--title', '--x probe', '--acceptance', '--y', '--dry-run'];
    await command.run?.({ rawArgs, args: parseArgs(rawArgs, schema), cmd: command });
    expect(received).toMatchObject({ title: '--x probe', acceptance: '--y', 'dry-run': true });
    expect(received).not.toHaveProperty('x probe');
  });
});
