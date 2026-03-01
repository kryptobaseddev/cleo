/**
 * Tests for log entry filtering and pagination.
 * @task T5187
 * @epic T5186
 */

import { describe, it, expect } from 'vitest';
import { matchesFilter, filterEntries, paginate, compareLevels } from '../log-filter.js';
import type { PinoLogEntry } from '../types.js';

function makeEntry(overrides: Partial<PinoLogEntry> = {}): PinoLogEntry {
  return {
    level: 'INFO',
    time: '2026-02-28T12:00:00.000Z',
    pid: 1000,
    hostname: 'testhost',
    msg: 'Test message',
    extra: {},
    ...overrides,
  };
}

describe('compareLevels', () => {
  it('returns 0 for equal levels', () => {
    expect(compareLevels('INFO', 'INFO')).toBe(0);
    expect(compareLevels('ERROR', 'ERROR')).toBe(0);
  });

  it('returns negative for lower < higher', () => {
    expect(compareLevels('DEBUG', 'INFO')).toBeLessThan(0);
    expect(compareLevels('INFO', 'WARN')).toBeLessThan(0);
    expect(compareLevels('TRACE', 'FATAL')).toBeLessThan(0);
  });

  it('returns positive for higher > lower', () => {
    expect(compareLevels('ERROR', 'WARN')).toBeGreaterThan(0);
    expect(compareLevels('FATAL', 'TRACE')).toBeGreaterThan(0);
  });
});

describe('matchesFilter', () => {
  it('returns true for empty filter', () => {
    expect(matchesFilter(makeEntry(), {})).toBe(true);
  });

  it('filters by exact level', () => {
    const entry = makeEntry({ level: 'WARN' });
    expect(matchesFilter(entry, { level: 'WARN' })).toBe(true);
    expect(matchesFilter(entry, { level: 'ERROR' })).toBe(false);
  });

  it('filters by minLevel', () => {
    expect(matchesFilter(makeEntry({ level: 'ERROR' }), { minLevel: 'WARN' })).toBe(true);
    expect(matchesFilter(makeEntry({ level: 'WARN' }), { minLevel: 'WARN' })).toBe(true);
    expect(matchesFilter(makeEntry({ level: 'INFO' }), { minLevel: 'WARN' })).toBe(false);
    expect(matchesFilter(makeEntry({ level: 'DEBUG' }), { minLevel: 'WARN' })).toBe(false);
  });

  it('filters by since (inclusive)', () => {
    const entry = makeEntry({ time: '2026-02-28T12:00:00.000Z' });
    expect(matchesFilter(entry, { since: '2026-02-28T12:00:00.000Z' })).toBe(true);
    expect(matchesFilter(entry, { since: '2026-02-28T11:00:00.000Z' })).toBe(true);
    expect(matchesFilter(entry, { since: '2026-02-28T13:00:00.000Z' })).toBe(false);
  });

  it('filters by until (inclusive)', () => {
    const entry = makeEntry({ time: '2026-02-28T12:00:00.000Z' });
    expect(matchesFilter(entry, { until: '2026-02-28T12:00:00.000Z' })).toBe(true);
    expect(matchesFilter(entry, { until: '2026-02-28T13:00:00.000Z' })).toBe(true);
    expect(matchesFilter(entry, { until: '2026-02-28T11:00:00.000Z' })).toBe(false);
  });

  it('filters by subsystem', () => {
    const entry = makeEntry({ subsystem: 'engine' });
    expect(matchesFilter(entry, { subsystem: 'engine' })).toBe(true);
    expect(matchesFilter(entry, { subsystem: 'mcp' })).toBe(false);
  });

  it('filters by code', () => {
    const entry = makeEntry({ code: 'E_NOT_FOUND' });
    expect(matchesFilter(entry, { code: 'E_NOT_FOUND' })).toBe(true);
    expect(matchesFilter(entry, { code: 'E_NOT_INITIALIZED' })).toBe(false);
  });

  it('filters by exitCode', () => {
    const entry = makeEntry({ exitCode: 4 });
    expect(matchesFilter(entry, { exitCode: 4 })).toBe(true);
    expect(matchesFilter(entry, { exitCode: 3 })).toBe(false);
  });

  it('filters by pid', () => {
    const entry = makeEntry({ pid: 9999 });
    expect(matchesFilter(entry, { pid: 9999 })).toBe(true);
    expect(matchesFilter(entry, { pid: 1234 })).toBe(false);
  });

  it('filters by msgContains (case-insensitive)', () => {
    const entry = makeEntry({ msg: 'Task T1234 not found' });
    expect(matchesFilter(entry, { msgContains: 'not found' })).toBe(true);
    expect(matchesFilter(entry, { msgContains: 'NOT FOUND' })).toBe(true);
    expect(matchesFilter(entry, { msgContains: 'T1234' })).toBe(true);
    expect(matchesFilter(entry, { msgContains: 'success' })).toBe(false);
  });

  it('applies AND logic for multiple criteria', () => {
    const entry = makeEntry({ level: 'ERROR', subsystem: 'engine', code: 'E_NOT_FOUND' });
    expect(matchesFilter(entry, { level: 'ERROR', subsystem: 'engine' })).toBe(true);
    expect(matchesFilter(entry, { level: 'ERROR', subsystem: 'mcp' })).toBe(false);
    expect(matchesFilter(entry, { level: 'WARN', subsystem: 'engine' })).toBe(false);
  });

  it('handles entry without optional fields when filtering by them', () => {
    const entry = makeEntry(); // no subsystem, code, exitCode
    expect(matchesFilter(entry, { subsystem: 'engine' })).toBe(false);
    expect(matchesFilter(entry, { code: 'E_NOT_FOUND' })).toBe(false);
    expect(matchesFilter(entry, { exitCode: 4 })).toBe(false);
  });
});

