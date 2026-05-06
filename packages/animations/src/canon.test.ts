import { describe, expect, it } from 'vitest';
import {
  CANON_TO_GENERIC,
  type CanonSpinnerName,
  canonSpinners,
  resolveSpinner,
  spinners,
} from './braille.js';

const ALL_CANON: CanonSpinnerName[] = [
  'looming',
  'weaving',
  'heartbeat',
  'awakening',
  'sweeping',
  'watching',
  'cascade',
  'tapestry',
  'refinery',
];

describe('canon spinner aliases', () => {
  it('exports all 9 canon names', () => {
    expect(Object.keys(canonSpinners).sort()).toEqual([...ALL_CANON].sort());
    expect(Object.keys(CANON_TO_GENERIC).sort()).toEqual([...ALL_CANON].sort());
  });

  it('maps each canon name to a registered generic spinner', () => {
    for (const canon of ALL_CANON) {
      const generic = CANON_TO_GENERIC[canon];
      expect(spinners[generic]).toBeDefined();
    }
  });

  it('canon entry references the same Spinner object as the generic entry (alias, not copy)', () => {
    for (const canon of ALL_CANON) {
      const generic = CANON_TO_GENERIC[canon];
      expect(canonSpinners[canon]).toBe(spinners[generic]);
    }
  });

  it('locked mappings (CLEO canon contract — must not silently change)', () => {
    expect(CANON_TO_GENERIC).toEqual({
      looming: 'helix',
      weaving: 'braillewave',
      heartbeat: 'breathe',
      awakening: 'pulse',
      sweeping: 'scan',
      watching: 'orbit',
      cascade: 'cascade',
      tapestry: 'waverows',
      refinery: 'columns',
    });
  });
});

describe('resolveSpinner', () => {
  it('resolves generic names', () => {
    expect(resolveSpinner('helix')).toBe(spinners.helix);
    expect(resolveSpinner('braille')).toBe(spinners.braille);
  });

  it('resolves canon names', () => {
    expect(resolveSpinner('looming')).toBe(spinners.helix);
    expect(resolveSpinner('weaving')).toBe(spinners.braillewave);
  });

  it('returns undefined for unknown names', () => {
    expect(resolveSpinner('not-a-spinner')).toBeUndefined();
    expect(resolveSpinner('')).toBeUndefined();
  });
});
