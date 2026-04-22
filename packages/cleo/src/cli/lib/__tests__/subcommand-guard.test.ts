/**
 * Unit tests for the citty subcommand-dispatch guard helper.
 *
 * Codifies the behavior the entire CLI depends on — any regression here would
 * reintroduce the double-dispatch bug where `cleo <group> <subcommand>` emits
 * the subcommand's output AND the parent's default behaviour on stdout.
 *
 * @task T1187-followup / v2026.4.114
 */

import { describe, expect, it } from 'vitest';
import { isSubCommandDispatch } from '../subcommand-guard.js';

const SUBS = {
  list: { meta: { name: 'list' } },
  show: { meta: { name: 'show' } },
  add: { meta: { name: 'add' } },
};

describe('isSubCommandDispatch', () => {
  it('returns true when first positional arg names a subcommand', () => {
    expect(isSubCommandDispatch(['list'], SUBS)).toBe(true);
    expect(isSubCommandDispatch(['show', 'T123'], SUBS)).toBe(true);
    expect(isSubCommandDispatch(['add', '--task', 'T1'], SUBS)).toBe(true);
  });

  it('ignores leading flags and finds the first positional', () => {
    expect(isSubCommandDispatch(['--verbose', 'list'], SUBS)).toBe(true);
    expect(isSubCommandDispatch(['--json', '--limit', 'show', 'T9'], SUBS)).toBe(true);
  });

  it('returns false when first positional is not a known subcommand', () => {
    expect(isSubCommandDispatch(['unknown'], SUBS)).toBe(false);
    expect(isSubCommandDispatch(['delete', 'T1'], SUBS)).toBe(false);
  });

  it('returns false when only flags are present (no positional)', () => {
    expect(isSubCommandDispatch(['--help'], SUBS)).toBe(false);
    expect(isSubCommandDispatch(['--json', '--limit', '10'], SUBS)).toBe(false);
  });

  it('returns false for empty or undefined rawArgs', () => {
    expect(isSubCommandDispatch([], SUBS)).toBe(false);
    expect(isSubCommandDispatch(undefined, SUBS)).toBe(false);
  });

  it('returns false when subCommands map is missing or empty', () => {
    expect(isSubCommandDispatch(['list'], undefined)).toBe(false);
    expect(isSubCommandDispatch(['list'], {})).toBe(false);
  });

  it('handles kebab-case and hyphenated subcommand names', () => {
    const hyphenSubs = { 'inject-status': { meta: { name: 'inject-status' } } };
    expect(isSubCommandDispatch(['inject-status'], hyphenSubs)).toBe(true);
    expect(isSubCommandDispatch(['inject'], hyphenSubs)).toBe(false);
  });

  it('is case-sensitive (matches citty dispatch)', () => {
    expect(isSubCommandDispatch(['LIST'], SUBS)).toBe(false);
    expect(isSubCommandDispatch(['List'], SUBS)).toBe(false);
  });
});