describe('filterEntries', () => {
  const entries = [
    makeEntry({ level: 'INFO', msg: 'Starting server', subsystem: 'mcp' }),
    makeEntry({ level: 'WARN', msg: 'Task not found', subsystem: 'engine', code: 'E_NOT_FOUND' }),
    makeEntry({ level: 'ERROR', msg: 'Database locked', subsystem: 'engine', exitCode: 3 }),
    makeEntry({ level: 'INFO', msg: 'Server stopped', subsystem: 'mcp' }),
  ];

  it('returns all entries for empty filter', () => {
    expect(filterEntries(entries, {})).toHaveLength(4);
  });

  it('filters by level', () => {
    expect(filterEntries(entries, { level: 'INFO' })).toHaveLength(2);
  });

  it('filters by minLevel', () => {
    expect(filterEntries(entries, { minLevel: 'WARN' })).toHaveLength(2);
  });

  it('filters by subsystem', () => {
    expect(filterEntries(entries, { subsystem: 'engine' })).toHaveLength(2);
  });

  it('combines multiple filters', () => {
    expect(filterEntries(entries, { subsystem: 'engine', minLevel: 'ERROR' })).toHaveLength(1);
  });
});

describe('paginate', () => {
  const entries = Array.from({ length: 10 }, (_, i) =>
    makeEntry({ msg: `Entry ${i}` }),
  );

  it('returns all entries when no limit or offset', () => {
    expect(paginate(entries)).toHaveLength(10);
  });

  it('applies limit', () => {
    expect(paginate(entries, 3)).toHaveLength(3);
    expect(paginate(entries, 3)[0]!.msg).toBe('Entry 0');
  });

  it('applies offset', () => {
    const result = paginate(entries, undefined, 5);
    expect(result).toHaveLength(5);
    expect(result[0]!.msg).toBe('Entry 5');
  });

  it('applies both limit and offset', () => {
    const result = paginate(entries, 2, 3);
    expect(result).toHaveLength(2);
    expect(result[0]!.msg).toBe('Entry 3');
    expect(result[1]!.msg).toBe('Entry 4');
  });

  it('handles offset beyond array length', () => {
    expect(paginate(entries, 5, 100)).toHaveLength(0);
  });

  it('handles limit larger than available entries', () => {
    expect(paginate(entries, 100)).toHaveLength(10);
  });
});
