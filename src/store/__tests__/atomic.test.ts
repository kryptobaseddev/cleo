/**
 * Tests for atomic file operations.
 * @epic T4454
 * @task T4457
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWrite, atomicWriteJson, safeReadFile } from '../atomic.js';

describe('atomicWrite', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes a file atomically', async () => {
    const filePath = join(tempDir, 'test.txt');
    await atomicWrite(filePath, 'hello world');
    const content = await readFile(filePath, 'utf8');
    expect(content).toBe('hello world');
  });

  it('creates parent directories if needed', async () => {
    const filePath = join(tempDir, 'nested', 'dir', 'test.txt');
    await atomicWrite(filePath, 'nested content');
    const content = await readFile(filePath, 'utf8');
    expect(content).toBe('nested content');
  });

  it('overwrites existing files', async () => {
    const filePath = join(tempDir, 'test.txt');
    await atomicWrite(filePath, 'first');
    await atomicWrite(filePath, 'second');
    const content = await readFile(filePath, 'utf8');
    expect(content).toBe('second');
  });
});

describe('atomicWriteJson', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes JSON with consistent formatting', async () => {
    const filePath = join(tempDir, 'data.json');
    await atomicWriteJson(filePath, { key: 'value', num: 42 });
    const content = await readFile(filePath, 'utf8');
    expect(JSON.parse(content)).toEqual({ key: 'value', num: 42 });
    // Default 2-space indent with trailing newline
    expect(content).toBe('{\n  "key": "value",\n  "num": 42\n}\n');
  });

  it('supports custom indentation', async () => {
    const filePath = join(tempDir, 'data.json');
    await atomicWriteJson(filePath, { a: 1 }, { indent: 4 });
    const content = await readFile(filePath, 'utf8');
    expect(content).toBe('{\n    "a": 1\n}\n');
  });
});

describe('safeReadFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads existing file', async () => {
    const filePath = join(tempDir, 'test.txt');
    await atomicWrite(filePath, 'content');
    const result = await safeReadFile(filePath);
    expect(result).toBe('content');
  });

  it('returns null for missing file', async () => {
    const result = await safeReadFile(join(tempDir, 'nonexistent.txt'));
    expect(result).toBeNull();
  });
});
