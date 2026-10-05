/**
 * The background registry check behind the passive update notice (T13137).
 *
 * Runs in a detached child started by `showUpdateNotice` (`update-notice.ts`),
 * never in a command's own process: it fetches the package's dist-tags (one small
 * JSON object, which also carries the `hotfix` flag) and rewrites the cache the
 * next commands read. Everything it needs arrives on its command line, so it
 * shares no runtime code with the CLI's startup graph.
 *
 * A failed check keeps the previous dist-tags and records `ok: false`, so the
 * next command retries after the short interval instead of a day.
 *
 * @module
 * @task T13137
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UpdateCheckCache, UpdateCheckRequest } from './update-notice.js';

/** The whole check, including the response body, must finish within this. */
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;

/** At most this many dist-tags are kept from a response. */
const MAX_DIST_TAGS = 32;

/** A version string as the registry reports one. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The subset of `fetch` the check uses. */
export type UpdateCheckFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * The registry URL of a package's dist-tags, escaped the way npm escapes a
 * scoped name (`@scope%2fname`).
 *
 * @param registry - Registry base URL.
 * @param packageName - Package name.
 * @returns The dist-tags URL.
 *
 * @example
 * ```ts
 * distTagsUrl('https://registry.npmjs.org/', '@cleocode/cleo');
 * // → 'https://registry.npmjs.org/-/package/@cleocode%2fcleo/dist-tags'
 * ```
 */
export function distTagsUrl(registry: string, packageName: string): string {
  return `${registry.replace(/\/+$/, '')}/-/package/${packageName.replace('/', '%2f')}/dist-tags`;
}

/**
 * Keep the well-formed entries of a dist-tags response.
 *
 * @param body - Parsed response body.
 * @returns dist-tag → version; `null` when the body is not an object.
 */
export function parseDistTags(body: unknown): Record<string, string> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const tags: Record<string, string> = {};
  for (const [tag, version] of Object.entries(body)) {
    if (Object.keys(tags).length >= MAX_DIST_TAGS) break;
    if (/^[A-Za-z0-9._-]{1,64}$/.test(tag) && typeof version === 'string') {
      if (VERSION_RE.test(version)) tags[tag] = version;
    }
  }
  return tags;
}

/** dist-tags of the existing cache, if it is readable. */
function previousDistTags(cachePath: string): Record<string, string> {
  try {
    const body: unknown = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (typeof body === 'object' && body !== null && 'distTags' in body) {
      return parseDistTags(body.distTags) ?? {};
    }
  } catch {
    // No previous cache.
  }
  return {};
}

/** Write the cache atomically: a reader sees the old file or the new one. */
function writeCache(cachePath: string, cache: UpdateCheckCache): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache)}\n`);
  renameSync(tmp, cachePath);
}

/**
 * Fetch the dist-tags, rewrite the cache and release the lock. Never throws.
 *
 * @param request - Paths, registry and package from the parent.
 * @param fetchImpl - `fetch`; injectable for tests.
 * @param now - Current time; injectable for tests.
 * @returns The cache as written (or as it would have been, if the write failed).
 */
export async function runUpdateCheck(
  request: UpdateCheckRequest,
  fetchImpl: UpdateCheckFetch = fetch,
  now: () => Date = () => new Date(),
): Promise<UpdateCheckCache> {
  let distTags: Record<string, string> | null = null;
  try {
    const response = await fetchImpl(distTagsUrl(request.registry, request.packageName), {
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (response.ok) distTags = parseDistTags(await response.json());
  } catch {
    // Offline, timed out or not JSON: recorded as a failed check below.
  }
  const cache: UpdateCheckCache = {
    schemaVersion: 1,
    checkedAt: now().toISOString(),
    ok: distTags !== null,
    distTags: distTags ?? previousDistTags(request.cachePath),
  };
  try {
    writeCache(request.cachePath, cache);
  } catch {
    // Unwritable state dir: the next command will try again.
  }
  try {
    unlinkSync(request.lockPath);
  } catch {
    // Already removed (reclaimed as stale).
  }
  return cache;
}
