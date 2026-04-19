/**
 * Unit tests for the shared Task Explorer format helpers.
 *
 * These pure functions are the foundation of every extracted component —
 * consolidating the 4-way duplication in `/tasks/*` per T950.
 *
 * @task T950
 * @epic T949
 */

import { describe, expect, it } from 'vitest';
import {
  formatTime,
  gatesFromJson,
  priorityClass,
  progressPct,
  statusClass,
  statusIcon,
} from '../format.js';

describe('statusIcon', () => {
  it('returns the done glyph for "done"', () => {
    expect(statusIcon('done')).toBe('✓');
  });

  it('returns the active glyph for "active"', () => {
    expect(statusIcon('active')).toBe('●');
  });

  it('returns the blocked glyph for "blocked"', () => {
    expect(statusIcon('blocked')).toBe('✗');
  });

  it('returns the cancelled glyph for "cancelled"', () => {
    expect(statusIcon('cancelled')).toBe('⊘');
  });

  it('returns the pending glyph for "pending"', () => {
    expect(statusIcon('pending')).toBe('○');
  });

  it('returns the archived glyph for "archived"', () => {
    expect(statusIcon('archived')).toBe('◌');
  });

  it('returns the proposed glyph for "proposed"', () => {
    expect(statusIcon('proposed')).toBe('◆');
  });
});

describe('statusClass', () => {
  it('returns "status-<name>" for every registry value', () => {
    expect(statusClass('done')).toBe('status-done');
    expect(statusClass('active')).toBe('status-active');
    expect(statusClass('blocked')).toBe('status-blocked');
    expect(statusClass('pending')).toBe('status-pending');
    expect(statusClass('cancelled')).toBe('status-cancelled');
    expect(statusClass('archived')).toBe('status-archived');
    expect(statusClass('proposed')).toBe('status-proposed');
  });
});

describe('priorityClass', () => {
  it('returns "priority-<name>" for every priority value', () => {
    expect(priorityClass('critical')).toBe('priority-critical');
    expect(priorityClass('high')).toBe('priority-high');
    expect(priorityClass('medium')).toBe('priority-medium');
    expect(priorityClass('low')).toBe('priority-low');
  });
});

describe('gatesFromJson', () => {
  it('returns all-false on null', () => {
    expect(gatesFromJson(null)).toEqual({
      implemented: false,
      testsPassed: false,
      qaPassed: false,
    });
  });

  it('returns all-false on undefined', () => {
    expect(gatesFromJson(undefined)).toEqual({
      implemented: false,
      testsPassed: false,
      qaPassed: false,
    });
  });

  it('returns all-false on empty string', () => {
    expect(gatesFromJson('')).toEqual({
      implemented: false,
      testsPassed: false,
      qaPassed: false,
    });
  });

  it('returns all-false on malformed JSON', () => {
    expect(gatesFromJson('{not-json')).toEqual({
      implemented: false,
      testsPassed: false,
      qaPassed: false,
    });
  });

  it('extracts gates from a valid verification_json', () => {
    const json = JSON.stringify({
      gates: { implemented: true, testsPassed: false, qaPassed: true },
    });
    expect(gatesFromJson(json)).toEqual({
      implemented: true,
      testsPassed: false,
      qaPassed: true,
    });
  });

  it('treats null/undefined gate values as false (non-strict)', () => {
    const json = JSON.stringify({ gates: { implemented: null, testsPassed: undefined } });
    expect(gatesFromJson(json)).toEqual({
      implemented: false,
      testsPassed: false,
      qaPassed: false,
    });
  });

  it('treats missing gates object as all-false', () => {
    const json = JSON.stringify({ passed: false });
    expect(gatesFromJson(json)).toEqual({
      implemented: false,
      testsPassed: false,
      qaPassed: false,
    });
  });
});

describe('formatTime', () => {
  // Fix the "now" reference so the tests are deterministic.
  const NOW = new Date('2026-04-19T12:00:00Z').getTime();

  it('returns "just now" for sub-minute deltas', () => {
    const iso = new Date(NOW - 30_000).toISOString();
    expect(formatTime(iso, NOW)).toBe('just now');
  });

  it('returns "Xm ago" for minute-scale deltas', () => {
    const iso = new Date(NOW - 5 * 60_000).toISOString();
    expect(formatTime(iso, NOW)).toBe('5m ago');
  });

  it('returns "Xh ago" for hour-scale deltas', () => {
    const iso = new Date(NOW - 3 * 60 * 60_000).toISOString();
    expect(formatTime(iso, NOW)).toBe('3h ago');
  });

  it('returns "Xd ago" for day-scale deltas', () => {
    const iso = new Date(NOW - 2 * 24 * 60 * 60_000).toISOString();
    expect(formatTime(iso, NOW)).toBe('2d ago');
  });

  it('falls back to the raw input on parse failure', () => {
    expect(formatTime('not-a-date', NOW)).toBe('not-a-date');
  });

  it('handles the 59-minute / 1-hour boundary', () => {
    const isoJustUnder = new Date(NOW - 59 * 60_000).toISOString();
    expect(formatTime(isoJustUnder, NOW)).toBe('59m ago');
    const isoJustOver = new Date(NOW - 60 * 60_000).toISOString();
    expect(formatTime(isoJustOver, NOW)).toBe('1h ago');
  });
});

describe('progressPct', () => {
  it('returns 0 when total is zero', () => {
    expect(progressPct(0, 0)).toBe(0);
  });

  it('returns 0 when total is negative (defensive)', () => {
    expect(progressPct(3, -2)).toBe(0);
  });

  it('rounds to the nearest integer percent', () => {
    expect(progressPct(1, 3)).toBe(33);
    expect(progressPct(2, 3)).toBe(67);
  });

  it('returns 100 when fully done', () => {
    expect(progressPct(10, 10)).toBe(100);
  });

  it('returns 0 when nothing done', () => {
    expect(progressPct(0, 10)).toBe(0);
  });
});
