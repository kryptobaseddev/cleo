/**
 * Regression tests for gh#1240 — "cleo verify scrapes filenames from AC prose
 * and drops the negation, so a 'do not modify X' constraint becomes a
 * requirement to modify X".
 *
 * The defect is structural, not textual: `task.files` is the documented SSoT
 * and prose parsing is documented as a legacy fallback, but the T9245
 * content-intersect gate blocked identically on either — **a heuristic
 * fallback was wired to a blocking gate**. The lost negation is the sharpest
 * symptom, not the cause. A regex cannot distinguish a target from a
 * prohibition, an example, or a cross-reference, so the fix is a tier
 * boundary: a declaration may block, a guess may only advise.
 *
 * @task T12118 (gh#1240)
 */

import { describe, expect, it } from 'vitest';
import { extractTaskAcFilesWithProvenance } from '../evidence.js';

describe('gh#1240 — provenance separates a declaration from a guess', () => {
  it('marks an explicit --files list as declared', () => {
    const r = extractTaskAcFilesWithProvenance({
      files: ['src/lib/a.ts', 'src/lib/b.ts'],
      acceptance: ['anything at all'],
    });
    expect(r.provenance).toBe('declared');
    expect(r.files).toEqual(['src/lib/a.ts', 'src/lib/b.ts']);
  });

  it('marks a prose-scraped list as derived', () => {
    const r = extractTaskAcFilesWithProvenance({
      files: [],
      acceptance: ['The resolver in src/lib/resolve.ts returns the canonical id'],
    });
    expect(r.provenance).toBe('derived');
    expect(r.files).toEqual(['src/lib/resolve.ts']);
  });

  it('a declared list is never overridden by prose', () => {
    const r = extractTaskAcFilesWithProvenance({
      files: ['src/declared.ts'],
      acceptance: ['mentions src/prose-only.ts which must be ignored'],
    });
    expect(r.files).toEqual(['src/declared.ts']);
    expect(r.provenance).toBe('declared');
  });
});

describe('gh#1240 — the reported AC must not become a requirement to violate itself', () => {
  it('drops a path the AC forbids touching (the exact reported case)', () => {
    // Verbatim shape from the issue: the only mention of the file is a
    // prohibition, and the gate demanded the commit modify it.
    const r = extractTaskAcFilesWithProvenance({
      files: [],
      acceptance: [
        'followCanonical is unmodified — the diff touches no line of src/lib/compound-catalog.ts from :387 down',
      ],
    });
    expect(r.files).toBeNull();
  });

  it.each([
    ['does not modify src/lib/x.ts', 'does not'],
    ['must not touch src/lib/x.ts', 'must not'],
    ['src/lib/x.ts remains unchanged', 'unchanged'],
    ['without changing src/lib/x.ts', 'without'],
    ['avoid editing src/lib/x.ts', 'avoid'],
    ['no changes to src/lib/x.ts', 'no'],
  ])('drops a negated path: %s', (acceptance) => {
    const r = extractTaskAcFilesWithProvenance({ files: [], acceptance: [acceptance] });
    expect(r.files).toBeNull();
  });

  it('keeps a required path in one clause while dropping a forbidden one in another', () => {
    // A prohibition must not suppress a genuine requirement sitting beside it.
    const r = extractTaskAcFilesWithProvenance({
      files: [],
      acceptance: ['updates src/lib/target.ts; does not touch src/lib/forbidden.ts'],
    });
    expect(r.files).toEqual(['src/lib/target.ts']);
  });

  it('still extracts plainly-required paths', () => {
    // Guard against over-correcting into a filter that drops everything.
    const r = extractTaskAcFilesWithProvenance({
      files: [],
      acceptance: ['src/lib/one.ts is updated', 'packages/core/src/two.ts gains a guard'],
    });
    expect(new Set(r.files)).toEqual(new Set(['src/lib/one.ts', 'packages/core/src/two.ts']));
  });
});
