import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worktreeScope } from '../paths.js';
import { getProjectInfo, getProjectInfoSync } from '../project-info.js';

// Explicit cwd identifies each fixture; retain only the global sandbox bindings.
beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    // PM-Core V2 (c636c662b): ensureProjectInfo backfills projectId AND name,
    // so the repair message is the generic 'Backfilled missing fields'.
    expect(result.details).toBe('Backfilled missing fields');

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

  it('skips when projectId and name already exist', async () => {
    const existing = {
      projectHash: 'abc123def456',
      projectId: 'existing-uuid-value',
      // PM-Core V2 also backfills name — include it so nothing needs repair.
      name: 'existing-project',
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

describe('captured metadata ownership', () => {
  let root: string;
  let first: string;
  let second: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'captured-project-info-'));
    first = join(root, 'first');
    second = join(root, 'second');
    for (const [path, id] of [
      [first, 'first-id'],
      [second, 'second-id'],
    ]) {
      await mkdir(join(path!, '.cleo'), { recursive: true });
      await writeFile(
        join(path!, '.cleo/project-info.json'),
        JSON.stringify({ projectHash: id + '-hash', projectId: id }),
      );
    }
    vi.stubEnv('CLEO_DIR', join(first, '.cleo'));
    vi.stubEnv('CLEO_ROOT', first);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses captured ownership for asynchronous and synchronous metadata under another ambient project', async () => {
    const result = await worktreeScope.run(
      { worktreeRoot: second, projectHash: 'second-id-hash' },
      async () => ({
        async: await getProjectInfo(second),
        sync: getProjectInfoSync(second),
      }),
    );
    expect(result.async).toMatchObject({
      projectId: 'second-id',
      projectHash: 'second-id-hash',
      projectRoot: second,
    });
    expect(result.sync).toMatchObject({
      projectId: 'second-id',
      projectHash: 'second-id-hash',
      projectRoot: second,
    });
    expect(getProjectInfoSync(first)?.projectId).toBe('first-id');
    expect(worktreeScope.getStore()).toBeUndefined();
  });

  it('keeps interleaved metadata reads scoped when ambient pins change between awaits', async () => {
    const firstReady = Promise.withResolvers<void>();
    const secondReady = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pendingFirst = worktreeScope.run(
      { worktreeRoot: first, projectHash: 'first-id-hash' },
      async () => {
        firstReady.resolve();
        await release.promise;
        return { async: await getProjectInfo(first), sync: getProjectInfoSync(first) };
      },
    );
    const pendingSecond = worktreeScope.run(
      { worktreeRoot: second, projectHash: 'second-id-hash' },
      async () => {
        secondReady.resolve();
        await release.promise;
        return { async: await getProjectInfo(second), sync: getProjectInfoSync(second) };
      },
    );
    await Promise.all([firstReady.promise, secondReady.promise]);
    vi.stubEnv('CLEO_DIR', join(root, 'unrelated/.cleo'));
    vi.stubEnv('CLEO_ROOT', join(root, 'unrelated'));
    release.resolve();
    const [a, b] = await Promise.all([pendingFirst, pendingSecond]);
    expect(a.async.projectId).toBe('first-id');
    expect(a.sync?.projectId).toBe('first-id');
    expect(b.async.projectId).toBe('second-id');
    expect(b.sync?.projectId).toBe('second-id');
    expect(worktreeScope.getStore()).toBeUndefined();
  });
});
