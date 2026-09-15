/**
 * `cleo find` must not read a value-taking GLOBAL flag's value as its positional
 * query (GH #1438).
 *
 * citty 0.2.1 parses with `strict: false`, so an undeclared `--output` is read
 * as a boolean and its value stays in the positional stream. `find`'s optional
 * `query` is the first positional, so `cleo find --status pending --all
 * --limit 0 --output id` ran as a fuzzy search for "id" and returned a
 * confident subset of the matches (132 of 247 in the report) with exit 0 and no
 * truncation notice — while `cleo list ... --output id --limit 0` returned all
 * of them.
 *
 * The fix normalizes value-taking global flags to their `--flag=value` form
 * before citty parses them. These tests pin both the normalization and the
 * parse result.
 *
 * @task T12139
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'citty';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchRaw: vi.fn(),
  maybeEmitDescribe: () => false,
  handleRawError: vi.fn(),
  dispatchFromCli: vi.fn(),
}));

vi.mock('../../renderers/index.js', () => ({
  cliOutput: vi.fn(),
  cliError: vi.fn(),
  humanInfo: vi.fn(),
  humanWarn: vi.fn(),
}));

vi.mock('@cleocode/core', async () => {
  const actual = await vi.importActual<typeof import('@cleocode/core')>('@cleocode/core');
  return {
    ...actual,
    createPage: vi.fn(() => undefined),
  };
});

import {
  CLI_GLOBAL_FLAGS,
  CLI_GLOBAL_VALUE_FLAGS,
  normalizeGlobalValueFlags,
} from '../../lib/strict-args.js';
import { findCommand } from '../find.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('normalizeGlobalValueFlags', () => {
  it('binds a value-taking global flag to its value', () => {
    expect(
      normalizeGlobalValueFlags([
        'find',
        '--status',
        'pending',
        '--all',
        '--limit',
        '0',
        '--output',
        'id',
      ]),
    ).toEqual(['find', '--status', 'pending', '--all', '--limit', '0', '--output=id']);
  });

  it('is the complete set of value-taking globals the entry point parses', () => {
    const source = readFileSync(resolve(join(here, '../../index.ts')), 'utf-8');
    const parsed = new Set(
      [...source.matchAll(/arg === '(--[a-z-]+)' && i \+ 1 < argv\.length/g)].map(
        (match) => match[1] as string,
      ),
    );
    // Guard against a regex that stops matching after an index.ts refactor.
    expect(parsed.size).toBeGreaterThan(0);
    expect([...parsed].sort()).toEqual([...CLI_GLOBAL_VALUE_FLAGS].sort());
    for (const flag of CLI_GLOBAL_VALUE_FLAGS) {
      expect(CLI_GLOBAL_FLAGS).toContain(flag);
    }
  });

  it('leaves equals form, a trailing flag with no value, and other tokens alone', () => {
    expect(normalizeGlobalValueFlags(['--output=id', '--status', 'pending', '--mvi'])).toEqual([
      '--output=id',
      '--status',
      'pending',
      '--mvi',
    ]);
  });

  it('copies everything after a -- terminator verbatim', () => {
    expect(normalizeGlobalValueFlags(['find', '--', '--output', 'id'])).toEqual([
      'find',
      '--',
      '--output',
      'id',
    ]);
  });
});

describe('cleo find does not swallow a global flag value (GH #1438)', () => {
  const parseFind = (argv: string[]) =>
    parseArgs(normalizeGlobalValueFlags(argv), findCommand.args);

  it('does not read --output <mode> as the positional query', () => {
    const args = parseFind(['--status', 'pending', '--all', '--limit', '0', '--output', 'id']);
    expect(args.query).toBeUndefined();
    expect(args._).toEqual([]);
    expect(args.status).toBe('pending');
    expect(args.all).toBe(true);
    expect(args.limit).toBe('0');
  });

  it('does not read --mvi <level> as the positional query', () => {
    const args = parseFind(['--status', 'pending', '--mvi', 'minimal']);
    expect(args.query).toBeUndefined();
    expect(args.mvi).toBe('minimal');
  });

  it('does not read --field <name> as the positional query', () => {
    const args = parseFind(['--status', 'pending', '--field', 'title']);
    expect(args.query).toBeUndefined();
    expect(args.field).toBe('title');
  });

  it('still binds a real positional query to find', () => {
    const args = parseFind(['auth', '--status', 'pending']);
    expect(args.query).toBe('auth');
  });
});
