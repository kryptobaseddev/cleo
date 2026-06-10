/**
 * Table-first catalog read chokepoint — `resolveCatalogEntry()` (E8 · T11737).
 *
 * ## The single read chokepoint
 *
 * The provider+model catalog now has THREE physical surfaces, in strict priority:
 *
 *   1. **`models_catalog` DB table** (cleo-global · T11733) — the SSoT. Seeded
 *      from the shipped offline `curated-catalog.json` (T11734).
 *   2. **disk JSON cache** (`llm-catalog/` · T9314 · `catalog-cache.ts`) — the
 *      offline/degraded fallback MIRROR (the most-recent models.dev snapshot).
 *   3. **shipped seed** (`curated-catalog.json`) — the last-resort floor that
 *      always ships in the package, so a fresh/offline install always resolves.
 *
 * Every catalog reader (the resolver default — T11944; future capability lookups)
 * funnels through {@link resolveCatalogEntry} so the table and the cache can NEVER
 * silently diverge: one chokepoint, table-or-fallback, in that order.
 *
 * ## Offline-first (degrade) — NO network at read time
 *
 * This module NEVER fetches. The network refresh op (`cleo llm refresh-catalog`)
 * is a SEPARATE leaf. `resolveCatalogEntry()` reads the DB table first; when the
 * table is empty/unseeded it falls back to the disk-cache snapshot, then to the
 * shipped seed. A fresh install with no DB rows and no disk cache still resolves
 * from the bundled `curated-catalog.json`.
 *
 * @module llm/catalog-resolver
 * @task T11737
 * @epic T11694 (E8-CATALOG-CURATION)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CuratedCatalog } from '@cleocode/contracts';
import { getLogger } from '../logger.js';
import {
  type CleoGlobalDb,
  openDualScopeDb,
  openDualScopeDbAtPath,
} from '../store/dual-scope-db.js';
import { modelsCatalog } from '../store/schema/cleo-global/models-catalog.js';
import { findLatestCacheFile, getCatalogDir, readCacheFile } from './catalog-cache.js';

const logger = getLogger('llm-catalog-resolver');

/**
 * A normalized catalog entry returned by {@link resolveCatalogEntry}.
 *
 * The shape is the union of the fields the resolver-default path (T11944) and the
 * capability lookups actually consume — it is provenance-agnostic so callers do
 * NOT care whether the entry came from the table, the disk cache, or the seed.
 */
export interface ResolvedCatalogEntry {
  /** Model id (e.g. `claude-haiku-4-5-20251001`). */
  readonly id: string;
  /** Provider key (models.dev id, e.g. `anthropic`). */
  readonly providerId: string;
  /** ISO release date `YYYY-MM-DD`. The SSoT sort key. */
  readonly releaseDate: string;
  /** Max context window (tokens), when known. */
  readonly contextLimit: number | null;
  /** Where this entry was resolved from (provenance). */
  readonly source: CatalogResolutionSource;
}

/** Provenance of a {@link ResolvedCatalogEntry} (table-first, then fallbacks). */
export type CatalogResolutionSource = 'table' | 'disk-cache' | 'shipped-seed';

/** Injectable seam for {@link resolveCatalogEntry} (tests pass a temp-DB handle). */
export interface CatalogResolverDeps {
  /**
   * An already-open global Drizzle handle. When omitted the resolver opens via
   * {@link openDualScopeDb}`('global')`. Tests pass a temp-DB handle (opened via
   * {@link openCatalogAtPath}) to stay off `.cleo/*.db`.
   */
  readonly db?: CleoGlobalDb;
  /**
   * Disk-cache directory override (tests). Defaults to {@link getCatalogDir}.
   */
  readonly cacheDir?: string;
}

/** In-memory shipped-seed cache for the process lifetime. */
let _seed: CuratedCatalog | null | undefined;

/**
 * Open the global catalog handle at an EXPLICIT path (test seam).
 *
 * Production callers MUST use {@link openDualScopeDb}`('global')`. This path-aware
 * variant exists so tests open a temp-dir `cleo.db` — never `.cleo/*.db`.
 *
 * @param dbPath - Absolute path to the temp `cleo.db`.
 * @task T11737
 */
export async function openCatalogAtPath(dbPath: string): Promise<CleoGlobalDb> {
  const handle = await openDualScopeDbAtPath('global', dbPath);
  return handle.db;
}

/**
 * Load the shipped seed (`curated-catalog.json`) from disk — no network.
 *
 * Read once and cached for the process lifetime. Returns `null` only if the
 * bundled file is missing/unparseable (never expected — it ships in the package).
 *
 * @internal
 */
export function loadShippedSeed(): CuratedCatalog | null {
  if (_seed !== undefined) return _seed;
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const jsonPath = join(thisDir, 'curated-catalog.json');
    _seed = JSON.parse(readFileSync(jsonPath, 'utf-8')) as CuratedCatalog;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'catalog-resolver: shipped seed unreadable',
    );
    _seed = null;
  }
  return _seed;
}

