/**
 * Tests for priority normalization - T4572
 * Verifies both string and numeric priorities work across all paths.
 * @task T4572
 */

import { describe, it, expect } from 'vitest';
import {
  normalizePriority,
  validatePriority,
  VALID_PRIORITIES,
} from '../add.js';

describe('normalizePriority', () => {
  describe('canonical string priorities', () => {
    it('should accept "critical" and return "critical"', () => {
      expect(normalizePriority('critical')).toBe('critical');
    });

    it('should accept "high" and return "high"', () => {
      expect(normalizePriority('high')).toBe('high');
    });

    it('should accept "medium" and return "medium"', () => {
      expect(normalizePriority('medium')).toBe('medium');
    });

    it('should accept "low" and return "low"', () => {
      expect(normalizePriority('low')).toBe('low');
    });

    it('should be case-insensitive for string priorities', () => {
      expect(normalizePriority('Critical')).toBe('critical');
      expect(normalizePriority('HIGH')).toBe('high');
      expect(normalizePriority('MEDIUM')).toBe('medium');
      expect(normalizePriority('Low')).toBe('low');
    });

    it('should trim whitespace from string priorities', () => {
      expect(normalizePriority('  high  ')).toBe('high');
      expect(normalizePriority(' medium')).toBe('medium');
    });
  });

  describe('numeric priorities (number type)', () => {
    it('should map 1 to critical', () => {
      expect(normalizePriority(1)).toBe('critical');
    });

    it('should map 2 to critical', () => {
      expect(normalizePriority(2)).toBe('critical');
    });

    it('should map 3 to high', () => {
      expect(normalizePriority(3)).toBe('high');
    });

    it('should map 4 to high', () => {
      expect(normalizePriority(4)).toBe('high');
    });

    it('should map 5 to medium', () => {
      expect(normalizePriority(5)).toBe('medium');
    });

    it('should map 6 to medium', () => {
      expect(normalizePriority(6)).toBe('medium');
    });

    it('should map 7 to low', () => {
      expect(normalizePriority(7)).toBe('low');
    });

    it('should map 8 to low', () => {
      expect(normalizePriority(8)).toBe('low');
    });

    it('should map 9 to low', () => {
      expect(normalizePriority(9)).toBe('low');
    });

    it('should throw for numeric values outside 1-9', () => {
      expect(() => normalizePriority(0)).toThrow('Invalid numeric priority');
      expect(() => normalizePriority(10)).toThrow('Invalid numeric priority');
      expect(() => normalizePriority(-1)).toThrow('Invalid numeric priority');
    });
  });

  describe('numeric string priorities', () => {
    it('should accept "1" and normalize to critical', () => {
      expect(normalizePriority('1')).toBe('critical');
    });

    it('should accept "5" and normalize to medium', () => {
      expect(normalizePriority('5')).toBe('medium');
    });

    it('should accept "9" and normalize to low', () => {
      expect(normalizePriority('9')).toBe('low');
    });

    it('should reject numeric string outside range', () => {
      expect(() => normalizePriority('0')).toThrow();
      expect(() => normalizePriority('10')).toThrow();
      expect(() => normalizePriority('15')).toThrow();
    });
  });

  describe('invalid priorities', () => {
    it('should throw for invalid string values', () => {
      expect(() => normalizePriority('urgent')).toThrow('Invalid priority');
      expect(() => normalizePriority('none')).toThrow('Invalid priority');
      expect(() => normalizePriority('p1')).toThrow('Invalid priority');
    });

    it('should throw for empty string', () => {
      expect(() => normalizePriority('')).toThrow('Invalid priority');
    });
  });
});

describe('validatePriority', () => {
  it('should accept canonical string values', () => {
    expect(() => validatePriority('critical')).not.toThrow();
    expect(() => validatePriority('high')).not.toThrow();
    expect(() => validatePriority('medium')).not.toThrow();
    expect(() => validatePriority('low')).not.toThrow();
  });

  it('should accept numeric string values', () => {
    expect(() => validatePriority('1')).not.toThrow();
    expect(() => validatePriority('5')).not.toThrow();
    expect(() => validatePriority('9')).not.toThrow();
  });

  it('should reject invalid values', () => {
    expect(() => validatePriority('urgent')).toThrow();
    expect(() => validatePriority('0')).toThrow();
    expect(() => validatePriority('10')).toThrow();
  });
});

describe('VALID_PRIORITIES', () => {
  it('should contain all canonical priority values', () => {
    expect(VALID_PRIORITIES).toEqual(['critical', 'high', 'medium', 'low']);
  });
});
