/**
 * Integration tests for the observability module public API.
 * @task T5187
 * @epic T5186
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { queryLogs, streamLogs, getLogSummary } from '../index.js';

function makeLine(level: string, msg: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    level,
    time: `2026-02-28T${String(12 + Math.random() * 10).slice(0, 8)}Z`,
    pid: 1000,
    hostname: 'testhost',
    msg,
    ...extra,
  });
}

describe('queryLogs', () => {
  let tmpDir: string;
  let logsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cleo-query-'));
    logsDir = join(tmpDir, '.cleo', 'logs');
    await mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('queries log files and returns results', async () => {
    const lines = [
      JSON.stringify({ level: 'INFO', time: '2026-02-28T10:00:00Z', pid: 1, hostname: 'h', msg: 'Start', subsystem: 'mcp' }),
      JSON.stringify({ level: 'WARN', time: '2026-02-28T10:01:00Z', pid: 2, hostname: 'h', msg: 'Warning', subsystem: 'engine' }),
      JSON.stringify({ level: 'ERROR', time: '2026-02-28T10:02:00Z', pid: 3, hostname: 'h', msg: 'Error', subsystem: 'engine', code: 'E_NOT_FOUND' }),
    ];
    await writeFile(join(logsDir, 'cleo.2026-02-28.1.log'), lines.join('\n'));

    const result = queryLogs(undefined, { scope: 'project' }, tmpDir);
    expect(result.entries).toHaveLength(3);
    expect(result.totalScanned).toBe(3);
    expect(result.totalMatched).toBe(3);
    expect(result.files).toHaveLength(1);
  });

  it('applies filters', async () => {
    const lines = [
      JSON.stringify({ level: 'INFO', time: '2026-02-28T10:00:00Z', pid: 1, hostname: 'h', msg: 'Start' }),
      JSON.stringify({ level: 'WARN', time: '2026-02-28T10:01:00Z', pid: 2, hostname: 'h', msg: 'Warning' }),
      JSON.stringify({ level: 'ERROR', time: '2026-02-28T10:02:00Z', pid: 3, hostname: 'h', msg: 'Error' }),
    ];
    await writeFile(join(logsDir, 'cleo.2026-02-28.1.log'), lines.join('\n'));

    const result = queryLogs({ minLevel: 'WARN' }, { scope: 'project' }, tmpDir);
    expect(result.entries).toHaveLength(2);
    expect(result.totalMatched).toBe(2);
    expect(result.totalScanned).toBe(3);
  });

  it('applies pagination', async () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ level: 'INFO', time: `2026-02-28T10:0${i}:00Z`, pid: i, hostname: 'h', msg: `Entry ${i}` }),
    );
    await writeFile(join(logsDir, 'cleo.2026-02-28.1.log'), lines.join('\n'));

    const result = queryLogs({ limit: 3, offset: 2 }, { scope: 'project' }, tmpDir);
    expect(result.entries).toHaveLength(3);
    expect(result.totalMatched).toBe(10);
    expect(result.entries[0]!.msg).toBe('Entry 2');
  });

  it('returns empty result for empty directory', () => {
    const result = queryLogs(undefined, { scope: 'project' }, join(tmpDir, 'nonexistent'));
    expect(result.entries).toEqual([]);
    expect(result.totalScanned).toBe(0);
    expect(result.totalMatched).toBe(0);
  });

  it('reads across multiple log files', async () => {
    const lines1 = [
      JSON.stringify({ level: 'INFO', time: '2026-02-27T10:00:00Z', pid: 1, hostname: 'h', msg: 'Day1' }),
    ];
    const lines2 = [
      JSON.stringify({ level: 'WARN', time: '2026-02-28T10:00:00Z', pid: 2, hostname: 'h', msg: 'Day2' }),
    ];
    await writeFile(join(logsDir, 'cleo.2026-02-27.1.log'), lines1.join('\n'));
    await writeFile(join(logsDir, 'cleo.2026-02-28.1.log'), lines2.join('\n'));

    const result = queryLogs(undefined, { scope: 'project' }, tmpDir);
    expect(result.entries).toHaveLength(2);
    expect(result.files).toHaveLength(2);
  });
});

describe('streamLogs', () => {
  let tmpDir: string;
  let logsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cleo-stream-'));
    logsDir = join(tmpDir, '.cleo', 'logs');
    await mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('streams all entries', async () => {
    const lines = [
      JSON.stringify({ level: 'INFO', time: '2026-02-28T10:00:00Z', pid: 1, hostname: 'h', msg: 'a' }),
      JSON.stringify({ level: 'WARN', time: '2026-02-28T10:01:00Z', pid: 2, hostname: 'h', msg: 'b' }),
    ];
    await writeFile(join(logsDir, 'cleo.2026-02-28.1.log'), lines.join('\n'));

    const entries = [];
    for await (const entry of streamLogs(undefined, { scope: 'project' }, tmpDir)) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(2);
  });

  it('respects limit', async () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ level: 'INFO', time: `2026-02-28T10:0${i}:00Z`, pid: i, hostname: 'h', msg: `Entry ${i}` }),
    );
    await writeFile(join(logsDir, 'cleo.2026-02-28.1.log'), lines.join('\n'));

    const entries = [];
    for await (const entry of streamLogs({ limit: 3 }, { scope: 'project' }, tmpDir)) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(3);
  });

  it('applies filters while streaming', async () => {
    const lines = [
      JSON.stringify({ level: 'INFO', time: '2026-02-28T10:00:00Z', pid: 1, hostname: 'h', msg: 'skip' }),
      JSON.stringify({ level: 'ERROR', time: '2026-02-28T10:01:00Z', pid: 2, hostname: 'h', msg: 'keep' }),
      JSON.stringify({ level: 'INFO', time: '2026-02-28T10:02:00Z', pid: 3, hostname: 'h', msg: 'skip' }),
    ];
    await writeFile(join(logsDir, 'cleo.2026-02-28.1.log'), lines.join('\n'));

    const entries = [];
    for await (const entry of streamLogs({ level: 'ERROR' }, { scope: 'project' }, tmpDir)) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(1);
    expect(entries[0]!.msg).toBe('keep');
  });
});

describe('getLogSummary', () => {
  let tmpDir: string;
  let logsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cleo-summary-'));
    logsDir = join(tmpDir, '.cleo', 'logs');
    await mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns summary with counts by level and subsystem', async () => {
    const lines = [
      JSON.stringify({ level: 'INFO', time: '2026-02-28T10:00:00Z', pid: 1, hostname: 'h', msg: 'a', subsystem: 'mcp' }),
      JSON.stringify({ level: 'INFO', time: '2026-02-28T10:01:00Z', pid: 2, hostname: 'h', msg: 'b', subsystem: 'mcp' }),
      JSON.stringify({ level: 'WARN', time: '2026-02-28T10:02:00Z', pid: 3, hostname: 'h', msg: 'c', subsystem: 'engine' }),
      JSON.stringify({ level: 'ERROR', time: '2026-02-28T10:03:00Z', pid: 4, hostname: 'h', msg: 'd', subsystem: 'engine' }),
    ];
    await writeFile(join(logsDir, 'cleo.2026-02-28.1.log'), lines.join('\n'));

    const summary = getLogSummary({ scope: 'project' }, tmpDir);
    expect(summary.totalEntries).toBe(4);
    expect(summary.byLevel).toEqual({ INFO: 2, WARN: 1, ERROR: 1 });
    expect(summary.bySubsystem).toEqual({ mcp: 2, engine: 2 });
    expect(summary.dateRange).not.toBeNull();
    expect(summary.dateRange!.earliest).toBe('2026-02-28T10:00:00Z');
    expect(summary.dateRange!.latest).toBe('2026-02-28T10:03:00Z');
    expect(summary.files).toHaveLength(1);
  });

  it('returns null dateRange for empty logs', () => {
    const summary = getLogSummary({ scope: 'project' }, join(tmpDir, 'nonexistent'));
    expect(summary.totalEntries).toBe(0);
    expect(summary.dateRange).toBeNull();
  });
});
