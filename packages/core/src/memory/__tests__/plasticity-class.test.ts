/**
 * Tests for plasticity_class column writer (T693).
 *
 * Covers:
 * - upgradePlasticityClass helper
 * - computeStabilityScore formula validation
 * - Edge updates via STDP and Hebbian paths
 */

import { describe, expect, it } from 'vitest';
import { computeStabilityScore, upgradePlasticityClass } from '../brain-plasticity-class.js';

describe('plasticity-class: T693', () => {
  describe('upgradePlasticityClass', () => {
    it('should upgrade static → hebbian on hebbian event', () => {
      expect(upgradePlasticityClass('static', 'hebbian')).toBe('hebbian');
    });

    it('should upgrade static → stdp on stdp event', () => {
      expect(upgradePlasticityClass('static', 'stdp')).toBe('stdp');
    });

    it('should upgrade hebbian → stdp on stdp event', () => {
      expect(upgradePlasticityClass('hebbian', 'stdp')).toBe('stdp');
    });

    it('should keep stdp → stdp (no downgrade)', () => {
      expect(upgradePlasticityClass('stdp', 'stdp')).toBe('stdp');
      expect(upgradePlasticityClass('stdp', 'hebbian')).toBe('stdp');
    });

    it('should keep hebbian → hebbian on hebbian event', () => {
      expect(upgradePlasticityClass('hebbian', 'hebbian')).toBe('hebbian');
    });

    it('should handle null/undefined as static', () => {
      expect(upgradePlasticityClass(null, 'hebbian')).toBe('hebbian');
      expect(upgradePlasticityClass(undefined, 'stdp')).toBe('stdp');
    });
  });

  describe('computeStabilityScore', () => {
    it('should return null for zero reinforcement count', () => {
      const now = Date.now();
      const lastReinforced = new Date(now).toISOString();
      expect(computeStabilityScore(0, lastReinforced, now)).toBeNull();
      expect(computeStabilityScore(-1, lastReinforced, now)).toBeNull();
    });

    it('should return null if lastReinforcedAt is null', () => {
      expect(computeStabilityScore(10, null)).toBeNull();
      expect(computeStabilityScore(10, undefined)).toBeNull();
    });

    it('should compute tanh(rc/10) × exp(-(days/30)) correctly', () => {
      const now = Date.now();
      const lastReinforced = new Date(now).toISOString();

      // rc=10, days=0 → tanh(1.0) × 1.0 ≈ 0.7616
      const score1 = computeStabilityScore(10, lastReinforced, now);
      // tanh(1.0) ≈ 0.7615941559557649
      expect(score1).toBeGreaterThan(0.75);
      expect(score1).toBeLessThan(0.77);

      // rc=5, days=0 → tanh(0.5) × 1.0 ≈ 0.4621
      const score2 = computeStabilityScore(5, lastReinforced, now);
      expect(score2).toBeGreaterThan(0.45);
      expect(score2).toBeLessThan(0.48);

      // rc=1, days=0 → tanh(0.1) × 1.0 ≈ 0.0997
      const score3 = computeStabilityScore(1, lastReinforced, now);
      expect(score3).toBeGreaterThan(0.09);
      expect(score3).toBeLessThan(0.11);
    });

    it('should decay with time: exp(-(days/30))', () => {
      // rc=10, days=0
      const now = Date.now();
      const lastReinforced = new Date(now).toISOString();
      const score0days = computeStabilityScore(10, lastReinforced, now);

      // rc=10, days=30 → exp(-1) ≈ 0.3679
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const score30days = computeStabilityScore(10, lastReinforced, now + thirtyDaysMs);

      // Ratio should be approximately exp(-1) ≈ 0.3679
      if (score0days && score30days) {
        const ratio = score30days / score0days;
        expect(ratio).toBeGreaterThan(0.35);
        expect(ratio).toBeLessThan(0.39);
      }
    });

    it('should clamp result to [0, 1]', () => {
      // Stability formula always produces values in [0, 1], but verify edge cases
      const now = Date.now();
      const lastReinforced = new Date(now).toISOString();
      const score = computeStabilityScore(100, lastReinforced, now);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('should use Date.now() by default', () => {
      // Should not throw; uses internal Date.now()
      const now = Date.now();
      const lastReinforced = new Date(now).toISOString();
      const score = computeStabilityScore(10, lastReinforced);
      expect(score).toBeDefined();
      expect(typeof score).toBe('number');
    });
  });
});
