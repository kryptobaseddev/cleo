/**
 * Tests for log file discovery and reading.
 * @task T5187
 * @epic T5186
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverLogFiles, readLogFileLines, streamLogFileLines } from '../log-reader.js';
import type { LogFileInfo } from '../types.js';

describe('readLogFileLines', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cleo-log-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reads lines from a valid log file', async () => {
    const content = [
      '{"level":"INFO","time":"2026-01-01T00:00:00Z","pid":1,"hostname":"h","msg":"a"}',
      '{"level":"WARN","time":"2026-01-01T00:01:00Z","pid":2,"hostname":"h","msg":"b"}',
    ].join('\n');
    const filePath = join(tmpDir, 'test.log');
    await writeFile(filePath, content);

    const lines = readLogFileLines(filePath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"INFO"');
    expect(lines[1]).toContain('"WARN"');
  });

  it('returns empty array for missing file', () => {
    expect(readLogFileLines(join(tmpDir, 'nonexistent.log'))).toEqual([]);
  });

  it('returns empty array for empty file', async () => {
    const filePath = join(tmpDir, 'empty.log');
    await writeFile(filePath, '');
    expect(readLogFileLines(filePath)).toEqual([]);
  });

  it('skips blank lines', async () => {
    const content = '{"level":"INFO","time":"2026-01-01T00:00:00Z","pid":1,"hostname":"h","msg":"a"}\n\n\n{"level":"WARN","time":"2026-01-01T00:01:00Z","pid":2,"hostname":"h","msg":"b"}\n';
    const filePath = join(tmpDir, 'gaps.log');
    await writeFile(filePath, content);

    const lines = readLogFileLines(filePath);
    expect(lines).toHaveLength(2);
  });
});

describe('streamLogFileLines', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cleo-log-stream-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('streams lines from a file', async () => {
    const content = [
      '{"level":"INFO","time":"2026-01-01T00:00:00Z","pid":1,"hostname":"h","msg":"a"}',
      '{"level":"WARN","time":"2026-01-01T00:01:00Z","pid":2,"hostname":"h","msg":"b"}',
      '{"level":"ERROR","time":"2026-01-01T00:02:00Z","pid":3,"hostname":"h","msg":"c"}',
    ].join('\n');
    const filePath = join(tmpDir, 'stream.log');
    await writeFile(filePath, content);

    const lines: string[] = [];
    for await (const line of streamLogFileLines(filePath)) {
      lines.push(line);
    }
    expect(lines).toHaveLength(3);
  });

  it('yields nothing for missing file', async () => {
    const lines: string[] = [];
    for await (const line of streamLogFileLines(join(tmpDir, 'nope.log'))) {
      lines.push(line);
    }
    expect(lines).toEqual([]);
  });

  it('skips empty lines', async () => {
    const content = '{"level":"INFO","time":"2026-01-01T00:00:00Z","pid":1,"hostname":"h","msg":"a"}\n\n\n';
    const filePath = join(tmpDir, 'blanks.log');
    await writeFile(filePath, content);

    const lines: string[] = [];
    for await (const line of streamLogFileLines(filePath)) {
      lines.push(line);
    }
    expect(lines).toHaveLength(1);
  });
});

describe('discoverLogFiles', () => {
  let tmpDir: string;
  let logsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cleo-discover-'));
    logsDir = join(tmpDir, '.cleo', 'logs');
    await mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('discovers cleo log files sorted by mtime', async () => {
    await writeFile(join(logsDir, 'cleo.2026-01-01.1.log'), 'line1\n');
    // Small delay to ensure different mtime
    await new Promise(r => setTimeout(r, 50));
    await writeFile(join(logsDir, 'cleo.2026-01-02.1.log'), 'line2\n');

    // Override getProjectLogDir by passing cwd
    const files = discoverLogFiles({ scope: 'project' }, tmpDir);
    expect(files.length).toBeGreaterThanOrEqual(2);

    // Newest first
    const cleoFiles = files.filter(f => f.name.startsWith('cleo.'));
    expect(cleoFiles[0]!.name).toBe('cleo.2026-01-02.1.log');
    expect(cleoFiles[0]!.date).toBe('2026-01-02');
    expect(cleoFiles[0]!.isActive).toBe(true);
  });

  it('extracts date from filename', async () => {
    await writeFile(join(logsDir, 'cleo.2026-03-15.1.log'), 'data\n');

    const files = discoverLogFiles({ scope: 'project' }, tmpDir);
    const cleoFiles = files.filter(f => f.name.startsWith('cleo.'));
    expect(cleoFiles).toHaveLength(1);
    expect(cleoFiles[0]!.date).toBe('2026-03-15');
  });

  it('excludes migration logs by default', async () => {
    await writeFile(join(logsDir, 'cleo.2026-01-01.1.log'), 'data\n');
    await writeFile(join(logsDir, 'migration-2026-01-01T00-00-00.jsonl'), 'data\n');

    const files = discoverLogFiles({ scope: 'project' }, tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('cleo.2026-01-01.1.log');
  });

  it('includes migration logs when requested', async () => {
    await writeFile(join(logsDir, 'cleo.2026-01-01.1.log'), 'data\n');
    await writeFile(join(logsDir, 'migration-2026-01-01T00-00-00.jsonl'), 'data\n');

    const files = discoverLogFiles({ scope: 'project', includeMigration: true }, tmpDir);
    expect(files).toHaveLength(2);
  });

  it('ignores non-log files', async () => {
    await writeFile(join(logsDir, 'cleo.2026-01-01.1.log'), 'data\n');
    await writeFile(join(logsDir, 'random.txt'), 'not a log\n');
    await writeFile(join(logsDir, 'notes.md'), 'notes\n');

    const files = discoverLogFiles({ scope: 'project' }, tmpDir);
    expect(files).toHaveLength(1);
  });

  it('returns empty array for missing directory', () => {
    const files = discoverLogFiles({ scope: 'project' }, join(tmpDir, 'nonexistent'));
    expect(files).toEqual([]);
  });

  it('includes file size', async () => {
    const content = 'a'.repeat(100);
    await writeFile(join(logsDir, 'cleo.2026-01-01.1.log'), content);

    const files = discoverLogFiles({ scope: 'project' }, tmpDir);
    expect(files[0]!.size).toBe(100);
  });
});
