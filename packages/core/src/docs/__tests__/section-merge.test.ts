/**
 * Section CRDT merge engine — CleoDocs write-path core (T13355).
 *
 * Exercises the production merge engine (`docs/section-merge.ts`) against
 * the REAL llmtxt WASM primitives, proving the acceptance criteria from the
 * task record:
 *
 *   - AC1: two concurrent section updates from the same base both survive
 *     a merge;
 *   - AC2: the merge result is order-independent;
 *   - AC3: non-edited sections stay byte-identical through the merge.
 *
 * REGRESSION (T13353 spike finding): the WASM `crdt_merge_updates` is lossy
 * in llmtxt@2026.5.15 — it returns an empty-doc snapshot and silently drops
 * merged content (kryptobaseddev/llmtxt#17, tracked in T13356). The engine
 * composes merges via sequential `crdt_apply_update`; the tests below would
 * catch a lossy composition (an empty merged text fails the
 * "both edits present" assertions), and `section-store.spike.test.ts` pins
 * the broken `crdt_merge_updates` behavior as a tripwire.
 *
 * Run: `npx vitest run packages/core/src/docs/__tests__/section-merge.test.ts`
 *
 * @task T13355 (Epic T13340 / Saga T13339)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  crdt_make_incremental_update,
  crdt_make_state,
  crdt_merge_updates,
  crdt_state_vector,
} from 'llmtxt/crdt-primitives';
import { describe, expect, it } from 'vitest';
import {
  applySectionTextEdit,
  joinSections,
  makeSectionEditUpdate,
  mergeSectionUpdates,
  planSectionMerge,
  sectionIds,
  sectionStateText,
  seedSectionState,
  splitDocIntoSections,
} from '../section-merge.js';

const FIXTURE = join(import.meta.dirname, '..', '__fixtures__', 'perf-plan.md');

const DOC = [
  '# Plan\n\nPreamble text.',
  '## Alpha\n\nalpha body',
  '## Beta\n\nbeta body',
  '## Gamma\n\ngamma body',
].join('\n');

describe('splitDocIntoSections', () => {
  it('splits H1 preamble plus each ## block, and joins back byte-identically', () => {
    const sections = splitDocIntoSections(DOC);
    expect(sections).toHaveLength(4);
    expect(sections[0]).toMatch(/^# Plan/);
    for (const s of sections.slice(1)) expect(s.startsWith('## ')).toBe(true);
    expect(joinSections(sections)).toBe(DOC);
    // The real 32 KB fixture round-trips too.
    const original = readFileSync(FIXTURE, 'utf-8');
    expect(joinSections(splitDocIntoSections(original))).toBe(original);
  });

  it('T13584: section ids are heading-anchored, so an insert or removal leaves other ids in place', () => {
    const before = splitDocIntoSections(DOC);
    expect(sectionIds(before)).toEqual(['s0', 'h-alpha', 'h-beta', 'h-gamma']);
    const inserted = [before[0], before[1], '## New Bit\n\nnew', before[2], before[3]] as string[];
    expect(sectionIds(inserted)).toEqual(['s0', 'h-alpha', 'h-new-bit', 'h-beta', 'h-gamma']);
    expect(sectionIds([before[0], before[2], before[3]] as string[])).toEqual([
      's0',
      'h-beta',
      'h-gamma',
    ]);
    // Repeated headings are told apart by occurrence; a heading-led doc has no preamble.
    expect(sectionIds(['## A\n\none', '## A\n\ntwo', '## Résumé'])).toEqual([
      'h-a',
      'h-a~2',
      'h-résumé',
    ]);
  });

  it('T13584: a single-writer plan applies the incoming sections in order', () => {
    const doc = splitDocIntoSections(DOC);
    const next = [doc[0], doc[2], '## New\n\nnew'] as string[];
    const plan = planSectionMerge(doc, doc, next);
    expect(plan.conflicts).toEqual([]);
    expect(plan.steps.map((s) => [s.kind, s.id])).toEqual([
      ['apply', 's0'],
      ['apply', 'h-beta'],
      ['apply', 'h-new'],
    ]);
  });
});

describe('mergeSectionUpdates (AC1, AC2)', () => {
  it('two concurrent section updates from one base both survive the merge', () => {
    const baseText = '## Alpha\n\nalpha body';
    const base = crdt_make_state(baseText);

    // Two agents append their own edit to the SAME base state.
    const updateA = crdt_make_incremental_update(base, '\n\nAgent A note.\n');
    const updateB = crdt_make_incremental_update(base, '\n\nAgent B note.\n');

    const merged = sectionStateText(mergeSectionUpdates(base, [updateA, updateB]));
    // AC1: both edits are present, and the base content is intact — a lossy
    // composition (the crdt_merge_updates behavior) fails right here.
    expect(merged).toContain(baseText);
    expect(merged).toContain('Agent A note.');
    expect(merged).toContain('Agent B note.');
  });

  it('merge result is order-independent', () => {
    const baseText = '## Beta\n\nbeta body';
    const base = crdt_make_state(baseText);
    const updateA = crdt_make_incremental_update(base, '\nfirst concurrent edit\n');
    const updateB = crdt_make_incremental_update(base, '\nsecond concurrent edit\n');
    const updateC = crdt_make_incremental_update(base, '\nthird concurrent edit\n');

    const forward = sectionStateText(mergeSectionUpdates(base, [updateA, updateB, updateC]));
    const reverse = sectionStateText(mergeSectionUpdates(base, [updateC, updateB, updateA]));
    const shuffled = sectionStateText(mergeSectionUpdates(base, [updateB, updateC, updateA]));
    expect(reverse).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it('REGRESSION: sequential-apply composition is not lossy (unlike crdt_merge_updates)', () => {
    const base = crdt_make_state('hello world');
    const updateA = crdt_make_incremental_update(base, ' AAA');
    const updateB = crdt_make_incremental_update(base, ' BBB');

    // The production composition keeps everything…
    const merged = mergeSectionUpdates(base, [updateA, updateB]);
    const text = sectionStateText(merged);
    expect(text).toContain('AAA');
    expect(text).toContain('BBB');
    expect(merged.length).toBeGreaterThan(base.length);

    // …while the WASM crdt_merge_updates is lossy today: empty doc, no text.
    // If an llmtxt upgrade fixes the WASM merge, these assertions FAIL — that
    // is the signal to switch the engine back (T13356) and delete this test.
    const wasmMerged = crdt_merge_updates([updateA, updateB]);
    expect(crdt_state_vector(wasmMerged).length).toBe(1);
    expect(sectionStateText(wasmMerged)).toBe('');
  });

  it('applying the same update twice is idempotent', () => {
    const base = crdt_make_state('base');
    const update = crdt_make_incremental_update(base, ' extra');
    const once = mergeSectionUpdates(base, [update]);
    const twice = mergeSectionUpdates(once, [update]);
    expect(sectionStateText(twice)).toBe(sectionStateText(once));
  });
});

describe('applySectionTextEdit (AC3)', () => {
  it('non-edited sections are byte-identical after the merge', () => {
    const sections = splitDocIntoSections(DOC);
    const editedIndex = 1;
    const base = sections[editedIndex]!;

    // One section receives two concurrent edits; every other section is
    // carried through untouched.
    const seed = seedSectionState(base);
    const updateA = makeSectionEditUpdate(seed, '\n\nAgent A concurrent edit.\n');
    const updateB = makeSectionEditUpdate(seed, '\n\nAgent B concurrent edit.\n');
    const merged = sectionStateText(mergeSectionUpdates(seed, [updateA, updateB]));

    const mergedDoc = sections.map((s, i) => (i === editedIndex ? merged : s));
    for (const [i, section] of sections.entries()) {
      if (i === editedIndex) continue;
      expect(mergedDoc[i]).toBe(section);
    }
    expect(joinSections(mergedDoc)).toContain('Agent A concurrent edit.');
    expect(joinSections(mergedDoc)).toContain('Agent B concurrent edit.');
  });

  it('null stored state seeds from the new text', () => {
    const { snapshot, changed } = applySectionTextEdit(null, '## New\n\nbody', null);
    expect(changed).toBe(true);
    expect(sectionStateText(snapshot)).toBe('## New\n\nbody');
  });

  it('unchanged text is a no-op and keeps the same snapshot bytes', () => {
    const stored = seedSectionState('## Same\n\nbody');
    const { snapshot, changed } = applySectionTextEdit(
      stored,
      '## Same\n\nbody',
      '## Same\n\nbody',
    );
    expect(changed).toBe(false);
    expect(snapshot.equals(stored)).toBe(true);
  });

  it('T13589 single-writer mid-text replace projects the input EXACTLY', () => {
    // The probed case: stored == head text, so this is an ordinary edit.
    // The primitives can only append, so re-seeding is the honest encoding —
    // the result must be byte-identical to the authored input, never a
    // fabricated concatenation.
    const current = '## Title\nabc XYZ def';
    const stored = seedSectionState(current);
    const authored = '## Title\nabc 123 def';
    const { snapshot, changed } = applySectionTextEdit(stored, authored, current);
    expect(changed).toBe(true);
    expect(sectionStateText(snapshot)).toBe(authored);
  });

  it('T13589 single-writer tail deletion applies exactly', () => {
    // The probed deletion case: stored == head text, so the deletion lands.
    const current = '## Cut\n\nkeep this. remove this.';
    const stored = seedSectionState(current);
    const authored = '## Cut\n\nkeep this.';
    const { snapshot, changed } = applySectionTextEdit(stored, authored, current);
    expect(changed).toBe(true);
    expect(sectionStateText(snapshot)).toBe(authored);
  });

  it('concurrent growth composes onto the stored state, preserving the concurrent edit', () => {
    // Stored state carries another writer's concurrent edit (stored text !=
    // head text); the incoming growth merges without losing it.
    const base = seedSectionState('## S\n\nbody');
    const concurrent = makeSectionEditUpdate(base, '\n\nconcurrent note\n');
    const stored = mergeSectionUpdates(base, [concurrent]);
    const storedText = sectionStateText(stored);
    const incoming = `${storedText}\n\nmy addition\n`;

    const { snapshot, changed } = applySectionTextEdit(stored, incoming, '## S\n\nbody');
    expect(changed).toBe(true);
    const mergedText = sectionStateText(snapshot);
    expect(mergedText).toContain('concurrent note');
    expect(mergedText).toContain('my addition');
    expect(mergedText.startsWith(storedText)).toBe(true);
  });

  it('T13595: a concurrent NON-append edit (replace relative to the base) is reported as a conflict, never fabricated', () => {
    // Stored state carries a concurrent edit (stored != head text) and the
    // incoming edit is a replace relative to the base. Append-only
    // primitives cannot express it without inventing text, so the stored
    // state must stand and the caller gets `conflicted: true`.
    const stored = seedSectionState('## Old\n\nold body');
    const { snapshot, changed, conflicted } = applySectionTextEdit(
      stored,
      '## New\n\nnew body',
      '## Head\n\nhead text',
    );
    expect(conflicted).toBe(true);
    expect(changed).toBe(false);
    expect(snapshot.equals(stored)).toBe(true);
    expect(sectionStateText(snapshot)).not.toContain('new body');
  });

  it('T13595: a concurrent deletion relative to the base is reported as a conflict', () => {
    const stored = seedSectionState('## S\n\nbody\n\ntail to delete');
    const { snapshot, changed, conflicted } = applySectionTextEdit(
      stored,
      '## S\n\nbody',
      '## Head\n\nhead text',
    );
    expect(conflicted).toBe(true);
    expect(changed).toBe(false);
    expect(snapshot.equals(stored)).toBe(true);
  });

  it('a concurrent no-op (incoming equals the base text) keeps the stored edit without conflict', () => {
    const base = seedSectionState('## Alpha\n\nalpha body');
    const updateA = makeSectionEditUpdate(base, '\n\nA1\n');
    const storedAfterA = mergeSectionUpdates(base, [updateA]);
    const { snapshot, changed, conflicted } = applySectionTextEdit(
      storedAfterA,
      '## Alpha\n\nalpha body',
      '## Alpha\n\nalpha body',
    );
    expect(conflicted).toBe(false);
    expect(changed).toBe(false);
    expect(snapshot.equals(storedAfterA)).toBe(true);
  });

  it('two concurrent same-base section edits both survive through the edit application', () => {
    // The exact write-path shape (T13585): one writer's edit is unlanded in
    // the stored state (stored != head text); the second writer edited from
    // the head and never saw the first's edit.
    const base = seedSectionState('## Alpha\n\nalpha body');
    const updateA = makeSectionEditUpdate(base, '\n\nA1\n');
    const storedAfterA = mergeSectionUpdates(base, [updateA]);

    const incomingB = '## Alpha\n\nalpha body\n\nB1\n';
    const { snapshot, changed, conflicted } = applySectionTextEdit(
      storedAfterA,
      incomingB,
      '## Alpha\n\nalpha body',
    );
    expect(changed).toBe(true);
    expect(conflicted).toBe(false);
    const mergedText = sectionStateText(snapshot);
    expect(mergedText).toContain('A1');
    expect(mergedText).toContain('B1');
    expect(mergedText.startsWith('## Alpha\n\nalpha body')).toBe(true);
  });

  it('a strict deletion in CONCURRENT mode is reported as a conflict: the stored state stands', () => {
    const stored = seedSectionState('## S\n\nbody\n\ntail to delete');
    const { snapshot, changed, conflicted } = applySectionTextEdit(
      stored,
      '## S\n\nbody',
      '## Head\n\nhead text',
    );
    expect(conflicted).toBe(true);
    expect(changed).toBe(false);
    expect(snapshot.equals(stored)).toBe(true);
  });
});
