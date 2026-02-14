/**
 * Tests for JSON read/write with validation and checksums.
 * @epic T4454
 * @task T4457
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJson, readJsonRequired, computeChecksum, appendJsonl } from '../json.js';
import { atomicWrite } from '../atomic.js';

describe('readJson', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads and parses valid JSON', async () => {
    const filePath = join(tempDir, 'data.json');
    await writeFile(filePath, '{"key": "value"}');
    const data = await readJson(filePath);
    expect(data).toEqual({ key: 'value' });
  });

  it('returns null for missing files', async () => {
    const data = await readJson(join(tempDir, 'missing.json'));
    expect(data).toBeNull();
  });

  it('throws on invalid JSON', async () => {
    const filePath = join(tempDir, 'bad.json');
    await writeFile(filePath, '{invalid}');
    await expect(readJson(filePath)).rejects.toThrow('Invalid JSON');
  });
});

describe('readJsonRequired', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns data for existing files', async () => {
    const filePath = join(tempDir, 'data.json');
    await writeFile(filePath, '{"key": "value"}');
    const data = await readJsonRequired(filePath);
    expect(data).toEqual({ key: 'value' });
  });

  it('throws for missing files', async () => {
    await expect(
      readJsonRequired(join(tempDir, 'missing.json')),
    ).rejects.toThrow('Required file not found');
  });
});

describe('computeChecksum', () => {
  it('produces a 16-character hex string', () => {
    const checksum = computeChecksum({ tasks: [] });
    expect(checksum).toMatch(/^[a-f0-9]{16}$/);
  });

  it('produces consistent results', () => {
    const data = { tasks: [{ id: 'T001', title: 'Test' }] };
    const c1 = computeChecksum(data);
    const c2 = computeChecksum(data);
    expect(c1).toBe(c2);
  });

  it('changes when data changes', () => {
    const c1 = computeChecksum({ tasks: [] });
    const c2 = computeChecksum({ tasks: [{ id: 'T001' }] });
    expect(c1).not.toBe(c2);
  });
});

describe('appendJsonl', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a new JSONL file', async () => {
    const filePath = join(tempDir, 'manifest.jsonl');
    await appendJsonl(filePath, { id: 'T001', status: 'complete' });
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(filePath, 'utf8');
    expect(content.trim()).toBe('{"id":"T001","status":"complete"}');
  });

  it('appends to existing JSONL file', async () => {
    const filePath = join(tempDir, 'manifest.jsonl');
    await atomicWrite(filePath, '{"id":"T001"}\n');
    await appendJsonl(filePath, { id: 'T002' });
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ id: 'T001' });
    expect(JSON.parse(lines[1]!)).toEqual({ id: 'T002' });
  });
});
