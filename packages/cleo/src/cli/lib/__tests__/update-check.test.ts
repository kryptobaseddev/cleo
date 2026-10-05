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
  manifestFlagsHotfix,
  parseDistTags,
  runUpdateCheck,
  type UpdateCheckFetch,
  versionManifestUrl,
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

describe('versionManifestUrl', () => {
  it('escapes the scope the way npm does', () => {
    expect(versionManifestUrl('https://registry.npmjs.org/', '@cleocode/cleo', '2026.10.5')).toBe(
      'https://registry.npmjs.org/@cleocode%2fcleo/2026.10.5',
    );
  });
});

describe('manifestFlagsHotfix', () => {
  it('accepts only a literal cleo.hotfix: true', () => {
    expect(manifestFlagsHotfix({ cleo: { hotfix: true } })).toBe(true);
    expect(manifestFlagsHotfix({ cleo: { hotfix: 'true' } })).toBe(false);
    expect(manifestFlagsHotfix({ cleo: { hotfix: 1 } })).toBe(false);
    expect(manifestFlagsHotfix({ hotfix: true })).toBe(false);
    expect(manifestFlagsHotfix({ cleo: null })).toBe(false);
    expect(manifestFlagsHotfix(null)).toBe(false);
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

  /** A fake registry: dist-tags, plus one manifest per version (`null` = 404). */
  function registry(
    distTags: Record<string, string>,
    manifests: Record<string, object | null>,
  ): ReturnType<typeof vi.fn<UpdateCheckFetch>> {
    return vi.fn<UpdateCheckFetch>(async (url) => {
      if (url.endsWith('/dist-tags')) return { ok: true, status: 200, json: async () => distTags };
      const version = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      const manifest = manifests[version];
      if (!manifest) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
      return { ok: true, status: 200, json: async () => manifest };
    });
  }

  it('writes the dist-tags and the latest manifest flag the notice reads, then releases the lock', async () => {
    const fetchImpl = registry(
      { latest: '2026.10.5', beta: '2026.11.0-beta.1' },
      { '2026.10.5': { name: '@cleocode/cleo', version: '2026.10.5', cleo: { hotfix: true } } },
    );
    const cache = await runUpdateCheck(request, fetchImpl, () => NOW);

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'https://registry.npmjs.org/-/package/@cleocode%2fcleo/dist-tags',
      'https://registry.npmjs.org/@cleocode%2fcleo/2026.10.5',
    ]);
    expect(cache).toEqual({
      schemaVersion: 1,
      checkedAt: NOW.toISOString(),
      ok: true,
      distTags: { latest: '2026.10.5', beta: '2026.11.0-beta.1' },
      hotfix: '2026.10.5',
    });
    // The parent's reader accepts exactly what the child wrote.
    expect(parseUpdateCache(readFileSync(request.cachePath, 'utf8'))).toEqual(cache);
    expect(existsSync(request.lockPath)).toBe(false);
  });

  it('a normal release carries no flag, and a hotfix dist-tag is never consulted', async () => {
    const cache = await runUpdateCheck(
      request,
      registry(
        { latest: '2026.10.5', hotfix: '2026.10.5' },
        { '2026.10.5': { name: '@cleocode/cleo', version: '2026.10.5' } },
      ),
      () => NOW,
    );
    expect(cache.ok).toBe(true);
    expect(cache).not.toHaveProperty('hotfix');
  });

  it('remembers a flagged hotfix after a regular release replaces it as latest', async () => {
    await runUpdateCheck(
      request,
      registry({ latest: '2026.10.5' }, { '2026.10.5': { cleo: { hotfix: true } } }),
      () => NOW,
    );
    writeFileSync(request.lockPath, '');
    const later = await runUpdateCheck(
      request,
      registry({ latest: '2026.10.6' }, { '2026.10.6': { cleo: {} } }),
      () => NOW,
    );
    expect(later).toMatchObject({
      ok: true,
      distTags: { latest: '2026.10.6' },
      hotfix: '2026.10.5',
    });
  });

  it('a manifest read failure records ok:false (retry soon) and keeps the known flag', async () => {
    await runUpdateCheck(
      request,
      registry({ latest: '2026.10.5' }, { '2026.10.5': { cleo: { hotfix: true } } }),
      () => NOW,
    );
    writeFileSync(request.lockPath, '');
    const cache = await runUpdateCheck(request, registry({ latest: '2026.10.6' }, {}), () => NOW);
    expect(cache).toMatchObject({
      ok: false,
      distTags: { latest: '2026.10.6' },
      hotfix: '2026.10.5',
    });
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
