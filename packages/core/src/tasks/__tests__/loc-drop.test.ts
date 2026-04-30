/**
 * Unit tests for the `loc-drop` evidence atom (T1604).
 *
 * Covers:
 * - parseEvidence: valid loc-drop atom, malformed format, non-integer values,
 *   negative values, zero fromLines
 * - validateAtom: green path, toLines > fromLines rejection
 * - checkEngineMigrationLocDrop: missing atom, below threshold, above threshold
 * - hasEngineMigrationLabel: present, absent, null/undefined input
 *
 * @task T1604
 */

import { describe, expect, it } from 'vitest';
import {
  ENGINE_MIGRATION_LABEL,
  hasEngineMigrationLabel,
} from '../../verification/evidence-atoms.js';
import {
  checkEngineMigrationLocDrop,
  ENGINE_MIGRATION_MIN_REDUCTION_PCT,
  parseEvidence,
  validateAtom,
} from '../evidence.js';

// ---------------------------------------------------------------------------
// parseEvidence — loc-drop syntax
// ---------------------------------------------------------------------------

describe('parseEvidence — loc-drop atom (T1604)', () => {
  it('parses a valid loc-drop atom', () => {
    const result = parseEvidence('loc-drop:1200:800');
    expect(result.atoms).toHaveLength(1);
    expect(result.atoms[0]).toEqual({ kind: 'loc-drop', fromLines: 1200, toLines: 800 });
  });

  it('parses loc-drop combined with other atoms', () => {
    const result = parseEvidence('commit:abc1234;note:migrated engine;loc-drop:500:300');
    expect(result.atoms).toHaveLength(3);
    const locDrop = result.atoms[2];
    expect(locDrop).toEqual({ kind: 'loc-drop', fromLines: 500, toLines: 300 });
  });

  it('parses loc-drop where toLines equals fromLines (zero reduction)', () => {
    const result = parseEvidence('loc-drop:100:100');
    expect(result.atoms[0]).toEqual({ kind: 'loc-drop', fromLines: 100, toLines: 100 });
  });

  it('parses loc-drop with toLines of zero', () => {
    const result = parseEvidence('loc-drop:200:0');
    expect(result.atoms[0]).toEqual({ kind: 'loc-drop', fromLines: 200, toLines: 0 });
  });

  it('rejects loc-drop with missing second colon segment', () => {
    expect(() => parseEvidence('loc-drop:1200')).toThrow(/malformed|format/i);
  });

  it('rejects loc-drop with non-integer fromLines', () => {
    expect(() => parseEvidence('loc-drop:abc:800')).toThrow(
      /fromLines.*integer|integer.*fromLines/i,
    );
  });

  it('rejects loc-drop with non-integer toLines', () => {
    expect(() => parseEvidence('loc-drop:1200:xyz')).toThrow(/toLines.*integer|integer.*toLines/i);
  });

  it('rejects loc-drop with negative fromLines', () => {
    expect(() => parseEvidence('loc-drop:-100:50')).toThrow(
      /fromLines.*non-negative|non-negative.*fromLines/i,
    );
  });

  it('rejects loc-drop with negative toLines', () => {
    expect(() => parseEvidence('loc-drop:100:-50')).toThrow(
      /toLines.*non-negative|non-negative.*toLines/i,
    );
  });

  it('rejects unknown atom kinds (regression guard)', () => {
    expect(() => parseEvidence('loc-droop:100:50')).toThrow(/Unknown evidence kind/);
  });
});

// ---------------------------------------------------------------------------
// validateAtom — loc-drop validation
// ---------------------------------------------------------------------------

describe('validateAtom — loc-drop (T1604)', () => {
  const projectRoot = '/does-not-matter';

  it('validates a loc-drop with significant reduction', async () => {
    const result = await validateAtom(
      { kind: 'loc-drop', fromLines: 1000, toLines: 600 },
      projectRoot,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.atom.kind).toBe('loc-drop');
      expect(result.atom.fromLines).toBe(1000);
      expect(result.atom.toLines).toBe(600);
      expect(result.atom.reductionPct).toBeCloseTo(40, 2);
    }
  });

  it('validates a loc-drop with exactly 10% reduction', async () => {
    const result = await validateAtom(
      { kind: 'loc-drop', fromLines: 100, toLines: 90 },
      projectRoot,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.atom.reductionPct).toBeCloseTo(10, 2);
    }
  });

  it('validates a loc-drop with zero reduction (toLines === fromLines)', async () => {
    const result = await validateAtom(
      { kind: 'loc-drop', fromLines: 100, toLines: 100 },
      projectRoot,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.atom.reductionPct).toBe(0);
    }
  });

  it('rejects when fromLines is zero', async () => {
    const result = await validateAtom({ kind: 'loc-drop', fromLines: 0, toLines: 0 }, projectRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.codeName).toBe('E_EVIDENCE_INVALID');
      expect(result.reason).toMatch(/fromLines cannot be zero/i);
    }
  });

  it('rejects when toLines exceeds fromLines (LOC increased)', async () => {
    const result = await validateAtom(
      { kind: 'loc-drop', fromLines: 500, toLines: 600 },
      projectRoot,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.codeName).toBe('E_EVIDENCE_INSUFFICIENT');
      expect(result.reason).toMatch(/greater than fromLines|LOC increased/i);
    }
  });

  it('computes reductionPct rounded to two decimal places', async () => {
    // 1/3 ≈ 33.33%
    const result = await validateAtom({ kind: 'loc-drop', fromLines: 3, toLines: 2 }, projectRoot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.atom.reductionPct).toBe(33.33);
    }
  });
});

