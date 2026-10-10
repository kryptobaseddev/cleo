/** Real lock-file fixtures with narrowly injected acquisition failures. */
import { existsSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withFileLock } from '../../src/core/fs/atomic.js';
import type { CaampLockFile, LockEntry } from '../../src/types.js';

// Retain real descriptors and every filesystem operation. Only acquisition faults are injected.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});
const fixture = vi.hoisted(() => ({ path: '' }));

let directory: string;
const emptyLock = (): CaampLockFile => ({ version: 1, skills: {}, mcpServers: {} });
const entry = (): LockEntry => ({
  name: 'test',
  scopedName: 'test',
  source: 'fixture',
  sourceType: 'local',
  installedAt: '2026-10-10T00:00:00.000Z',
  agents: ['codex'],
  canonicalPath: join(directory, 'skills/test'),
  isGlobal: false,
  projectDir: directory,
});
beforeEach(async () => {
  vi.resetModules();
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockReset().mockImplementation(original.open);
  directory = await mkdtemp(join(tmpdir(), 'caamp-lock-branches-'));
  fixture.path = join(directory, '.caamp-lock.json');
  vi.doMock('../../src/core/paths/agents.js', () => ({ LOCK_FILE_PATH: fixture.path }));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('lock acquisition and real lock-file persistence', () => {
  it.each([
    Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    new Error('uncategorized acquisition failure'),
    'raw acquisition failure',
  ])('propagates an acquisition fault unchanged without writing a lock file: %s', async (failure) => {
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementation((path, flags, mode) => {
      if (path === fixture.path + '.lock' && flags === 'wx') return Promise.reject(failure);
      return original.open(path, flags, mode);
    });
    const { writeLockFile } = await import('../../src/core/lock-utils.js');
    await expect(writeLockFile(emptyLock())).rejects.toBe(failure);
    expect(existsSync(fixture.path)).toBe(false);
    expect(existsSync(fixture.path + '.lock')).toBe(false);
  });
  it('retries a real EEXIST guard then acquires after its holder releases it', async () => {
    await writeFile(fixture.path + '.lock', 'other-holder');
    let entered = false;
    const release = setTimeout(() => {
      void rm(fixture.path + '.lock');
    }, 10);
    try {
      await withFileLock(
        fixture.path,
        async () => {
          entered = true;
          expect(await readFile(fixture.path + '.lock', 'utf8')).not.toBe('other-holder');
        },
        { retries: 20, delayMs: 5, staleMs: 60000 },
      );
    } finally {
      clearTimeout(release);
    }
    expect(entered).toBe(true);
    expect(existsSync(fixture.path + '.lock')).toBe(false);
  });
  it('times out behind a live guard without entering or deleting the other holder', async () => {
    await writeFile(fixture.path + '.lock', 'live-holder');
    const work = vi.fn(async () => undefined);
    await expect(
      withFileLock(fixture.path, work, { retries: 2, delayMs: 1, staleMs: 60000 }),
    ).rejects.toThrow('after 2 attempts');
    expect(work).not.toHaveBeenCalled();
    expect(await readFile(fixture.path + '.lock', 'utf8')).toBe('live-holder');
  });
  it('returns the empty default for a missing file and malformed JSON', async () => {
    const { readLockFile } = await import('../../src/core/lock-utils.js');
    expect(await readLockFile()).toEqual(emptyLock());
    await writeFile(fixture.path, '{{invalid');
    expect(await readLockFile()).toEqual(emptyLock());
    expect(await readFile(fixture.path, 'utf8')).toBe('{{invalid');
  });
  it('reads a real existing concrete lock entry', async () => {
    const expected: CaampLockFile = { ...emptyLock(), skills: { test: entry() } };
    await writeFile(fixture.path, JSON.stringify(expected));
    const { readLockFile } = await import('../../src/core/lock-utils.js');
    expect(await readLockFile()).toEqual(expected);
  });
  it('updates under a real guard and persists both previous and new entries', async () => {
    const previous: CaampLockFile = { ...emptyLock(), mcpServers: { existing: entry() } };
    await writeFile(fixture.path, JSON.stringify(previous));
    const { readLockFile, updateLockFile } = await import('../../src/core/lock-utils.js');
    const result = await updateLockFile((lock) => {
      lock.skills.test = entry();
    });
    expect(result.mcpServers).toEqual(previous.mcpServers);
    expect(result.skills.test).toEqual(entry());
    expect(await readLockFile()).toEqual(result);
    expect(existsSync(fixture.path + '.lock')).toBe(false);
  });
});
