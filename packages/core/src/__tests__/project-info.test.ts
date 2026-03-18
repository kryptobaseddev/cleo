import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProjectInfo, getProjectInfoSync } from '../project-info.js';

describe('getProjectInfo', () => {
  let tempDir: string;
  let cleoDir: string;
  let infoPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-project-info-'));
    cleoDir = join(tempDir, '.cleo');
    infoPath = join(cleoDir, 'project-info.json');
    await mkdir(cleoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads project-info.json with all fields', async () => {
    const data = {
      projectHash: 'abc123def456',
      projectId: '550e8400-e29b-41d4-a716-446655440000',
      cleoVersion: '2026.3.11',
      lastUpdated: '2026-03-04T00:00:00.000Z',
    };
    await writeFile(infoPath, JSON.stringify(data));

    const info = await getProjectInfo(tempDir);

    expect(info.projectHash).toBe('abc123def456');
    expect(info.projectId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(info.projectRoot).toBe(tempDir);
    expect(info.projectName).toBeTruthy();
  });

  it('returns empty projectId when field is missing (pre-T5333 install)', async () => {
    const data = {
      projectHash: 'abc123def456',
      cleoVersion: '2026.3.11',
    };
    await writeFile(infoPath, JSON.stringify(data));

    const info = await getProjectInfo(tempDir);

    expect(info.projectHash).toBe('abc123def456');
    expect(info.projectId).toBe('');
  });

  it('throws when file does not exist', async () => {
    await expect(getProjectInfo(join(tempDir, 'nonexistent'))).rejects.toThrow();
  });

  it('throws when projectHash is missing', async () => {
    const data = { cleoVersion: '2026.3.11' };
    await writeFile(infoPath, JSON.stringify(data));

    await expect(getProjectInfo(tempDir)).rejects.toThrow('projectHash');
  });

  it('throws on invalid JSON', async () => {
    await writeFile(infoPath, 'not json');

    await expect(getProjectInfo(tempDir)).rejects.toThrow();
  });

  it('derives projectName from the last path segment', async () => {
    const data = {
      projectHash: 'abc123def456',
      projectId: 'some-uuid',
    };
    await writeFile(infoPath, JSON.stringify(data));

    const info = await getProjectInfo(tempDir);
    const { basename } = await import('node:path');
    const expectedName = basename(tempDir);

    expect(info.projectName).toBe(expectedName);
  });
});

describe('getProjectInfoSync', () => {
  let tempDir: string;
  let cleoDir: string;
  let infoPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-project-info-sync-'));
    cleoDir = join(tempDir, '.cleo');
    infoPath = join(cleoDir, 'project-info.json');
    await mkdir(cleoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads project-info.json synchronously', async () => {
    const data = {
      projectHash: 'abc123def456',
      projectId: 'sync-uuid',
    };
    await writeFile(infoPath, JSON.stringify(data));

    const info = getProjectInfoSync(tempDir);

    expect(info).not.toBeNull();
    expect(info!.projectHash).toBe('abc123def456');
    expect(info!.projectId).toBe('sync-uuid');
  });

  it('returns null when file does not exist', () => {
    const info = getProjectInfoSync(join(tempDir, 'nonexistent'));
    expect(info).toBeNull();
  });

  it('returns null when projectHash is missing', async () => {
    await writeFile(infoPath, JSON.stringify({ cleoVersion: '1.0.0' }));
    const info = getProjectInfoSync(tempDir);
    expect(info).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    await writeFile(infoPath, '{broken');
    const info = getProjectInfoSync(tempDir);
    expect(info).toBeNull();
  });
});

describe('scaffold.ts ensureProjectInfo projectId backfill', () => {
  let tempDir: string;
  let cleoDir: string;
  let infoPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-scaffold-pid-'));
    cleoDir = join(tempDir, '.cleo');
    infoPath = join(cleoDir, 'project-info.json');
    await mkdir(cleoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('backfills projectId on existing project-info.json that lacks it', async () => {
    const existing = {
      $schema: './schemas/project-info.schema.json',
      schemaVersion: '1.0.0',
      projectHash: 'abc123def456',
      cleoVersion: '2026.3.11',
      lastUpdated: '2026-03-04T00:00:00.000Z',
    };
    await writeFile(infoPath, JSON.stringify(existing, null, 2));

    const { ensureProjectInfo } = await import('../scaffold.js');
    const result = await ensureProjectInfo(tempDir);

    expect(result.action).toBe('repaired');
    expect(result.details).toBe('Added projectId');

    const updated = JSON.parse(await readFile(infoPath, 'utf-8'));
    expect(typeof updated.projectId).toBe('string');
    expect(updated.projectId.length).toBeGreaterThan(0);
    // UUID format: 8-4-4-4-12
    expect(updated.projectId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // Existing fields preserved
    expect(updated.projectHash).toBe('abc123def456');
    expect(updated.cleoVersion).toBe('2026.3.11');
  });

  it('skips when projectId already exists', async () => {
    const existing = {
      projectHash: 'abc123def456',
      projectId: 'existing-uuid-value',
      cleoVersion: '2026.3.11',
      lastUpdated: '2026-03-04T00:00:00.000Z',
    };
    await writeFile(infoPath, JSON.stringify(existing, null, 2));

    const { ensureProjectInfo } = await import('../scaffold.js');
    const result = await ensureProjectInfo(tempDir);

    expect(result.action).toBe('skipped');

    const afterCall = JSON.parse(await readFile(infoPath, 'utf-8'));
    expect(afterCall.projectId).toBe('existing-uuid-value');
  });
});
