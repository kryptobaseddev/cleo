import { describe, expect, it } from 'vitest';
import { progressBars, renderProgressBar } from './progress.js';

describe('renderProgressBar', () => {
  describe('boundary conditions', () => {
    it('returns empty string for zero width', () => {
      expect(renderProgressBar('tapestry', 0.5, 0)).toBe('');
      expect(renderProgressBar('cascade', 0.5, 0)).toBe('');
      expect(renderProgressBar('refinery', 0.5, 0)).toBe('');
    });

    it('returns empty string for negative width', () => {
      expect(renderProgressBar('tapestry', 0.5, -3)).toBe('');
    });

    it('clamps ratio < 0 to empty bar', () => {
      const out = renderProgressBar('tapestry', -0.5, 10);
      expect(out).toHaveLength(10);
      expect([...out].every((c) => c === '░')).toBe(true);
    });

    it('clamps ratio > 1 to full bar', () => {
      const out = renderProgressBar('tapestry', 1.5, 10);
      expect(out).toHaveLength(10);
      expect([...out].every((c) => c === '█')).toBe(true);
    });

    it('treats NaN ratio as zero', () => {
      const out = renderProgressBar('cascade', Number.NaN, 8);
      expect([...out].every((c) => c === ' ')).toBe(true);
    });
  });

  describe('width invariant — every style produces fixed-width output', () => {
    for (const style of ['tapestry', 'cascade', 'refinery'] as const) {
      it(`${style} renders exactly W characters at every ratio`, () => {
        for (let i = 0; i <= 10; i++) {
          const ratio = i / 10;
          const out = renderProgressBar(style, ratio, 12);
          expect([...out]).toHaveLength(12);
        }
      });
    }
  });

  describe('tapestry', () => {
    it('renders empty bar at ratio 0', () => {
      expect(renderProgressBar('tapestry', 0, 6)).toBe('░░░░░░');
    });

    it('renders full bar at ratio 1', () => {
      expect(renderProgressBar('tapestry', 1, 6)).toBe('██████');
    });

    it('uses fractional cell at mid-fill', () => {
      const out = renderProgressBar('tapestry', 0.5, 6);
      expect(out).toContain('█');
      expect(out).toContain('░');
    });
  });

  describe('cascade', () => {
    it('renders empty bar at ratio 0', () => {
      expect(renderProgressBar('cascade', 0, 4)).toBe('    ');
    });

    it('renders full bar at ratio 1', () => {
      expect(renderProgressBar('cascade', 1, 4)).toBe('████');
    });

    it('shows gradient edge at fractional fill', () => {
      const out = renderProgressBar('cascade', 0.5, 8);
      // 50% of 8 = 4 full cells, no fractional edge
      expect(out.startsWith('████')).toBe(true);
    });
  });

  describe('refinery', () => {
    it('renders empty bar at ratio 0', () => {
      expect(renderProgressBar('refinery', 0, 4)).toBe('⠀⠀⠀⠀');
    });

    it('renders full bar at ratio 1', () => {
      expect(renderProgressBar('refinery', 1, 4)).toBe('⣿⣿⣿⣿');
    });
  });

  describe('progressBars registry', () => {
    it('exports all three styles', () => {
      expect(Object.keys(progressBars).sort()).toEqual(['cascade', 'refinery', 'tapestry']);
    });

    it('every entry has a render function', () => {
      for (const style of Object.values(progressBars)) {
        expect(typeof style.render).toBe('function');
      }
    });
  });
});
