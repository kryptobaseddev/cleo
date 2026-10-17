/**
 * T13726 — `cleo docs add` argument-shape errors name the positional each
 * value bound to and print the exact corrected command.
 *
 * @task T13726
 */

import { describe, expect, it } from 'vitest';
import {
  diagnoseDocsAddSources,
  docsAddMissingFileError,
  looksLikeDocsOwnerId,
} from '../docs-add-args.js';

describe('docs add argument diagnostics (T13726)', () => {
  it('owner-only invocation names the missing source for that owner', () => {
    const err = diagnoseDocsAddSources({ ownerId: 'T123' });
    expect(err?.message).toBe(
      'no document source for owner T123: pass a file path as the second positional, --content <text>, or --url <url>',
    );
    expect(err?.message).not.toContain('provide a file path (positional)');
    expect(err?.fix).toContain('cleo docs add T123 ./path/to/doc.md');
  });

  it('a lone file path says it was consumed as OWNER-ID and shows the owner-first shape', () => {
    const err = diagnoseDocsAddSources({ ownerId: 'notes/plan.md' });
    expect(err?.message).toContain("'notes/plan.md' was read as OWNER-ID");
    expect(err?.fix).toBe('cleo docs add <T###|ses_*|O-*> notes/plan.md');
  });

  it('reversed positionals print the swapped command', () => {
    const err = diagnoseDocsAddSources({ ownerId: 'plan.md', file: 'T42' });
    expect(err?.message).toContain('reversed');
    expect(err?.fix).toBe('cleo docs add T42 plan.md');
  });

  it('accepts exactly one source and rejects several', () => {
    expect(diagnoseDocsAddSources({ ownerId: 'T1', file: 'a.md' })).toBeNull();
    expect(diagnoseDocsAddSources({ ownerId: 'ses_abc', content: '# x' })).toBeNull();
    expect(diagnoseDocsAddSources({ ownerId: 'T1', file: 'a.md', url: 'https://x' })?.message).toBe(
      'the file positional, --url, and --content are mutually exclusive',
    );
  });

  it('a missing file names the file positional and its owner', () => {
    const err = docsAddMissingFileError('T7', 'gone.md', '/repo/gone.md');
    expect(err.message).toBe(
      "file 'gone.md' (the second positional, after OWNER-ID T7) does not exist at /repo/gone.md",
    );
    expect(err.fix).toContain('cleo docs add T7 <existing-file>');
  });

  it('recognises owner id shapes', () => {
    for (const id of ['T1', 't99', 'D12', 'ses_x', 'O-1', 'dec_1', 'L-1', 'pat_1']) {
      expect(looksLikeDocsOwnerId(id)).toBe(true);
    }
    for (const v of ['plan.md', './T1.md', 'T1x', 'my-slug']) {
      expect(looksLikeDocsOwnerId(v)).toBe(false);
    }
  });
});
