import { describe, expect, it } from 'vitest';
import { type SparkName, sparkDurationMs, sparks } from './spark.js';

const ALL_SPARKS: SparkName[] = ['awaken', 'sweep', 'cascade', 'weave'];

describe('sparks registry', () => {
  it('exports all four canon sparks', () => {
    expect(Object.keys(sparks).sort()).toEqual([...ALL_SPARKS].sort());
  });

  for (const name of ALL_SPARKS) {
    describe(name, () => {
      it('has at least 4 frames (visible motion)', () => {
        expect(sparks[name].frames.length).toBeGreaterThanOrEqual(4);
      });

      it('has positive interval', () => {
        expect(sparks[name].interval).toBeGreaterThan(0);
      });

      it('has consistent frame widths', () => {
        const widths = sparks[name].frames.map((f) => [...f].length);
        expect(new Set(widths).size).toBe(1);
      });

      it('starts and ends at the empty / blank cell (decays back)', () => {
        const frames = sparks[name].frames;
        const first = frames[0];
        const last = frames[frames.length - 1];
        expect([...first].every((c) => c === '⠀' || c === ' ')).toBe(true);
        expect([...last].every((c) => c === '⠀' || c === ' ')).toBe(true);
      });
    });
  }
});

describe('sparkDurationMs', () => {
  it('returns frames.length * interval', () => {
    for (const name of ALL_SPARKS) {
      const s = sparks[name];
      expect(sparkDurationMs(name)).toBe(s.frames.length * s.interval);
    }
  });
});
