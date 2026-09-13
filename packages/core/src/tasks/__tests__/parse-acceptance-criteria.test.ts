/**
 * Regression tests for `parseAcceptanceCriteria` — the canonical acceptance
 * criteria tokenizer used by `cleo add`, `cleo update`, and `cleo saga create`.
 *
 * Covers:
 * - Basic pipe-split behaviour (trim, drop empties)
 * - gh-409 corruption shapes (T237/T239/T240) — pipes inside parens, quoted
 *   string-unions, escape sequences, nested brackets
 * - JSON-array fast-path preservation
 * - Defensive handling of malformed input (unbalanced brackets, empty/whitespace)
 *
 * @bug https://github.com/kryptobaseddev/cleo/issues/409
 * @task T9839
 */

import { describe, expect, it } from 'vitest';
import { parseAcceptanceCriteria } from '../infer-add-params.js';

describe('parseAcceptanceCriteria', () => {
  // ─── Baseline pipe-split behaviour ────────────────────────────────────────
  it('splits a plain pipe-delimited string', () => {
    expect(parseAcceptanceCriteria('A|B|C')).toEqual(['A', 'B', 'C']);
  });

  it('trims whitespace around each token', () => {
    expect(parseAcceptanceCriteria('  A | B  ')).toEqual(['A', 'B']);
  });

  it('drops empty tokens between consecutive delimiters', () => {
    expect(parseAcceptanceCriteria('A||B')).toEqual(['A', 'B']);
  });

  it('returns an empty array for empty input', () => {
    expect(parseAcceptanceCriteria('')).toEqual([]);
  });

  it('returns an empty array for whitespace-only input', () => {
    expect(parseAcceptanceCriteria('   ')).toEqual([]);
  });

  // ─── gh-409 regression — pipes inside parens / brackets ───────────────────
  it('gh-409 (T237): preserves ENUM (hot|cold|batch|embed) as one token', () => {
    expect(parseAcceptanceCriteria('AC1|ENUM (hot|cold|batch|embed)|AC2')).toEqual([
      'AC1',
      'ENUM (hot|cold|batch|embed)',
      'AC2',
    ]);
  });

  it('gh-409 (T240): preserves ENUM(passed|advisory|none) with no space', () => {
    expect(parseAcceptanceCriteria('AC1|bench_status ENUM(passed|advisory|none)|AC2')).toEqual([
      'AC1',
      'bench_status ENUM(passed|advisory|none)',
      'AC2',
    ]);
  });

  it("gh-409 (T239): preserves quoted string-union mode: 'realtime-token'|'batch'", () => {
    expect(parseAcceptanceCriteria("AC1|mode: 'realtime-token'|'batch'|AC2")).toEqual([
      'AC1',
      "mode: 'realtime-token'|'batch'",
      'AC2',
    ]);
  });

  it('preserves nested brackets [...] (...) with embedded pipes', () => {
    expect(parseAcceptanceCriteria('AC1|a[b|c](d|e)|AC2')).toEqual(['AC1', 'a[b|c](d|e)', 'AC2']);
  });

  it('preserves curly-brace groups with embedded pipes', () => {
    expect(parseAcceptanceCriteria('AC1|union {x|y|z}|AC2')).toEqual([
      'AC1',
      'union {x|y|z}',
      'AC2',
    ]);
  });

  it('preserves double-quoted string-unions', () => {
    expect(parseAcceptanceCriteria('AC1|type: "a"|"b"|AC2')).toEqual([
      'AC1',
      'type: "a"|"b"',
      'AC2',
    ]);
  });

  // ─── Escape semantics ─────────────────────────────────────────────────────
  it('treats backslash-pipe as a literal pipe at depth 0', () => {
    // Raw input: AC1\|literal|AC2  →  ["AC1|literal", "AC2"]
    expect(parseAcceptanceCriteria('AC1\\|literal|AC2')).toEqual(['AC1|literal', 'AC2']);
  });

  // ─── JSON-array fast-path ─────────────────────────────────────────────────
  it('JSON-array fast-path: preserves pipes inside string values', () => {
    expect(parseAcceptanceCriteria('["A","B|C","D"]')).toEqual(['A', 'B|C', 'D']);
  });

  it('JSON-array fast-path: trims and drops empty entries', () => {
    expect(parseAcceptanceCriteria('["  A  ","","B"]')).toEqual(['A', 'B']);
  });

  it('JSON-array fast-path: falls through to pipe tokenizer on malformed JSON', () => {
    // Starts with `[` but isn't valid JSON → falls through to the pipe
    // tokenizer, as before.
    //
    // BEHAVIOUR CHANGED (gh#1321). This previously asserted the whole input as
    // one token, because the unterminated `[` opened bracket scope and
    // swallowed the delimiter. The leading `[` has no partner, so it groups
    // nothing and is now a literal — which recovers the two criteria the caller
    // plainly wrote.
    expect(parseAcceptanceCriteria('[not-json|AC2')).toEqual(['[not-json', 'AC2']);
  });

  it('JSON-array fast-path: falls through when leading `[` is followed by depth-0 pipe outside bracket scope', () => {
    // After malformed JSON parse, a pipe AFTER a balanced bracket span still
    // splits correctly at depth 0.
    expect(parseAcceptanceCriteria('[not-json]|AC2')).toEqual(['[not-json]', 'AC2']);
  });

  // ─── Defensive: malformed bracket inputs must NOT throw or infinite-loop ──
  // ── gh#1321 — a prose apostrophe must not swallow the rest ────────────────

  it('splits normally when a criterion contains a contraction', () => {
    // The reported defect. `doesn't` opened a quote context nothing could
    // close, so every later `|` was absorbed: this returned 2 tokens.
    expect(parseAcceptanceCriteria("ac one|the user doesn't care|ac three")).toEqual([
      'ac one',
      "the user doesn't care",
      'ac three',
    ]);
  });

  it('splits normally when a criterion contains a possessive', () => {
    expect(parseAcceptanceCriteria("ac one|the user's token|ac three")).toEqual([
      'ac one',
      "the user's token",
      'ac three',
    ]);
  });

  it('splits normally with TWO contractions, which used to balance into a wrong answer', () => {
    // Two apostrophes accidentally paired across the delimiter, producing a
    // DIFFERENT wrong answer (3 tokens with `doesn't|can't` merged) rather than
    // an obviously broken one. That is why the failure looked erratic across
    // samples instead of systematic.
    expect(parseAcceptanceCriteria("ac one|doesn't|can't|ac four")).toEqual([
      'ac one',
      "doesn't",
      "can't",
      'ac four',
    ]);
  });

  it('is INSENSITIVE to input length — the reported hypothesis was a correlation', () => {
    // The report attributed the defect to input length. 804 characters of clean
    // input always split correctly; an unmatched quote absorbs the REMAINDER, so
    // length governed how much was lost, not whether anything was.
    const long = `${'x'.repeat(200)}|`.repeat(4) + 'end';
    expect(parseAcceptanceCriteria(long)).toHaveLength(5);
  });

  it('still keeps gh#409 quoted string-unions as one token', () => {
    // The rule this fix narrows exists for a reason; it must survive. These
    // quotes are balanced by construction, and sit at token boundaries.
    expect(parseAcceptanceCriteria("a|'realtime-token'|'batch'|c")).toEqual([
      'a',
      "'realtime-token'|'batch'",
      'c',
    ]);
  });

  it('splits normally across an unbalanced opening bracket', () => {
    // BEHAVIOUR CHANGED (gh#1321). This previously asserted
    // `['AC1', '(unclosed|AC2']` — the old tokenizer opened bracket scope at
    // `(`, found no partner, and absorbed the remainder into one token. That
    // expectation pinned the corruption: a stray `(` in prose silently merged
    // every criterion after it.
    //
    // An unbalanced bracket groups nothing, so it is now treated as a literal
    // and the delimiters after it still split.
    expect(() => parseAcceptanceCriteria('AC1|(unclosed|AC2')).not.toThrow();
    expect(parseAcceptanceCriteria('AC1|(unclosed|AC2')).toEqual(['AC1', '(unclosed', 'AC2']);
  });

  it('tolerates unbalanced closing bracket (no underflow)', () => {
    // Stray `)` at depth 0 — the Math.max(0, depth-1) guard keeps depth at 0,
    // so the subsequent `|` still splits normally.
    expect(() => parseAcceptanceCriteria('AC1)|AC2')).not.toThrow();
    expect(parseAcceptanceCriteria('AC1)|AC2')).toEqual(['AC1)', 'AC2']);
  });

  it('terminates on a pathologically long input (loop bound)', () => {
    // 10k tokens — proves the loop is bounded by input.length.
    const input = Array.from({ length: 10_000 }, (_, n) => `AC${n}`).join('|');
    expect(parseAcceptanceCriteria(input)).toHaveLength(10_000);
  });
});
