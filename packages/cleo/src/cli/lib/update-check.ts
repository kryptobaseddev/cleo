/**
 * The background registry check behind the passive update notice (T13137).
 *
 * Runs in a detached child started by `showUpdateNotice` (`update-notice.ts`),
 * never in a command's own process: it fetches the package's dist-tags (one small
 * JSON object), then the `latest` version's manifest, whose `cleo.hotfix: true`
 * flags a hotfix (T13184: release.yml writes it for a `--hotfix` plan, so the
 * flag ships through the tokenless publish; no dist-tag is consulted). It
 * rewrites the cache the next commands read. Everything it needs arrives on its
 * command line.
 *
 * The cache keeps the highest flagged version it has ever seen, so an install
 * that missed a hotfix still hears about it after a regular release replaces it
 * as `latest`.
 *
 * A failed check keeps the previous cache contents and records `ok: false`, so
 * the next command retries after the short interval instead of a day.
 *
 * @module
 * @task T13137
 * @task T13184
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  compareVersions,
  type UpdateCheckCache,
  type UpdateCheckRequest,
} from './update-notice.js';

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
 * The registry URL of one version's manifest (its published package.json plus
 * registry fields), with the scoped name escaped as npm does.
 *
 * @param registry - Registry base URL.
 * @param packageName - Package name.
 * @param version - Exact version.
 * @returns The manifest URL.
 *
 * @example
 * ```ts
 * versionManifestUrl('https://registry.npmjs.org/', '@cleocode/cleo', '2026.10.5');
 * // → 'https://registry.npmjs.org/@cleocode%2fcleo/2026.10.5'
 * ```
 */
export function versionManifestUrl(registry: string, packageName: string, version: string): string {
  return `${registry.replace(/\/+$/, '')}/${packageName.replace('/', '%2f')}/${encodeURIComponent(version)}`;
}

/**
 * Whether a version manifest flags a hotfix: `"cleo": { "hotfix": true }`, the
 * field release.yml writes for a release planned with `--hotfix`.
 *
 * @param body - Parsed manifest.
 * @returns `true` only for a literal `true`.
 */
export function manifestFlagsHotfix(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || !('cleo' in body)) return false;
  const meta = body.cleo;
  return typeof meta === 'object' && meta !== null && 'hotfix' in meta && meta.hotfix === true;
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

/** dist-tags and flagged hotfix of the existing cache, if it is readable. */
function previousCache(cachePath: string): { distTags: Record<string, string>; hotfix?: string } {
  try {
    const body: unknown = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (typeof body === 'object' && body !== null) {
      const distTags = 'distTags' in body ? (parseDistTags(body.distTags) ?? {}) : {};
      const hotfix = 'hotfix' in body ? body.hotfix : undefined;
      return typeof hotfix === 'string' && VERSION_RE.test(hotfix)
        ? { distTags, hotfix }
        : { distTags };
    }
  } catch {
    // No previous cache.
  }
  return { distTags: {} };
}

/** The higher of two optional versions. */
function maxVersion(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return (compareVersions(a, b) ?? 0) >= 0 ? a : b;
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
  const previous = previousCache(request.cachePath);
  const signal = AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS);
  const headers = { accept: 'application/json' };
  let distTags: Record<string, string> | null = null;
  let manifestRead = false;
  let flagged: string | undefined;
  try {
    const response = await fetchImpl(distTagsUrl(request.registry, request.packageName), {
      signal,
      headers,
    });
    if (response.ok) distTags = parseDistTags(await response.json());
    const latest = distTags?.['latest'];
    if (latest !== undefined) {
      const manifest = await fetchImpl(
        versionManifestUrl(request.registry, request.packageName, latest),
        { signal, headers },
      );
      if (manifest.ok) {
        manifestRead = true;
        if (manifestFlagsHotfix(await manifest.json())) flagged = latest;
      }
    }
  } catch {
    // Offline, timed out or not JSON: recorded as a failed check below.
  }
  const hotfix = maxVersion(previous.hotfix, flagged);
  const cache: UpdateCheckCache = {
    schemaVersion: 1,
    checkedAt: now().toISOString(),
    // Both reads must succeed: a missed manifest would hide a hotfix for a day.
    ok: distTags !== null && (manifestRead || distTags['latest'] === undefined),
    distTags: distTags ?? previous.distTags,
    ...(hotfix === undefined ? {} : { hotfix }),
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