// ---------------------------------------------------------------------------
// checkEngineMigrationLocDrop
// ---------------------------------------------------------------------------

describe('checkEngineMigrationLocDrop (T1604)', () => {
  it('returns null when a loc-drop atom meets the minimum threshold', () => {
    const atoms = [{ kind: 'loc-drop' as const, fromLines: 1000, toLines: 800, reductionPct: 20 }];
    const result = checkEngineMigrationLocDrop(atoms);
    expect(result).toBeNull();
  });

  it('returns null when exactly at the minimum threshold', () => {
    const atoms = [
      {
        kind: 'loc-drop' as const,
        fromLines: 100,
        toLines: 90,
        reductionPct: ENGINE_MIGRATION_MIN_REDUCTION_PCT,
      },
    ];
    const result = checkEngineMigrationLocDrop(atoms);
    expect(result).toBeNull();
  });

  it('returns an error string when the reduction is below threshold', () => {
    const atoms = [{ kind: 'loc-drop' as const, fromLines: 1000, toLines: 950, reductionPct: 5 }];
    const result = checkEngineMigrationLocDrop(atoms);
    expect(result).not.toBeNull();
    expect(result).toMatch(/5%.*below.*10%|below.*required/i);
  });

  it('returns an error string when no loc-drop atom is present', () => {
    const atoms = [
      { kind: 'note' as const, note: 'migrated engine' },
      {
        kind: 'commit' as const,
        sha: 'abc1234abc1234abc1234abc1234abc1234abc1234',
        shortSha: 'abc1234',
      },
    ];
    const result = checkEngineMigrationLocDrop(atoms);
    expect(result).not.toBeNull();
    expect(result).toMatch(/engine-migration.*loc-drop|loc-drop.*engine-migration/i);
  });

  it('accepts a custom minimum reduction percentage', () => {
    // Require 25% but only have 20%
    const atoms = [{ kind: 'loc-drop' as const, fromLines: 100, toLines: 80, reductionPct: 20 }];
    const result = checkEngineMigrationLocDrop(atoms, 25);
    expect(result).not.toBeNull();
    expect(result).toMatch(/20%.*below.*25%|below.*required/i);
  });

  it('accepts a custom minimum of 5% when met', () => {
    const atoms = [{ kind: 'loc-drop' as const, fromLines: 100, toLines: 94, reductionPct: 6 }];
    const result = checkEngineMigrationLocDrop(atoms, 5);
    expect(result).toBeNull();
  });

  it('uses ENGINE_MIGRATION_MIN_REDUCTION_PCT as default', () => {
    expect(ENGINE_MIGRATION_MIN_REDUCTION_PCT).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// hasEngineMigrationLabel
// ---------------------------------------------------------------------------

describe('hasEngineMigrationLabel (T1604)', () => {
  it('returns true when engine-migration label is present', () => {
    expect(hasEngineMigrationLabel(['foundation', 'engine-migration', 't-found-v2'])).toBe(true);
  });

  it('returns true when engine-migration is the only label', () => {
    expect(hasEngineMigrationLabel(['engine-migration'])).toBe(true);
  });

  it('returns false when engine-migration label is absent', () => {
    expect(hasEngineMigrationLabel(['foundation', 't-found-v2'])).toBe(false);
  });

  it('returns false for empty labels array', () => {
    expect(hasEngineMigrationLabel([])).toBe(false);
  });

  it('returns false for null labels', () => {
    expect(hasEngineMigrationLabel(null)).toBe(false);
  });

  it('returns false for undefined labels', () => {
    expect(hasEngineMigrationLabel(undefined)).toBe(false);
  });

  it('ENGINE_MIGRATION_LABEL is the expected string constant', () => {
    expect(ENGINE_MIGRATION_LABEL).toBe('engine-migration');
  });

  it('does not match partial label strings', () => {
    expect(hasEngineMigrationLabel(['engine', 'migration', 'engine-migrations'])).toBe(false);
  });
});
