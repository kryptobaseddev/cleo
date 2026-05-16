/**
 * Model metadata resolution — context window lengths and provenance.
 *
 * Resolution priority (mirrors Hermes `_resolve_context_length`):
 *   1. Disk cache from `cleo llm refresh-catalog` (models.dev snapshot)
 *   2. Curated table exact match (bundled curated-models.json)
 *   3. Curated table prefix-alias (strips date / version suffix)
 *   4. {@link DEFAULT_CONTEXT_LENGTH} fallback
 *
 * Tier 1 is populated by {@link resolveContextIndex} from catalog-cache.ts,
 * which itself fetches https://models.dev/api.json (T9314) and falls back to
 * the most-recent disk snapshot when offline.
 *
 * @task T9264
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDiskCatalogIndex, type ModelContextIndex } from './catalog-cache.js';

/** Shape of a single entry in the curated model table. */
type CuratedModelEntry = { contextLength: number };

/** Shape of the entire curated-models.json file. */
type CuratedModelsFile = {
  $schema: string;
  version: number;
  models: Record<string, CuratedModelEntry>;
};

/** Lazily-loaded curated model table (read once on first call). */
let _curated: Record<string, CuratedModelEntry> | undefined;

/**
 * In-memory cache of the disk catalog index.
 *
 * Set to `null` on first call to signal "no disk snapshot available";
 * `undefined` means "not yet attempted".
 *
 * Populated from disk only — network refresh is handled explicitly by
 * `cleo llm refresh-catalog` via {@link resolveContextIndex}.
 */
let _catalogIndex: ModelContextIndex | null | undefined;

/**
 * Load the context index from the disk cache, caching the result for the
 * process lifetime. Returns `null` when no disk snapshot is available.
 *
 * Never performs a network request — safe to call on any hot path.
 *
 * @internal
 */
function getCatalogIndex(): {
  index: ModelContextIndex;
  source: 'disk-cache';
} | null {
  if (_catalogIndex !== undefined) {
    return _catalogIndex !== null ? { index: _catalogIndex, source: 'disk-cache' } : null;
  }
  const result = loadDiskCatalogIndex();
  if (result === null) {
    _catalogIndex = null;
    return null;
  }
  _catalogIndex = result.index;
  return { index: _catalogIndex, source: 'disk-cache' };
}

/**
 * Load the curated model table from the bundled JSON file.
 * Result is cached after the first call.
 */
function getCuratedTable(): Record<string, CuratedModelEntry> {
  if (_curated !== undefined) {
    return _curated;
  }
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const jsonPath = join(thisDir, 'curated-models.json');
  const raw = JSON.parse(readFileSync(jsonPath, 'utf-8')) as CuratedModelsFile;
  _curated = raw.models;
  return _curated;
}

/** Default context window used when no curated entry or API data is available. */
export const DEFAULT_CONTEXT_LENGTH = 256_000;

/** Suffix patterns stripped during alias resolution, applied in order. */
const ALIAS_STRIP_PATTERNS: RegExp[] = [
  /-\d{8}$/u, // e.g. -20251001
  /-latest$/u, // e.g. -latest
  /-\d+\.\d+$/u, // e.g. -1.5
];

/**
 * Resolved model metadata with provenance information.
 */
export interface ModelMetadata {
  /** Context window size in tokens. */
  contextLength: number;
  /**
   * Where this value came from.
   *
   * - `disk-catalog` — read from the local catalog snapshot written by
   *   `cleo llm refresh-catalog` (models.dev data, no network at read time)
   * - `curated` — bundled curated-models.json exact match
   * - `curated-alias` — bundled curated-models.json after stripping date/version suffix
   * - `default` — {@link DEFAULT_CONTEXT_LENGTH} fallback (model unknown)
   */
  source: 'disk-catalog' | 'curated' | 'curated-alias' | 'default';
  /** True iff a live-API probe would change this answer. */
  livePending?: boolean;
}

/**
 * Walk the alias-strip chain and return the matching curated entry plus how
 * many strips it took (0 = exact match, >0 = alias).
 *
 * Returns `null` if no match is found within {@link ALIAS_STRIP_PATTERNS.length}
 * iterations.
 */
