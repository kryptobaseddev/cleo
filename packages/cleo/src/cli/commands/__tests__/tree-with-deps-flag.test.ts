/**
 * `cleo tree` takes `--with-deps` (the kebab-case convention) and keeps the
 * older `--withDeps` spelling working (T14673).
 *
 * @task T14673
 */

import { parseArgs } from 'citty';
import { describe, expect, it } from 'vitest';
import { assertKnownFlags } from '../../lib/strict-args.js';
import { treeCommand } from '../deps.js';

const schema = treeCommand.args;
if (!schema || typeof schema === 'function' || 'then' in schema) {
  throw new Error('treeCommand.args must be a literal args object');
}

describe('cleo tree --with-deps (T14673)', () => {
  it.each([['--with-deps'], ['--withDeps']])('accepts %s and the handler reads it', (flag) => {
    const argv = ['T1', flag, '--blockers'];
    expect(() => assertKnownFlags(argv, schema, 'tree')).not.toThrow();
    // The handler reads `args.withDeps`; citty sets it for both spellings.
    expect(parseArgs(argv, schema).withDeps).toBe(true);
  });

  it('still rejects an undeclared flag', () => {
    expect(() => assertKnownFlags(['T1', '--with-dep'], schema, 'tree')).toThrow(/--with-dep/);
  });
});
