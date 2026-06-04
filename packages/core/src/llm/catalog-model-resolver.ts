/**
 * Catalog-driven model resolution and validation (T11773 · E8).
 *
 * Provides two primitives that wire `cleo llm use` / `cleo llm profile` to
 * the live models.dev catalog instead of hardcoded literals:
 *
 *   - {@link resolveProviderDefaultModel} — derive the latest model for a
 *     provider by sorting the catalog entries by `release_date` descending.
 *     Falls back to `null` when the catalog has no entries for that provider.
 *
 *   - {@link validateModelForProvider} — assert that a model ID is present in
 *     the catalog for the given provider. Used by `llmUse` / `llmProfile` to
 *     reject typos / unknown model strings at configuration time rather than
 *     at inference time.
 *
 * Both functions read the disk-cached snapshot written by
 * `cleo llm refresh-catalog` — no network requests are issued at call time.
 * When no disk snapshot is available (fresh install, catalog never fetched)
 * the functions return `null` / `false` respectively so callers can surface
 * a user-friendly "run `cleo llm refresh-catalog` first" message.
 *
 * @module llm/catalog-model-resolver
 * @task T11773
 * @epic T11694 (E8-CATALOG-CURATION)
 */

import {
  findLatestCacheFile,
  getCatalogDir,
  type ModelsCatalogEntry,
  type ModelsCatalogFile,
  readCacheFile,
} from './catalog-cache.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** In-memory catalog cache for the process lifetime. */
let _catalog: ModelsCatalogFile | null | undefined;

/**
 * Load the full catalog from disk — no network fetch.
 *
 * Returns `null` when no snapshot is available so callers can surface a
 * "run `cleo llm refresh-catalog` first" hint rather than crashing.
 *
 * Results are cached for the process lifetime. Call
 * {@link _resetCatalogModelResolverCache} in tests to clear the cache.
 *
 * @internal
 */
function getDiskCatalog(): ModelsCatalogFile | null {
  if (_catalog !== undefined) return _catalog;
  const dir = getCatalogDir();
  const latest = findLatestCacheFile(dir);
  if (!latest) {
    _catalog = null;
    return null;
  }
  _catalog = readCacheFile(latest);
  return _catalog;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive the default model for a provider by finding the model with the
 * latest `release_date` in the catalog.
 *
 * Resolution is catalog-key aware: the caller passes the models.dev provider
 * key (e.g. `"openai"`, `"anthropic"`, `"google"`). Entries without a
 * `release_date` field are excluded from the comparison so unpublished or
 * internal-only entries do not shadow real released models.
 *
 * @param providerCatalogKey - The models.dev provider key (e.g. `"openai"`).
 * @param catalogOverride - Optional catalog for testing; defaults to the disk
 *   snapshot loaded by {@link getDiskCatalog}.
 * @returns The model ID with the latest `release_date`, or `null` when the
 *   catalog is unavailable or the provider has no dated entries.
 *
 * @task T11773
 */
export function resolveProviderDefaultModel(
  providerCatalogKey: string,
  catalogOverride?: ModelsCatalogFile,
): string | null {
  const catalog = catalogOverride ?? getDiskCatalog();
  if (!catalog) return null;

  const provider = catalog[providerCatalogKey];
  if (!provider?.models) return null;

  let latestId: string | null = null;
  let latestDate = '';

  for (const [id, entry] of Object.entries(provider.models) as [string, ModelsCatalogEntry][]) {
    const rd = entry.release_date;
    if (!rd) continue;
    if (rd > latestDate) {
      latestDate = rd;
      latestId = id;
    }
  }

  return latestId;
}

/**
 * Check whether a model ID is present in the catalog for a given provider.
 *
 * The check is provider-scoped: `gpt-4o` is valid for `openai` but would
 * fail for `anthropic`. This prevents cross-provider typos such as
 * `cleo llm profile extraction openai --model claude-opus-4-8`.
 *
 * When the catalog is unavailable (not yet fetched) the function returns
 * `{ valid: true, reason: 'catalog-unavailable' }` so the caller can pass
 * the model through with a soft warning rather than blocking the user.
 *
 * @param model - Model ID to validate (e.g. `"gpt-5.5"`).
 * @param providerCatalogKey - The models.dev provider key (e.g. `"openai"`).
 * @param catalogOverride - Optional catalog for testing.
 * @returns Validation result with `valid` boolean and diagnostic `reason`.
 *
 * @task T11773
 */
export function validateModelForProvider(
  model: string,
  providerCatalogKey: string,
  catalogOverride?: ModelsCatalogFile,
): {
  valid: boolean;
  reason: 'found' | 'not-found' | 'catalog-unavailable' | 'provider-not-in-catalog';
} {
  const catalog = catalogOverride ?? getDiskCatalog();
  if (!catalog) {
    return { valid: true, reason: 'catalog-unavailable' };
  }

  const provider = catalog[providerCatalogKey];
  if (!provider?.models) {
    return { valid: true, reason: 'provider-not-in-catalog' };
  }

  const found = Object.hasOwn(provider.models, model);
  return { valid: found, reason: found ? 'found' : 'not-found' };
}

/**
 * Return the models.dev catalog key for a given CLEO provider name.
 *
 * CLEO provider names (e.g. `"openai"`, `"anthropic"`) usually match their
 * models.dev catalog key directly. Where they diverge (Gemini is registered
 * as `"google"` in models.dev) this map provides the translation.
 *
 * Add new mappings here when a builtin provider's `name` field does not
 * match the models.dev key.
 *
 * @param providerName - CLEO-canonical provider name (e.g. `"gemini"`).
 * @returns The models.dev catalog key (e.g. `"google"`).
 *
 * @task T11773
 */
export function catalogKeyForProvider(providerName: string): string {
  const PROVIDER_KEY_MAP: Readonly<Record<string, string>> = {
    gemini: 'google',
    // CLEO name → models.dev key overrides only (identical mappings are omitted)
  };
  return PROVIDER_KEY_MAP[providerName.toLowerCase()] ?? providerName.toLowerCase();
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Reset the in-memory catalog cache.
 *
 * @internal — for use in unit tests only.
 */
export function _resetCatalogModelResolverCache(): void {
  _catalog = undefined;
}
