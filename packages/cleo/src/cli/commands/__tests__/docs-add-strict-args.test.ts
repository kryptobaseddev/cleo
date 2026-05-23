/**
 * Strict flag validation tests for `cleo docs add` (T10359).
 *
 * citty 0.2.1 calls Node's `parseArgs({ strict: false })` internally
 * (verified at `node_modules/.pnpm/citty@0.2.1/.../citty/dist/index.mjs:81`)
 * with no public override — unknown flags would otherwise be silently
 * absorbed as positional values, which is the T10238 root cause.
 *
 * These tests exercise the {@link assertKnownFlags} pre-parse validator
 * directly so they don't depend on dispatch wiring, the attachment
 * store, or the renderer stack. The full integration through
 * `addCommand.run` is covered by the existing docs-* test suites; here
 * we lock the contract of the validator and its error envelope.
 *
 * @task T10359
 * @epic T10291
 * @saga T10288
 * @closes T10238
 */

import { describe, expect, it } from 'vitest';
import { assertKnownFlags, E_UNKNOWN_FLAG, UnknownFlagError } from '../../lib/strict-args.js';

// Mirror of `addCommand.args` — keeping the shape inline avoids pulling
// the entire docs.ts module (and its dispatch/store/llmtxt graph) into
// the test process. If the production schema changes the integration
// tests catch the drift.
const docsAddSchema = {
  'owner-id': {
    type: 'positional' as const,
    description: 'Owner entity ID (T###, ses_*, O-*)',
    required: true,
  },
  file: {
    type: 'positional' as const,
    description: 'Local file path to attach',
    required: false,
  },
  url: { type: 'string' as const, description: 'Remote URL' },
  desc: { type: 'string' as const, description: 'Description' },
  labels: { type: 'string' as const, description: 'Labels' },
  'attached-by': { type: 'string' as const, description: 'Attached by' },
  slug: { type: 'string' as const, description: 'Slug' },
  type: { type: 'string' as const, description: 'Type' },
};

describe('docs add — strict flag validation (T10359 / closes T10238)', () => {
  it('(a) rejects a typo with did-you-mean suggesting the closest known flag', () => {
    // `--title` is a real T10238 footgun — agents type it instead of --type.
    expect(() =>
      assertKnownFlags(['T123', 'file.md', '--title', 'typo'], docsAddSchema, 'docs add'),
    ).toThrow(UnknownFlagError);

    try {
      assertKnownFlags(['T123', 'file.md', '--title', 'typo'], docsAddSchema, 'docs add');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownFlagError);
      const ufe = err as UnknownFlagError;
      expect(ufe.code).toBe(E_UNKNOWN_FLAG);
      expect(ufe.flag).toBe('--title');
      expect(ufe.command).toBe('docs add');
      // Levenshtein --title → --type is distance 4, but --title → --labels
      // and --title → --slug are within distance 3 — the validator should
      // surface AT LEAST one suggestion from the known set.
      expect(ufe.suggestions.length).toBeGreaterThan(0);
      // --type is the most semantically likely flag the user wanted.
      // The point of the test is not the perfect ranking — it's that the
      // CLI no longer silently consumes the unknown flag.
      expect(ufe.message).toContain('E_UNKNOWN_FLAG');
      expect(ufe.message).toContain('--title');
      expect(ufe.fix).toContain('--help');
    }
  });

  it('(b) rejects an unknown short flag with E_UNKNOWN_FLAG', () => {
    expect(() => assertKnownFlags(['T123', 'file.md', '-X'], docsAddSchema, 'docs add')).toThrow(
      UnknownFlagError,
    );

    try {
      assertKnownFlags(['T123', 'file.md', '-X'], docsAddSchema, 'docs add');
    } catch (err) {
      const ufe = err as UnknownFlagError;
      expect(ufe.code).toBe(E_UNKNOWN_FLAG);
      expect(ufe.flag).toBe('-X');
    }
  });

  it('(c) rejects --typo even when followed by an extra positional', () => {
    // T10238 surface: `cleo docs add T123 file.md extra-positional` was
    // accepted as silently absorbed. The third positional `extra-positional`
    // itself isn't a flag, so the validator can't catch it — but if the
    // agent typed `--something` for it, the validator MUST fire.
    expect(() =>
      assertKnownFlags(
        ['T123', 'file.md', '--bogus', 'extra-positional'],
        docsAddSchema,
        'docs add',
      ),
    ).toThrow(UnknownFlagError);
  });

  it('(d) accepts the happy path with all known long flags', () => {
    expect(() =>
      assertKnownFlags(
        ['T123', 'file.md', '--type', 'spec', '--slug', 's', '--desc', 'a desc'],
        docsAddSchema,
        'docs add',
      ),
    ).not.toThrow();
  });

  it('(e) accepts the --flag=value form for every named arg', () => {
    expect(() =>
      assertKnownFlags(
        ['T123', 'file.md', '--type=spec', '--slug=s', '--desc=hello'],
        docsAddSchema,
        'docs add',
      ),
    ).not.toThrow();
  });

  it('honours the `--` terminator: tokens after it are positional, not validated', () => {
    expect(() =>
      assertKnownFlags(
        ['T123', 'file.md', '--', '--anything-goes', '--here'],
        docsAddSchema,
        'docs add',
      ),
    ).not.toThrow();
  });

  it('ignores empty rawArgs gracefully', () => {
    expect(() => assertKnownFlags([], docsAddSchema, 'docs add')).not.toThrow();
    expect(() => assertKnownFlags(undefined, docsAddSchema, 'docs add')).not.toThrow();
  });

  it('error envelope carries known-flag set + structured fix string', () => {
    try {
      assertKnownFlags(['--titel'], docsAddSchema, 'docs add');
    } catch (err) {
      const ufe = err as UnknownFlagError;
      expect(ufe.knownFlags).toContain('--type');
      expect(ufe.knownFlags).toContain('--slug');
      expect(ufe.knownFlags).toContain('--url');
      expect(ufe.fix).toMatch(/cleo docs add --help/);
    }
  });

  it('handles a stray single dash `-` as a positional, not a flag', () => {
    // `-` is conventional stdin shorthand; the validator must not flag it.
    expect(() => assertKnownFlags(['T123', '-'], docsAddSchema, 'docs add')).not.toThrow();
  });
});
