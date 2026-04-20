/**
 * Unit tests for the `selectTier` / `resolveEffectiveTier` auto-tier
 * selection functions (T892).
 *
 * Coverage:
 * - 3×3 matrix: role (orchestrator/lead/worker) × size (small/medium/large)
 * - Epic type override
 * - Label overrides (research, spec)
 * - Explicit tier always wins
 * - Cap at 2 (no tier 3)
 *
 * @task T892 — Auto-tier selection
 * @epic T889 — Orchestration Coherence v3
 */

import { describe, expect, it } from 'vitest';
import { resolveEffectiveTier, selectTier, type TierSelectInput } from '../tier-selector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function task(overrides: Partial<TierSelectInput> = {}): TierSelectInput {
  return { size: 'medium', type: 'task', labels: [], ...overrides };
}

// ---------------------------------------------------------------------------
// Base matrix: role × size
// ---------------------------------------------------------------------------

describe('selectTier — base matrix (role × size)', () => {
  // orchestrator base = 2, no overrides for small/medium
  it('orchestrator + small → 2 (base, no override)', () => {
    expect(selectTier(task({ size: 'small' }), 'orchestrator')).toBe(2);
  });

  it('orchestrator + medium → 2 (base, no override)', () => {
    expect(selectTier(task({ size: 'medium' }), 'orchestrator')).toBe(2);
  });

  it('orchestrator + large → 2 (base already at cap)', () => {
    // base=2, +1 for large → cap at 2
    expect(selectTier(task({ size: 'large' }), 'orchestrator')).toBe(2);
  });

  // lead base = 1
  it('lead + small → 1 (base, no override)', () => {
    expect(selectTier(task({ size: 'small' }), 'lead')).toBe(1);
  });

  it('lead + medium → 1 (base, no override)', () => {
    expect(selectTier(task({ size: 'medium' }), 'lead')).toBe(1);
  });

  it('lead + large → 2 (base=1, size=large bumps +1)', () => {
    expect(selectTier(task({ size: 'large' }), 'lead')).toBe(2);
  });

  // worker base = 0
  it('worker + small → 0 (base, no override)', () => {
    expect(selectTier(task({ size: 'small' }), 'worker')).toBe(0);
  });

  it('worker + medium → 0 (base, no override)', () => {
    expect(selectTier(task({ size: 'medium' }), 'worker')).toBe(0);
  });

  it('worker + large → 1 (base=0, size=large bumps +1)', () => {
    expect(selectTier(task({ size: 'large' }), 'worker')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Epic type override
// ---------------------------------------------------------------------------

describe('selectTier — type=epic override', () => {
  it('worker + epic type → 1 (base=0, +1 for epic)', () => {
    expect(selectTier(task({ type: 'epic' }), 'worker')).toBe(1);
  });

  it('lead + epic type → 2 (base=1, +1 for epic)', () => {
    expect(selectTier(task({ type: 'epic' }), 'lead')).toBe(2);
  });

  it('orchestrator + epic type → 2 (base=2, cap)', () => {
    expect(selectTier(task({ type: 'epic' }), 'orchestrator')).toBe(2);
  });

  it('worker + large + epic → 1 (only one +1 for size/type, not stacked)', () => {
    // Overrides 1 and 1 both fire but tier is integer math: 0 + 1 (size) + 1 (epic) = 2? No —
    // spec says size=large OR type=epic is ONE override (+1 once). Let's test both together
    // to document the real behavior: spec says they share the same override block.
    expect(selectTier(task({ size: 'large', type: 'epic' }), 'worker')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Label overrides
// ---------------------------------------------------------------------------

describe('selectTier — label overrides (research / spec)', () => {
  it('worker + research label → 1 (base=0, +1 for research)', () => {
    expect(selectTier(task({ labels: ['research'] }), 'worker')).toBe(1);
  });

  it('worker + spec label → 1 (base=0, +1 for spec)', () => {
    expect(selectTier(task({ labels: ['spec'] }), 'worker')).toBe(1);
  });

  it('lead + research label → 2 (base=1, +1 for research)', () => {
    expect(selectTier(task({ labels: ['research'] }), 'lead')).toBe(2);
  });

  it('worker + other labels only → 0 (no override)', () => {
    expect(selectTier(task({ labels: ['orchestration', 'spawn'] }), 'worker')).toBe(0);
  });

  it('worker + large + research → 2 (size+1 then label+1)', () => {
    // size=large → tier=0+1=1, then research → tier=1+1=2
    expect(selectTier(task({ size: 'large', labels: ['research'] }), 'worker')).toBe(2);
  });

  it('cap at 2 when all overrides apply', () => {
    // orchestrator=2, large+1(cap), research+1(cap) — all cap at 2
    expect(
      selectTier(
        task({ size: 'large', type: 'epic', labels: ['research', 'spec'] }),
        'orchestrator',
      ),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Null / undefined safety
// ---------------------------------------------------------------------------

describe('selectTier — null/undefined safety', () => {
  it('null size → treated as no override', () => {
    expect(selectTier(task({ size: null }), 'worker')).toBe(0);
  });

  it('null labels → treated as empty array', () => {
    expect(selectTier(task({ labels: null }), 'worker')).toBe(0);
  });

  it('missing fields entirely → no override', () => {
    expect(selectTier({}, 'worker')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveTier — explicit tier wins
// ---------------------------------------------------------------------------

describe('resolveEffectiveTier — explicit tier always wins', () => {
  it('explicit tier=0 overrides orchestrator role', () => {
    expect(resolveEffectiveTier(task(), 'orchestrator', 0)).toBe(0);
  });

  it('explicit tier=2 overrides worker role', () => {
    expect(resolveEffectiveTier(task(), 'worker', 2)).toBe(2);
  });

  it('explicit tier=1 overrides worker + large', () => {
    expect(resolveEffectiveTier(task({ size: 'large' }), 'worker', 1)).toBe(1);
  });

  it("explicit tier='auto' falls through to selectTier", () => {
    // 'auto' sentinel → selectTier(worker, medium) = 0
    expect(resolveEffectiveTier(task(), 'worker', 'auto')).toBe(0);
  });

  it('undefined explicit tier falls through to selectTier', () => {
    expect(resolveEffectiveTier(task(), 'worker', undefined)).toBe(0);
  });

  it("'auto' + large worker → 1 (selectTier runs)", () => {
    expect(resolveEffectiveTier(task({ size: 'large' }), 'worker', 'auto')).toBe(1);
  });
});
