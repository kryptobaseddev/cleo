/**
 * Regression tests for gh#1215 — "Decision-only tasks cannot complete:
 * testsPassed/qaPassed demanded on tasks with no code change".
 *
 * ADR-051 lets `implemented` be satisfied by `[decision, files]` or
 * `[decision, note]` — the shape of a pure audit: read code, record findings,
 * change nothing. But `testsPassed` accepts only `test-run | tool | pr` and
 * `qaPassed` only `tool | pr`, so such a task could never complete. Every
 * remaining escape is unusable by construction: `tool:test` is meaningless for
 * a task that changed nothing, and `CLEO_OWNER_OVERRIDE` is session-capped and
 * rejected on critical gates anyway.
 *
 * A decision-only task has no tests to run and nothing to lint, so those gates
 * are satisfied by ABSENCE — the same reasoning as the T12083 `notApplicable`
 * tool atom.
 *
 * The exemption is deliberately narrow, and these tests pin that: a `commit:`
 * or `pr:` atom means code DID change, and the normal gates apply in full.
 *
 * @task T12125 (gh#1215)
 */

import { describe, expect, it } from 'vitest';
import { DECISION_ONLY_INAPPLICABLE_GATES, isDecisionOnlyImplementation } from '../evidence.js';

describe('gh#1215 — decision-only implementations', () => {
  it('recognises [decision, files] as decision-only', () => {
    expect(isDecisionOnlyImplementation({ atoms: [{ kind: 'decision' }, { kind: 'files' }] })).toBe(
      true,
    );
  });

  it('recognises [decision, note] as decision-only', () => {
    expect(isDecisionOnlyImplementation({ atoms: [{ kind: 'decision' }, { kind: 'note' }] })).toBe(
      true,
    );
  });

  it('exempts exactly testsPassed and qaPassed, and nothing else', () => {
    expect([...DECISION_ONLY_INAPPLICABLE_GATES]).toEqual(['testsPassed', 'qaPassed']);
  });
});

describe('gh#1215 — the exemption must not be reachable by weaker evidence', () => {
  it('a commit atom disqualifies it — code changed, gates apply in full', () => {
    expect(
      isDecisionOnlyImplementation({
        atoms: [{ kind: 'decision' }, { kind: 'commit' }, { kind: 'files' }],
      }),
    ).toBe(false);
  });

  it('a pr atom disqualifies it', () => {
    expect(isDecisionOnlyImplementation({ atoms: [{ kind: 'decision' }, { kind: 'pr' }] })).toBe(
      false,
    );
  });

  it('requires a decision atom — files alone is not decision-only', () => {
    expect(isDecisionOnlyImplementation({ atoms: [{ kind: 'files' }] })).toBe(false);
  });

  it('an override alone is not decision-only', () => {
    // Otherwise the session-capped override would become an unlimited bypass
    // of two gates rather than a one-shot audited exception.
    expect(isDecisionOnlyImplementation({ atoms: [{ kind: 'override' }] })).toBe(false);
  });

  it('no implemented evidence at all is not decision-only', () => {
    expect(isDecisionOnlyImplementation(null)).toBe(false);
    expect(isDecisionOnlyImplementation(undefined)).toBe(false);
    expect(isDecisionOnlyImplementation({ atoms: [] })).toBe(false);
  });
});
