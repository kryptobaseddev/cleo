/**
 * Tests for pino JSONL log parser.
 * @task T5187
 * @epic T5186
 */

import { describe, it, expect } from 'vitest';
import { parseLogLine, parseLogLines, isValidLevel } from '../log-parser.js';

describe('isValidLevel', () => {
  it('accepts all valid pino levels', () => {
    for (const level of ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']) {
      expect(isValidLevel(level)).toBe(true);
    }
  });

  it('rejects lowercase levels', () => {
    expect(isValidLevel('info')).toBe(false);
    expect(isValidLevel('warn')).toBe(false);
  });

  it('rejects invalid strings', () => {
    expect(isValidLevel('')).toBe(false);
    expect(isValidLevel('NOTICE')).toBe(false);
    expect(isValidLevel('VERBOSE')).toBe(false);
  });
});

describe('parseLogLine', () => {
  const validLine = JSON.stringify({
    level: 'INFO',
    time: '2026-02-28T10:00:00.000Z',
    pid: 12345,
    hostname: 'testhost',
    msg: 'Server started',
  });

  it('parses a valid log line with all core fields', () => {
    const entry = parseLogLine(validLine);
    expect(entry).not.toBeNull();
    expect(entry!.level).toBe('INFO');
    expect(entry!.time).toBe('2026-02-28T10:00:00.000Z');
    expect(entry!.pid).toBe(12345);
    expect(entry!.hostname).toBe('testhost');
    expect(entry!.msg).toBe('Server started');
    expect(entry!.extra).toEqual({});
  });

  it('extracts optional typed fields (subsystem, code, exitCode)', () => {
    const line = JSON.stringify({
      level: 'ERROR',
      time: '2026-02-28T10:00:00.000Z',
      pid: 100,
      hostname: 'host',
      msg: 'Task not found',
      subsystem: 'engine',
      code: 'E_NOT_FOUND',
      exitCode: 4,
    });
    const entry = parseLogLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.subsystem).toBe('engine');
    expect(entry!.code).toBe('E_NOT_FOUND');
    expect(entry!.exitCode).toBe(4);
  });

  it('captures unknown fields in extra', () => {
    const line = JSON.stringify({
      level: 'INFO',
      time: '2026-02-28T10:00:00.000Z',
      pid: 100,
      hostname: 'host',
      msg: 'Starting',
      metrics: false,
      signal: 'SIGTERM',
      customField: { nested: true },
    });
    const entry = parseLogLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.extra).toEqual({
      metrics: false,
      signal: 'SIGTERM',
      customField: { nested: true },
    });
  });

  it('returns null for empty string', () => {
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('   ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseLogLine('not json')).toBeNull();
    expect(parseLogLine('{broken')).toBeNull();
  });

  it('returns null for valid JSON missing required fields', () => {
    expect(parseLogLine(JSON.stringify({ level: 'INFO' }))).toBeNull();
    expect(parseLogLine(JSON.stringify({ msg: 'hello' }))).toBeNull();
  });

  it('returns null for invalid level', () => {
    const line = JSON.stringify({
      level: 'info', // lowercase
      time: '2026-02-28T10:00:00.000Z',
      pid: 100,
      hostname: 'host',
      msg: 'test',
    });
    expect(parseLogLine(line)).toBeNull();
  });

  it('returns null for arrays', () => {
    expect(parseLogLine('[1,2,3]')).toBeNull();
  });

  it('returns null for non-string level', () => {
    const line = JSON.stringify({
      level: 30, // pino uses numbers internally, but CLEO formats as uppercase string
      time: '2026-02-28T10:00:00.000Z',
      pid: 100,
      hostname: 'host',
      msg: 'test',
    });
    expect(parseLogLine(line)).toBeNull();
  });

  it('handles line with leading/trailing whitespace', () => {
    const entry = parseLogLine(`  ${validLine}  `);
    expect(entry).not.toBeNull();
    expect(entry!.level).toBe('INFO');
  });
});

describe('parseLogLines', () => {
  it('parses multiple valid lines', () => {
    const lines = [
      JSON.stringify({ level: 'INFO', time: '2026-01-01T00:00:00Z', pid: 1, hostname: 'h', msg: 'a' }),
      JSON.stringify({ level: 'WARN', time: '2026-01-01T00:01:00Z', pid: 2, hostname: 'h', msg: 'b' }),
    ];
    const entries = parseLogLines(lines);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.level).toBe('INFO');
    expect(entries[1]!.level).toBe('WARN');
  });

  it('skips malformed lines', () => {
    const lines = [
      JSON.stringify({ level: 'INFO', time: '2026-01-01T00:00:00Z', pid: 1, hostname: 'h', msg: 'good' }),
      'not json',
      '',
      JSON.stringify({ level: 'ERROR', time: '2026-01-01T00:02:00Z', pid: 3, hostname: 'h', msg: 'also good' }),
    ];
    const entries = parseLogLines(lines);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.msg).toBe('good');
    expect(entries[1]!.msg).toBe('also good');
  });

  it('returns empty array for empty input', () => {
    expect(parseLogLines([])).toEqual([]);
  });
});