function lookupCurated(model: string): { entry: CuratedModelEntry; strips: number } | null {
  const curated = getCuratedTable();

  // Tier 2: exact match
  const exact = curated[model];
  if (exact !== undefined) {
    return { entry: exact, strips: 0 };
  }

  // Tier 3: progressive suffix stripping (up to 3 iterations)
  let candidate = model;
  for (let i = 0; i < ALIAS_STRIP_PATTERNS.length; i++) {
    const stripped = candidate.replace(ALIAS_STRIP_PATTERNS[i]!, '');
    if (stripped === candidate) {
      // Pattern didn't match — try next without advancing candidate
      continue;
    }
    candidate = stripped;
    const aliasEntry = curated[candidate];
    if (aliasEntry !== undefined) {
      return { entry: aliasEntry, strips: i + 1 };
    }
  }

  return null;
}

/**
 * Same as {@link getModelContextLength} but returns full provenance.
 *
 * Prefer this for diagnostic output (e.g. `cleo llm whoami`).
 *
 * Resolution priority:
 *   1. Disk catalog cache (models.dev — populated by `cleo llm refresh-catalog`)
 *   2. Bundled curated table exact match
 *   3. Bundled curated table alias (strips date / version suffix)
 *   4. {@link DEFAULT_CONTEXT_LENGTH} fallback
 *
 * @param model   - Model identifier (e.g. `"claude-sonnet-4-6-20251001"`).
 * @param baseUrl - Reserved for future provider-specific probes.
 * @param apiKey  - Reserved for future provider-specific probes.
 * @returns Resolved metadata with provenance.
 *
 * @task T9314
 */
export async function getModelMetadata(
  model: string,
  baseUrl?: string,
  apiKey?: string,
): Promise<ModelMetadata> {
  void baseUrl;
  void apiKey;

  // Tier 1: disk catalog snapshot written by `cleo llm refresh-catalog`.
  // Disk-only read — no outbound network request at resolution time.
  const catalog = getCatalogIndex();
  if (catalog !== null) {
    const ctx = catalog.index[model];
    if (typeof ctx === 'number') {
      return { contextLength: ctx, source: 'disk-catalog' };
    }
  }

  // Tier 2 / 3: bundled curated table (exact + alias).
  const curated = lookupCurated(model);
  if (curated !== null) {
    return {
      contextLength: curated.entry.contextLength,
      source: curated.strips === 0 ? 'curated' : 'curated-alias',
    };
  }

  // Tier 4: default fallback.
  return {
    contextLength: DEFAULT_CONTEXT_LENGTH,
    source: 'default',
  };
}

/**
 * Resolve the context window length for a model.
 *
 * Resolution priority:
 *   1. Disk catalog snapshot (populated by `cleo llm refresh-catalog`, no network at read time)
 *   2. Curated table exact match
 *   3. Curated table prefix-alias (strip trailing date / version suffix)
 *   4. {@link DEFAULT_CONTEXT_LENGTH} fallback (256000)
 *
 * @param model   - Model identifier (e.g. `"claude-sonnet-4-6-20251001"`).
 * @param baseUrl - Base URL of the provider API (reserved for Tier-1 live probe).
 * @param apiKey  - API key for the provider (reserved for Tier-1 live probe).
 * @returns Context window size in tokens.
 */
export async function getModelContextLength(
  model: string,
  baseUrl?: string,
  apiKey?: string,
): Promise<number> {
  const metadata = await getModelMetadata(model, baseUrl, apiKey);
  return metadata.contextLength;
}

/**
 * Reset the in-memory catalog index cache.
 *
 * Exposed for testing only — allows test suites to inject a fresh
 * catalog between test cases without restarting the process.
 *
 * @internal
 */
export function _resetCatalogIndexCache(): void {
  _catalogIndex = undefined;
}

/**
 * Synchronous variant of {@link getModelContextLength}.
 *
 * Returns the curated context length when a table entry exists (exact or alias),
 * otherwise returns {@link DEFAULT_CONTEXT_LENGTH}. Does NOT perform a live API
 * probe — safe to call inside hot synchronous paths such as `ConcreteSession.send()`.
 *
 * @param model - Model identifier (e.g. `"claude-sonnet-4-6-20251001"`).
 * @returns Context window size in tokens.
 */
export function getModelContextLengthSync(model: string): number {
  const curated = lookupCurated(model);
  return curated !== null ? curated.entry.contextLength : DEFAULT_CONTEXT_LENGTH;
}
