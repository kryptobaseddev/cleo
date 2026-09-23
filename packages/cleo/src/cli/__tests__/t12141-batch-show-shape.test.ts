/**
 * T12141 follow-up — a batch collection holds RECORDS, not envelopes.
 *
 * Shipped in v2026.9.15 and caught on the installed binary: `cleo show T1 T2`
 * returned two elements that each looked like `{ task: { id, title, … } }`,
 * because the batch loop pushed the whole `tasks.show` payload. Nothing in
 * `tasks[]` carried `id`, so `--output table` printed a header over blank rows
 * and `--output id` refused with E_OUTPUT_IDENTITY_UNDECLARED — that refusal
 * was correct, and is the only reason this was visible at all rather than
 * emitting an empty stream that reads as "no results".
 *
 * @task T12141
 */

import { describe, expect, it } from 'vitest';
import { unwrapShowRecord } from '../commands/show.js';

describe('T12141 — batch show elements are task records', () => {
  it('unwraps the single-show envelope to the record itself', () => {
    const record = { id: 'T1', title: 'a task', status: 'done' };
    expect(unwrapShowRecord({ task: record })).toBe(record);
  });

  it('passes a bare record through, so it cannot double-unwrap', () => {
    const record = { id: 'T1', title: 'a task' };
    expect(unwrapShowRecord(record)).toBe(record);
  });

  it('leaves a payload whose task is not an object alone', () => {
    // Defensive: unwrapping a null/scalar `task` would substitute a value that
    // carries no identity, which is the failure this exists to prevent.
    const odd = { task: null };
    expect(unwrapShowRecord(odd)).toBe(odd);
    const scalar = { task: 'T1' };
    expect(unwrapShowRecord(scalar)).toBe(scalar);
  });

  it('passes non-objects through unchanged', () => {
    expect(unwrapShowRecord(null)).toBeNull();
    expect(unwrapShowRecord(42)).toBe(42);
  });

  it('yields elements that carry the default identity field', () => {
    // The concrete property the projections need: every element answers `id`.
    const batch = [{ task: { id: 'T1' } }, { task: { id: 'T2' } }].map(unwrapShowRecord);
    expect(batch.every((r) => typeof r === 'object' && r !== null && 'id' in r)).toBe(true);
  });
});