/** Resolve the global Drizzle handle — injected, else canonical open. */
async function resolveDb(deps?: CatalogResolverDeps): Promise<CleoGlobalDb> {
  if (deps?.db !== undefined) return deps.db;
  const handle = await openDualScopeDb('global');
  return handle.db;
}

/**
 * Read the latest-released entry for a provider from the `models_catalog` table.
 *
 * Returns the single newest row (ordered by `release_date` DESC, `id` DESC as a
 * stable tie-break) for the provider, or `null` when the provider has no rows
 * (table empty/unseeded for that provider). LIMIT 1 — never scans the whole table.
 *
 * @internal
 */
async function readLatestFromTable(
  db: CleoGlobalDb,
  providerId: string,
): Promise<ResolvedCatalogEntry | null> {
  const { desc, eq } = await import('drizzle-orm');
  const rows = await db
    .select({
      id: modelsCatalog.id,
      providerId: modelsCatalog.providerId,
      releaseDate: modelsCatalog.releaseDate,
      contextLimit: modelsCatalog.contextLimit,
    })
    .from(modelsCatalog)
    .where(eq(modelsCatalog.providerId, providerId))
    .orderBy(desc(modelsCatalog.releaseDate), desc(modelsCatalog.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    providerId: row.providerId,
    releaseDate: row.releaseDate,
    contextLimit: row.contextLimit ?? null,
    source: 'table',
  };
}

/**
 * Resolve the latest-released catalog entry for a provider from a catalog snapshot
 * (disk-cache file or shipped seed), sorted by `release_date` DESC.
 *
 * The two fallback surfaces carry different shapes — the disk cache is the raw
 * models.dev `{ [provider]: { models: { [id]: { release_date, limit } } } }`, the
 * shipped seed is the curated `{ models: { [provider]: { [id]: entry } } }`. This
 * helper accepts the already-extracted per-provider model map.
 *
 * @internal
 */
function latestFromModelMap(
  models: Record<string, { release_date?: string; limit?: { context?: number } }>,
  providerId: string,
  source: 'disk-cache' | 'shipped-seed',
): ResolvedCatalogEntry | null {
  let bestId: string | null = null;
  let bestDate = '';
  let bestCtx: number | null = null;
  for (const [id, entry] of Object.entries(models)) {
    const rd = entry.release_date;
    if (!rd) continue;
    if (rd > bestDate || (rd === bestDate && bestId !== null && id > bestId)) {
      bestDate = rd;
      bestId = id;
      bestCtx = entry.limit?.context ?? null;
    }
  }
  if (bestId === null) return null;
  return { id: bestId, providerId, releaseDate: bestDate, contextLimit: bestCtx, source };
}

/**
 * Resolve the latest-released catalog entry for a provider — the SINGLE table-first
 * read chokepoint (T11737).
 *
 * Resolution order (offline-first, no network):
 *   1. `models_catalog` DB table (SSoT) — newest `release_date` row for the provider.
 *   2. disk JSON cache (`llm-catalog/`) — newest entry when the table has no rows.
 *   3. shipped `curated-catalog.json` seed — last-resort floor (always present).
 *
 * Returns `null` only when NONE of the three surfaces carry a dated entry for the
 * provider — callers then degrade to their own static literal floor (the resolver
 * default keeps `IMPLICIT_FALLBACK_MODEL` for exactly this case — T11944).
 *
 * @param providerCatalogKey - The models.dev provider key (e.g. `anthropic`).
 * @param deps - Optional injected DB handle / cache dir (tests).
 * @returns The newest-released entry for the provider, or `null` when unresolved.
 *
 * @task T11737
 */
export async function resolveCatalogEntry(
  providerCatalogKey: string,
  deps?: CatalogResolverDeps,
): Promise<ResolvedCatalogEntry | null> {
  const providerId = providerCatalogKey.toLowerCase();

  // 1. Table-first (SSoT).
  try {
    const db = await resolveDb(deps);
    const fromTable = await readLatestFromTable(db, providerId);
    if (fromTable) return fromTable;
  } catch (err) {
    // A table read failure must NOT break resolution — degrade to the mirrors.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), providerId },
      'catalog-resolver: models_catalog read failed; falling back to disk cache',
    );
  }

  // 2. Disk-cache mirror.
  const cacheDir = deps?.cacheDir ?? getCatalogDir();
  const latest = findLatestCacheFile(cacheDir);
  if (latest) {
    const cache = readCacheFile(latest);
    const provider = cache?.[providerId];
    if (provider?.models) {
      const fromCache = latestFromModelMap(provider.models, providerId, 'disk-cache');
      if (fromCache) return fromCache;
    }
  }

  // 3. Shipped-seed floor (always present in the package).
  const seed = loadShippedSeed();
  const seedModels = seed?.models?.[providerId];
  if (seedModels) {
    const fromSeed = latestFromModelMap(seedModels, providerId, 'shipped-seed');
    if (fromSeed) return fromSeed;
  }

  return null;
}

/**
 * Reset the in-memory shipped-seed cache.
 *
 * @internal — for use in unit tests only.
 */
export function _resetCatalogResolverCache(): void {
  _seed = undefined;
}
