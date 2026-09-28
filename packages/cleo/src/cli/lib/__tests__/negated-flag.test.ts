/**
 * Tests for {@link negatedFlag} and the citty behaviour it exists for (T12528).
 *
 * The first block pins citty's actual parse of `--no-<name>` so that, if a
 * future citty ever starts populating `'no-<name>'`, this fails loudly instead
 * of the helper's reasoning silently going stale.
 *
 * @task T12528
 */

import { parseArgs } from 'citty';
import { describe, expect, it } from 'vitest';
import { negatedFlag } from '../negated-flag.js';

describe('citty --no-<flag> parse (the behaviour negatedFlag exists for)', () => {
  it("declaring 'no-x' explicitly still yields { x: false }, never { 'no-x': true }", () => {
    const parsed = parseArgs(['--no-x'], { 'no-x': { type: 'boolean' } });
    expect(parsed['x']).toBe(false);
    expect(parsed['no-x']).not.toBe(true);
  });

  it('declaring the positive flag yields { x: false }', () => {
    const parsed = parseArgs(['--no-x'], { x: { type: 'boolean', default: true } });
    expect(parsed['x']).toBe(false);
  });

  it('a camelCase noFoo declaration is unreachable from --no-foo ({ foo: false })', () => {
    const parsed = parseArgs(['--no-depends'], { noDepends: { type: 'boolean' } });
    expect(parsed['depends']).toBe(false);
    expect(parsed['noDepends']).not.toBe(true);
  });
});

describe('negatedFlag', () => {
  it('is true for citty-parsed --no-<name> (the real argv shape)', () => {
    const parsed = parseArgs(['--no-keep-going'], { 'no-keep-going': { type: 'boolean' } });
    expect(negatedFlag(parsed, 'keep-going')).toBe(true);
  });

  it("is true when a caller supplies the literal 'no-<name>' key", () => {
    expect(negatedFlag({ 'no-hygiene': true }, 'hygiene')).toBe(true);
  });

  it('is true for the --noFoo spelling (citty mirrors it onto the kebab key)', () => {
    const parsed = parseArgs(['--noDepends'], { noDepends: { type: 'boolean' } });
    expect(negatedFlag(parsed, 'depends')).toBe(true);
  });

  it('is false when the flag is absent, even with a declared default of false', () => {
    const parsed = parseArgs([], { 'no-launch': { type: 'boolean', default: false } });
    expect(negatedFlag(parsed, 'launch')).toBe(false);
  });

  it('is false for the positive form', () => {
    const parsed = parseArgs(['--execute'], {
      execute: { type: 'boolean' },
      'no-execute': { type: 'boolean' },
    });
    expect(negatedFlag(parsed, 'execute')).toBe(false);
  });

  it("rejects a 'no-'-prefixed name (the caller passed the wrong spelling)", () => {
    expect(() => negatedFlag({}, 'no-worktree')).toThrow(/positive flag name/);
  });
});
