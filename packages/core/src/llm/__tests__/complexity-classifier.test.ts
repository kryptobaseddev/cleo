/**
 * Unit tests for the L1 complexity classifier (T11906).
 *
 * Ports the test corpus of the deleted Rust `cant-router` classifier
 * (`features.rs` + `classifier.rs`) plus the tier→role wiring (AC2/AC3).
 *
 * @task T11906
 * @epic T11745
 */

import { describe, expect, it } from 'vitest';
import {
  type ComplexityTier,
  classify,
  classifyComplexity,
  complexityTierToRole,
  escalateTier,
  extractFeatures,
  type PromptFeatures,
  proposeRoleForPrompt,
  THRESHOLD_HIGH,
  THRESHOLD_MID,
} from '../complexity-classifier.js';

// ---------------------------------------------------------------------------
// Feature extraction (ported from features.rs tests)
// ---------------------------------------------------------------------------

describe('extractFeatures — five prompt features (ported from features.rs)', () => {
  it('counts tokens', () => {
    expect(extractFeatures('hello world this is a test').tokenCount).toBe(6);
  });

  it('counts tokens for an empty string as 0', () => {
    expect(extractFeatures('').tokenCount).toBe(0);
  });

  it('counts tokens for whitespace-only as 0', () => {
    expect(extractFeatures('   \t  \n ').tokenCount).toBe(0);
  });

  it('counts reasoning keywords', () => {
    // why, should, compare, decide = 4
    const f = extractFeatures('Why should we compare these options and decide?');
    expect(f.reasoningDepth).toBe(4);
  });

  it('counts reasoning keywords case-insensitively', () => {
    // analyze, evaluate, tradeoff = 3
    const f = extractFeatures('ANALYZE and EVALUATE the tradeoff');
    expect(f.reasoningDepth).toBe(3);
  });

  it('counts no reasoning keywords for a plain prompt', () => {
    expect(extractFeatures('list the files in this directory').reasoningDepth).toBe(0);
  });

  it('counts file references by slash', () => {
    // src/main.ts has '/', docs/README.md has '/' — 2 refs
    const f = extractFeatures('Update src/main.ts and docs/README.md please');
    expect(f.touchesFilesCount).toBe(2);
  });

  it('counts file references by extension', () => {
    const f = extractFeatures('Edit foo.rs bar.ts baz.md config.json');
    expect(f.touchesFilesCount).toBe(4);
  });

  it('estimates syntactic complexity as 0 for a flat prompt', () => {
    expect(extractFeatures('simple flat prompt').syntacticComplexity).toBeCloseTo(0.0, 10);
  });

  it('estimates syntactic complexity from nested bracket depth', () => {
    // max depth 3, 3/5 = 0.6
    expect(extractFeatures('nested ((( three )))').syntacticComplexity).toBeCloseTo(0.6, 10);
  });

  it('clamps syntactic complexity to 1.0', () => {
    expect(extractFeatures('deeply (((((((( nested ))))))))').syntacticComplexity).toBeCloseTo(
      1.0,
      10,
    );
  });

  it('treats mixed bracket kinds as one depth stack', () => {
    // ( [ { -> depth 3 -> 0.6
    expect(extractFeatures('a ([{ b }]) c').syntacticComplexity).toBeCloseTo(0.6, 10);
  });

  it('never drives bracket depth negative on unbalanced closers', () => {
    // leading closers must not underflow; one '(' -> depth 1 -> 0.2
    expect(extractFeatures(')))) ( ').syntacticComplexity).toBeCloseTo(0.2, 10);
  });

  it('estimates domain specificity as 0 for plain english', () => {
    expect(extractFeatures('plain english prompt').domainSpecificity).toBeCloseTo(0.0, 10);
  });

  it('estimates domain specificity from CamelCase density', () => {
    // 2 camel-case tokens / 10 = 0.2
    const f = extractFeatures('use ModelSelection and RoutingObservation');
    expect(f.domainSpecificity).toBeCloseTo(0.2, 10);
  });

  it('does not count a single-capital token as domain-specific', () => {
    // "Refactor" has only one uppercase letter -> not counted
    expect(extractFeatures('Refactor the code').domainSpecificity).toBeCloseTo(0.0, 10);
  });
});

// ---------------------------------------------------------------------------
// Classifier (ported from classifier.rs tests)
// ---------------------------------------------------------------------------

