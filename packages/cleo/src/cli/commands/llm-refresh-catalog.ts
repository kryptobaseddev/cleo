/**
 * Runnable helper for `cleo llm refresh-catalog`.
 *
 * Delegates to `fetchAndCacheCatalog` from `@cleocode/core` and returns a
 * structured result envelope so the CLI command can produce both human-
 * readable and JSON output without duplicating logic.
 *
 * Source: https://models.dev/api.json
 *
 * @module cleo/cli/commands/llm-refresh-catalog
 * @task T9314
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 5)
 */

import {
  buildContextIndex,
  fetchAndCacheCatalog,
  findLatestCacheFile,
  getCatalogDir,
  readCacheFile,
} from '@cleocode/core/llm/catalog-cache';

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * Successful refresh result.
 */
export interface RefreshCatalogSuccess {
  /** Number of providers in the refreshed catalog. */
  providers: number;
  /** Total number of models across all providers. */
  models: number;
  /** Absolute path of the written cache file. */
  filePath: string;
  /** Whether the data is fresh or fell back to a stale snapshot. */
  source: 'live' | 'stale-cache';
}

/**
 * Result envelope returned by {@link runLlmRefreshCatalog}.
 */
export type RefreshCatalogResult =
  | { success: true; data: RefreshCatalogSuccess }
  | { success: false; error: { message: string; code: string } };

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Fetch the live model catalog from models.dev, persist it to disk, and
 * return a structured result.
 *
 * On network failure the function falls back to the most-recent disk
 * snapshot (stale-cache). If there is no snapshot at all, the function
 * returns a failure envelope so the caller can surface a clear error.
 *
 * @param dir - Override for the cache directory (used in tests).
 * @returns Structured result with provider + model counts and file path.
 *
 * @task T9314
 */
export async function runLlmRefreshCatalog(dir?: string): Promise<RefreshCatalogResult> {
  const cacheDir = dir ?? getCatalogDir();

  // Attempt live fetch first.
  try {
    const { filePath, catalog } = await fetchAndCacheCatalog(cacheDir);
    const index = buildContextIndex(catalog);
    const providerCount = Object.keys(catalog).length;
    const modelCount = Object.keys(index).length;
    return {
      success: true,
      data: { providers: providerCount, models: modelCount, filePath, source: 'live' },
    };
  } catch {
    // Fall through to stale-cache.
  }

  // Stale-cache fallback: read the most-recent snapshot from disk.
  const latestPath = findLatestCacheFile(cacheDir);
  if (latestPath) {
    const catalog = readCacheFile(latestPath);
    if (catalog) {
      const index = buildContextIndex(catalog);
      return {
        success: true,
        data: {
          providers: Object.keys(catalog).length,
          models: Object.keys(index).length,
          filePath: latestPath,
          source: 'stale-cache',
        },
      };
    }
  }

  return {
    success: false,
    error: {
      message: 'Failed to fetch model catalog and no cached snapshot found.',
      code: 'E_CATALOG_UNAVAILABLE',
    },
  };
}
