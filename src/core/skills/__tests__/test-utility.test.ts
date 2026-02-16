/**
 * Tests for test utility functions (test-utility.ts).
 * @task T4552
 * @epic T4545
 */

import { describe, it, expect } from 'vitest';
import {
  formatIsoDate,
  getCurrentTimestamp,
  isValidIsoDate,
  formatDateYMD,
} from '../test-utility.js';

describe('formatIsoDate', () => {
  it('should format a valid date string', () => {
    expect(formatIsoDate('2026-02-03')).toBe('2026-02-03T00:00:00Z');
  });

  it('should throw on empty input', () => {
    expect(() => formatIsoDate('')).toThrow('Date required');
  });

  it('should throw on invalid format', () => {
    expect(() => formatIsoDate('2026/02/03')).toThrow('Invalid date format');
    expect(() => formatIsoDate('02-03-2026')).toThrow('Invalid date format');
    expect(() => formatIsoDate('not-a-date')).toThrow('Invalid date format');
  });

  it('should handle edge case dates', () => {
    expect(formatIsoDate('2000-01-01')).toBe('2000-01-01T00:00:00Z');
    expect(formatIsoDate('9999-12-31')).toBe('9999-12-31T00:00:00Z');
  });
});

describe('getCurrentTimestamp', () => {
  it('should return a valid ISO timestamp without milliseconds', () => {
    const ts = getCurrentTimestamp();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('should return current time (not in the past)', () => {
    const before = Date.now();
    const ts = getCurrentTimestamp();
    const tsDate = new Date(ts).getTime();
    // Allow 1 second tolerance
    expect(tsDate).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe('isValidIsoDate', () => {
  it('should return true for valid ISO dates', () => {
    expect(isValidIsoDate('2026-02-03')).toBe(true);
    expect(isValidIsoDate('2026-02-03T00:00:00Z')).toBe(true);
    expect(isValidIsoDate('2026-02-03T14:30:00.000Z')).toBe(true);
  });

  it('should return false for invalid dates', () => {
    expect(isValidIsoDate('not-a-date')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
  });
});

describe('formatDateYMD', () => {
  it('should format a Date object to YYYY-MM-DD', () => {
    const date = new Date('2026-02-03T14:30:00Z');
    expect(formatDateYMD(date)).toBe('2026-02-03');
  });

  it('should handle different dates', () => {
    expect(formatDateYMD(new Date('2000-01-01T00:00:00Z'))).toBe('2000-01-01');
    expect(formatDateYMD(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31');
  });
});