/** Helper — build a PromptFeatures with explicit fields. */
function features(
  tokenCount: number,
  syntacticComplexity: number,
  reasoningDepth: number,
  domainSpecificity: number,
  touchesFilesCount: number,
): PromptFeatures {
  return {
    tokenCount,
    syntacticComplexity,
    reasoningDepth,
    domainSpecificity,
    touchesFilesCount,
  };
}

describe('classify — linear weighted classifier (ported from classifier.rs)', () => {
  it('maps a near-zero feature vector to the low tier', () => {
    const result = classify(features(5, 0.0, 0, 0.0, 0));
    expect(result.tier).toBe('low');
    expect(result.score).toBeLessThan(THRESHOLD_MID);
  });

  it('maps a moderate feature vector to the mid tier', () => {
    // 0.15*0.8 + 0.25*0.5 + 0.30*0.4 + 0.20*0.5 + 0.10*0.3 = 0.495
    const result = classify(features(800, 0.5, 4, 0.5, 6));
    expect(result.tier).toBe('mid');
    expect(result.score).toBeGreaterThanOrEqual(THRESHOLD_MID);
    expect(result.score).toBeLessThan(THRESHOLD_HIGH);
  });

  it('maps a maximally-complex feature vector to the high tier', () => {
    // Saturates every normalizer: 0.15+0.25+0.30+0.20+0.10 = 1.00
    const result = classify(features(2000, 1.0, 20, 1.0, 30));
    expect(result.tier).toBe('high');
    expect(result.score).toBeGreaterThanOrEqual(THRESHOLD_HIGH);
  });

  it('lands on mid at exactly the 0.35 boundary', () => {
    // domain 1.0 (0.20) + reasoning 5 (0.5*0.30 = 0.15) = 0.35 exactly
    const result = classify(features(0, 0.0, 5, 1.0, 0));
    expect(result.score).toBeCloseTo(0.35, 9);
    expect(result.tier).toBe('mid');
  });

  it('lands on high at exactly the 0.75 boundary', () => {
    // syntactic 1.0 (0.25) + reasoning 10 (0.30) + domain 1.0 (0.20) = 0.75 exactly
    const result = classify(features(0, 1.0, 10, 1.0, 0));
    expect(result.score).toBeCloseTo(0.75, 9);
    expect(result.tier).toBe('high');
  });

  it('lands on low just below the 0.35 boundary', () => {
    // domain 1.0 (0.20) + reasoning 4 (0.4*0.30 = 0.12) = 0.32 < 0.35
    const result = classify(features(0, 0.0, 4, 1.0, 0));
    expect(result.score).toBeCloseTo(0.32, 9);
    expect(result.tier).toBe('low');
  });

  it('lands on mid just below the 0.75 boundary', () => {
    // syntactic 1.0 (0.25) + reasoning 10 (0.30) + domain 0.9 (0.18) = 0.73 < 0.75
    const result = classify(features(0, 1.0, 10, 0.9, 0));
    expect(result.score).toBeCloseTo(0.73, 9);
    expect(result.tier).toBe('mid');
  });

  it('preserves the input feature vector', () => {
    const result = classify(features(123, 0.5, 4, 0.7, 9));
    expect(result.features.tokenCount).toBe(123);
    expect(result.features.reasoningDepth).toBe(4);
    expect(result.features.touchesFilesCount).toBe(9);
  });

  it('saturates the score at 1.0 for extreme values', () => {
    const result = classify(
      features(
        Number.MAX_SAFE_INTEGER,
        999.0,
        Number.MAX_SAFE_INTEGER,
        999.0,
        Number.MAX_SAFE_INTEGER,
      ),
    );
    expect(result.score).toBeLessThanOrEqual(1.0 + Number.EPSILON);
    expect(result.tier).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// End-to-end tier boundaries: trivial → simple → moderate → complex → expert
// ---------------------------------------------------------------------------

describe('classifyComplexity — prompt → tier boundaries', () => {
  it('classifies a trivial prompt as low', () => {
    expect(classifyComplexity('hi')).toBe('low');
  });

  it('classifies a simple prompt as low', () => {
    expect(classifyComplexity('list the files in src')).toBe('low');
  });

  it('keeps a SHORT reasoning prompt at low (token normalizer dominates)', () => {
    // The token-count normalizer divides by 1000, so a short prompt — even one
    // dense in reasoning keywords and identifiers — scores below 0.35. This
    // mirrors the Rust normalizers faithfully: complexity needs VOLUME, not just
    // a couple of keywords.
    const tier = classifyComplexity(
      'Why should we compare ModelSelection and RoutingObservation and decide the trade-off?',
    );
    expect(tier).toBe('low');
  });

  it('classifies a moderate-volume reasoning prompt as mid', () => {
    // ~700 tokens of filler (0.15*0.7 = 0.105) + reasoning keywords (≥5 → 0.15)
    // + CamelCase identifiers (≥4 → ≥0.08) + a couple files clears 0.35 but not 0.75.
    const reasoning = 'why should we compare decide evaluate the trade-off';
    const identifiers = 'ModelSelection RoutingObservation PromptFeatures TierLadder';
    const files = 'src/a.ts src/b.ts';
    const filler = 'word '.repeat(700);
    const tier = classifyComplexity(`${reasoning} ${identifiers} ${files} ${filler}`);
    expect(tier).toBe('mid');
  });

  it('classifies a complex multi-signal prompt as high', () => {
    // Long, bracket-nested, reasoning-heavy, identifier-dense, many files.
    const brackets = '((((( deeply nested logic )))))';
    const reasoning =
      'why should we analyze evaluate consider compare decide explain the tradeoff and trade-off';
    const identifiers = Array.from({ length: 12 }, (_, i) => `ModelSelection${i}`).join(' ');
    const files = Array.from({ length: 25 }, (_, i) => `src/mod${i}.ts`).join(' ');
    const filler = 'word '.repeat(1200);
    const tier = classifyComplexity(`${brackets} ${reasoning} ${identifiers} ${files} ${filler}`);
    expect(tier).toBe('high');
  });

  it('produces a monotonically non-decreasing tier across the complexity ladder', () => {
    const order: Record<ComplexityTier, number> = { low: 0, mid: 1, high: 2 };
    const trivial = classifyComplexity('hi');
    const moderate = classifyComplexity(
      'Why should we compare ModelSelection and decide src/a.ts vs src/b.ts?',
    );
    expect(order[moderate]).toBeGreaterThanOrEqual(order[trivial]);
  });
});

// ---------------------------------------------------------------------------
// Tier escalation (ported from types.rs Tier::escalate)
// ---------------------------------------------------------------------------

describe('escalateTier — ladder escalation (ported from Tier::escalate)', () => {
  it('escalates low → mid', () => {
    expect(escalateTier('low')).toBe('mid');
  });

  it('escalates mid → high', () => {
    expect(escalateTier('mid')).toBe('high');
  });

  it('returns null at the top of the ladder', () => {
    expect(escalateTier('high')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tier → role wiring (AC2)
// ---------------------------------------------------------------------------

describe('complexityTierToRole — tier → RoleName proposer (AC2)', () => {
  it('maps low → hygiene', () => {
    expect(complexityTierToRole('low')).toBe('hygiene');
  });

  it('maps mid → consolidation', () => {
    expect(complexityTierToRole('mid')).toBe('consolidation');
  });

  it('maps high → judgement', () => {
    expect(complexityTierToRole('high')).toBe('judgement');
  });
});

describe('proposeRoleForPrompt — prompt → tier → role composition (AC2)', () => {
  it('proposes the cheap role for a trivial prompt', () => {
    expect(proposeRoleForPrompt('hi')).toBe('hygiene');
  });

  it('proposes the most-capable role for a maximally-complex prompt', () => {
    const brackets = '((((( deeply nested )))))';
    const reasoning =
      'why should we analyze evaluate consider compare decide explain the tradeoff and trade-off';
    const identifiers = Array.from({ length: 12 }, (_, i) => `ModelSelection${i}`).join(' ');
    const files = Array.from({ length: 25 }, (_, i) => `src/mod${i}.ts`).join(' ');
    const filler = 'word '.repeat(1200);
    expect(proposeRoleForPrompt(`${brackets} ${reasoning} ${identifiers} ${files} ${filler}`)).toBe(
      'judgement',
    );
  });

  it('agrees with classifyComplexity + complexityTierToRole', () => {
    const prompt = 'Why should we compare ModelSelection and decide src/a.ts?';
    expect(proposeRoleForPrompt(prompt)).toBe(complexityTierToRole(classifyComplexity(prompt)));
  });
});
