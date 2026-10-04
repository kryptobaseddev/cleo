/**
 * The detached registry check behind the update notice (T13137): one small
 * dist-tags request, an atomic cache write, and the lock released whatever
 * happens.
 *
 * @task T13137
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  distTagsUrl,
  parseDistTags,
  runUpdateCheck,
  type UpdateCheckFetch,
} from '../update-check.js';
import { parseUpdateCache, type UpdateCheckRequest } from '../update-notice.js';

const NOW = new Date('2026-10-03T12:00:00.000Z');

describe('distTagsUrl', () => {
  it('escapes the scope the way npm does and tolerates a trailing slash', () => {
    expect(distTagsUrl('https://registry.npmjs.org/', '@cleocode/cleo')).toBe(
      'https://registry.npmjs.org/-/package/@cleocode%2fcleo/dist-tags',
    );
    expect(distTagsUrl('https://npm.example.com/npm', '@cleocode/cleo')).toBe(
      'https://npm.example.com/npm/-/package/@cleocode%2fcleo/dist-tags',
    );
  });
});

describe('parseDistTags', () => {
  it('keeps well-formed tags and versions only', () => {
    expect(
      parseDistTags({ latest: '2026.10.3', hotfix: '2026.10.3', beta: 7, 'bad tag': '1.0.0' }),
    ).toEqual({ latest: '2026.10.3', hotfix: '2026.10.3' });
    expect(parseDistTags({ latest: 'not-a-version' })).toEqual({});
  });

  it('rejects a body that is not an object', () => {
    expect(parseDistTags(null)).toBeNull();
    expect(parseDistTags(['2026.10.3'])).toBeNull();
    expect(parseDistTags('2026.10.3')).toBeNull();
  });
});

describe('runUpdateCheck', () => {
  let dir: string;
  let request: UpdateCheckRequest;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-update-check-'));
    request = {
      cachePath: join(dir, 'state', 'update-check.json'),
      lockPath: join(dir, 'update-check.lock'),
      registry: 'https://registry.npmjs.org/',
      packageName: '@cleocode/cleo',
    };
    writeFileSync(request.lockPath, '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the dist-tags the notice reads and releases the lock', async () => {
    const fetchImpl = vi.fn<UpdateCheckFetch>(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ latest: '2026.10.5', hotfix: '2026.10.4' }),
    }));
    const cache = await runUpdateCheck(request, fetchImpl, () => NOW);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://registry.npmjs.org/-/package/@cleocode%2fcleo/dist-tags',
    );
    expect(cache).toEqual({
      schemaVersion: 1,
      checkedAt: NOW.toISOString(),
      ok: true,
      distTags: { latest: '2026.10.5', hotfix: '2026.10.4' },
    });
    // The parent's reader accepts exactly what the child wrote.
    expect(parseUpdateCache(readFileSync(request.cachePath, 'utf8'))).toEqual(cache);
    expect(existsSync(request.lockPath)).toBe(false);
  });

  it('on failure keeps the previous dist-tags, records ok:false and releases the lock', async () => {
    await runUpdateCheck(
      request,
      async () => ({ ok: true, status: 200, json: async () => ({ latest: '2026.10.4' }) }),
      () => NOW,
    );
    writeFileSync(request.lockPath, '');

    const offline = await runUpdateCheck(
      request,
      async () => {
        throw new TypeError('fetch failed');
      },
      () => NOW,
    );
    expect(offline).toMatchObject({ ok: false, distTags: { latest: '2026.10.4' } });
    expect(existsSync(request.lockPath)).toBe(false);

    const notFound = await runUpdateCheck(
      request,
      async () => ({ ok: false, status: 404, json: async () => ({ error: 'not found' }) }),
      () => NOW,
    );
    expect(notFound).toMatchObject({ ok: false, distTags: { latest: '2026.10.4' } });
    expect(parseUpdateCache(readFileSync(request.cachePath, 'utf8'))?.ok).toBe(false);
  });
});
