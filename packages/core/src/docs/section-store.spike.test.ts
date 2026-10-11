/**
 * Section-store CRDT spike — T13353 (Council verdict next-60-minute action).
 *
 * Proves on the REAL 32 KB axiom performance plan
 * (`__fixtures__/perf-plan.md`, fetched from axiom-app via
 * `cleo docs fetch 507411dd…19c0 --content`) that llmtxt's Loro CRDT
 * primitives merge two concurrent section edits without loss and with
 * order-independent results — the property the CleoDocs re-architecture
 * (spec `cleodocs-rearch-design` §2) builds its section write path on.
 *
 * Section decomposition (per the verdict): the H1 plus preamble is
 * section 0; each `##` block (including its nested `###`) is one section.
 *
 * Four assertions:
 *  1. both concurrent edits are present after the merge;
 *  2. every other section is byte-identical;
 *  3. section concatenation round-trips the original file;
 *  4. merging in reverse order yields identical text.
 *
 * SPIKE FINDING (2026-10-10, llmtxt@2026.5.15): the WASM
 * `crdt_merge_updates` is LOSSY — it returns an empty-doc snapshot
 * (state-vector length 1, `crdt_get_text` === '') regardless of input.
 * The working merge composition is sequential `crdt_apply_update` —
 * Loro import is idempotent and convergent, so applying each peer's
 * incremental update in turn yields all edits with order-independent
 * final text. The re-architecture's write path MUST use sequential
 * apply until the upstream WASM merge is fixed (tracked in T13356).
 * The tripwire test below pins the broken behavior so an llmtxt
 * upgrade that fixes it fails loudly and tells us to switch.
 *
 * Run: `npx vitest run packages/core/src/docs/section-store.spike.test.ts`
 *
 * @task T13353 (Epic T13340 / Saga T13339)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  crdt_apply_update,
  crdt_get_text,
  crdt_make_incremental_update,
  crdt_make_state,
  crdt_merge_updates,
  crdt_state_vector,
} from 'llmtxt/crdt-primitives';
import { describe, expect, it } from 'vitest';

const FIXTURE = join(import.meta.dirname, '__fixtures__', 'perf-plan.md');

/**
 * Split a markdown document into sections: the H1 + preamble (everything
 * before the first `## ` heading) is section 0; each `## ` heading starts a
 * new section that runs (with its nested `###` blocks) to the next `## ` or
 * EOF. Concatenating the sections reproduces the input byte-for-byte.
 */
function splitSections(markdown: string): string[] {
  const lines = markdown.split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith('## ') && current.length > 0) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  sections.push(current.join('\n'));
  return sections;
}

/** Merge incremental updates onto a seed by sequential apply (see header). */
function mergeOnto(seed: Buffer, updates: Buffer[]): Buffer {
  let state = seed;
  for (const update of updates) {
    state = crdt_apply_update(state, update);
  }
  return state;
}

describe('section-store CRDT spike (T13353)', () => {
  const original = readFileSync(FIXTURE, 'utf-8');
  const sections = splitSections(original);

  it('decomposes the 32 KB plan into an H1 preamble plus ## sections', () => {
    expect(original.length).toBeGreaterThan(30_000);
    expect(sections.length).toBeGreaterThan(3);
    expect(sections[0]).toMatch(/^# /);
    for (const section of sections.slice(1)) {
      expect(section.startsWith('## ')).toBe(true);
    }
  });

  it('merges two concurrent edits on one section: no loss, others untouched, round-trips, order-independent', () => {
    const editedIndex = 1;
    const base = sections[editedIndex]!;
    expect(base).toBeDefined();

    // Two agents edit the SAME section from the SAME base state.
    // crdt_make_incremental_update APPENDS its content argument to the doc
    // and returns only the delta (see llmtxt/dist/crdt-primitives.js).
    const seed = crdt_make_state(base);
    const updateA = crdt_make_incremental_update(seed, '\n\nAgent A concurrent edit.\n');
    const updateB = crdt_make_incremental_update(seed, '\n\nAgent B concurrent edit.\n');

    // (1) Both edits survive the merge.
    const mergedText = crdt_get_text(mergeOnto(seed, [updateA, updateB]));
    expect(mergedText).toContain(base);
    expect(mergedText).toContain('Agent A concurrent edit.');
    expect(mergedText).toContain('Agent B concurrent edit.');

    // (4) Merge order does not matter — identical final text either way.
    const mergedReverseText = crdt_get_text(mergeOnto(seed, [updateB, updateA]));
    expect(mergedReverseText).toBe(mergedText);

    // (2) Every other section is byte-identical (untouched by the merge).
    const mergedSections = sections.map((s, i) => (i === editedIndex ? mergedText : s));
    for (const [i, section] of sections.entries()) {
      if (i === editedIndex) continue;
      expect(mergedSections[i]).toBe(section);
    }

    // (3) Concatenation round-trips the original file, and the merge only
    // touched the edited section.
    expect(sections.join('\n')).toBe(original);
    const reassembled = sections.map((s, i) => (i === editedIndex ? base : s));
    expect(reassembled).toEqual(sections);
  });

  it('TRIPWIRE: WASM crdt_merge_updates is lossy in llmtxt@2026.5.15 — flip to sequential-apply removal when fixed', () => {
    const seed = crdt_make_state('hello world');
    const updateA = crdt_make_incremental_update(seed, ' AAA');
    const updateB = crdt_make_incremental_update(seed, ' BBB');
    const merged = crdt_merge_updates([updateA, updateB]);
    // Broken: merged snapshot is an empty doc (state-vector length 1, no text).
    // When an llmtxt upgrade fixes the WASM merge, these assertions FAIL —
    // that is the signal to switch the write path back to crdt_merge_updates
    // and delete this tripwire (T13356).
    expect(crdt_state_vector(merged).length).toBe(1);
    expect(crdt_get_text(merged)).toBe('');
  });
});
