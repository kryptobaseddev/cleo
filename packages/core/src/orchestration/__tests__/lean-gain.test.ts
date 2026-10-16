/**
 * T13669 — `cleo lean gain`: measured scoreboard with the honesty boundary.
 */
import { describe, expect, it } from 'vitest';
import { LEAN_GAIN, renderLeanGain } from '../lean-gain.js';

describe('lean gain scoreboard (T13669)', () => {
  it('reports measured shares from the cited research doc', () => {
    expect(LEAN_GAIN.source).toBe('t13424-ct-lean-vs-ponytail-benchmark');
    const loc = LEAN_GAIN.metrics.find((m) => m.name === 'Source lines of code');
    expect(loc?.ctLeanShare).toBeCloseTo(660 / 1896, 5);
    for (const m of LEAN_GAIN.metrics) {
      expect(m.ctLeanShare).toBeGreaterThan(0);
      expect(m.ctLeanShare).toBeLessThanOrEqual(1);
    }
  });

  it('renders bars, the Ponytail comparison and the source', () => {
    const card = renderLeanGain();
    expect(card.split('\n')[0]).toBe(
      'ct-lean 1.0.0 vs baseline, T13424 benchmark, Opus 5.5, 8 tasks × 3 runs (t13424-ct-lean-vs-ponytail-benchmark)',
    );
    expect(card).toContain('no skill');
    expect(card).toContain('████████████████████ 100%');
    expect(card).toContain('Source lines of code');
    expect(card).toMatch(/35%\s+▼ 65%\s+\(Ponytail 32%\)/);
    expect(card).toContain('cleo docs fetch t13424-ct-lean-vs-ponytail-benchmark');
  });

  it('never claims a per-repo saving and points at the counted ledger', () => {
    const card = renderLeanGain();
    expect(card).toContain('not this repo');
    expect(card).toContain('cleo lean debt');
    expect(card).not.toMatch(/you saved|saved here|in this repo you/i);
  });
});
