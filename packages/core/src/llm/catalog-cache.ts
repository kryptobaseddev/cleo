/**
 * Live model catalog cache — fetches and persists models.dev/api.json.
 *
 * Resolution priority:
 *   1. Disk cache (versioned under `<CLEO_DATA_DIR>/llm-catalog/`)
 *   2. Bundled snapshot (curated-models.json in this package)
 *
 * The cache is keyed by a Unix-timestamp prefix: `<ts>-models.json`. A
 * stable `latest.json` symlink points to the most recent entry for quick
 * access without scanning the directory.
 *
 * Stale-fallback behaviour (network failures):
 *   - If the network fetch fails, the most-recently-written `*.json` in
 *     the cache directory is returned instead.
 *   - If the cache directory is empty or absent, the bundled snapshot is
 *     returned so callers always get *some* data.
 *
 * Source: https://models.dev/api.json
 *
 * @module llm/catalog-cache
 * @task T9314
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 5)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Live catalog endpoint. */
export const MODELS_DEV_URL = 'https://models.dev/api.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single model entry as returned by models.dev/api.json.
 *
 * Only the fields we actually consume are typed here; the rest are captured
 * in the `extra` pass-through so the raw file round-trips faithfully.
 */
export interface ModelsCatalogEntry {
  /** Model identifier. */
  id: string;
  /** Human-readable display name. */
  name?: string;
  /** ISO 8601 date when the model was released (e.g. `"2025-08-07"`). Used to
   * derive a provider's latest model when no explicit default is pinned. */
  release_date?: string;
  /** Context + output window limits. */
  limit?: { context?: number; output?: number };
}

/**
 * Provider record within the models.dev response envelope.
 */
export interface ModelsCatalogProvider {
  /** Provider identifier. */
  id: string;
  /** Models offered by this provider, keyed by model ID. */
  models: Record<string, ModelsCatalogEntry>;
}

/**
 * Top-level shape of models.dev/api.json.
 *
 * The file is a flat object whose keys are provider IDs and whose values
 * are {@link ModelsCatalogProvider} records.
 */
export type ModelsCatalogFile = Record<string, ModelsCatalogProvider>;

/**
 * Flattened model index derived from the catalog.
 *
 * Maps model ID → context length (token count). Models that do not
 * advertise a context length are omitted from the index so callers can
 * distinguish "known with context" from "missing from catalog".
 */
export type ModelContextIndex = Record<string, number>;

// ---------------------------------------------------------------------------
// Cache path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the directory where catalog snapshots are stored.
 *
 * Respects `CLEO_DATA_DIR` env override (same convention used by the
 * credentials layer), then falls back to
 * `$XDG_DATA_HOME/cleo` → `~/.local/share/cleo`.
 */
export function getCatalogDir(): string {
  if (process.env['CLEO_DATA_DIR']) {
    return join(process.env['CLEO_DATA_DIR'], 'llm-catalog');
  }
  const xdg = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  return join(xdg, 'cleo', 'llm-catalog');
}

/**
 * Ensure the catalog directory exists (creates it if absent, no-op otherwise).
 */
function ensureCatalogDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Disk I/O
// ---------------------------------------------------------------------------

/**
 * Return the path to the most-recently-written `*-models.json` in `dir`.
 *
 * Entries are sorted by `mtime` descending so the first item is the
 * freshest. Returns `null` when the directory is empty or does not exist.
 */
export function findLatestCacheFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('-models.json'))
    .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? join(dir, files[0]!.name) : null;
}

/**
 * Write `data` to `<dir>/<timestamp>-models.json` and update the
 * `latest.json` symlink to point at the new file.
 *
 * @returns Absolute path of the written file.
 */
export function writeCacheFile(dir: string, data: ModelsCatalogFile): string {
  ensureCatalogDir(dir);
  const ts = Date.now();
  const filename = `${ts}-models.json`;
  const filePath = join(dir, filename);
  writeFileSync(filePath, JSON.stringify(data), 'utf-8');

  // Atomically rotate the `latest.json` symlink.
  const symlinkPath = join(dir, 'latest.json');
  try {
    if (existsSync(symlinkPath)) unlinkSync(symlinkPath);
    symlinkSync(filename, symlinkPath);
  } catch {
    // Symlink failure is non-fatal — the versioned file was written successfully.
  }

  return filePath;
}

/**
 * Read a `ModelsCatalogFile` from `filePath`.
 *
 * Returns `null` on any parse or I/O error so callers can fall through to
 * the next tier without crashing.
 */
export function readCacheFile(filePath: string): ModelsCatalogFile | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as ModelsCatalogFile;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Catalog → flat index
// ---------------------------------------------------------------------------

/**
 * Flatten a {@link ModelsCatalogFile} into a {@link ModelContextIndex}.
 *
 * Iterates every provider → model pair and extracts `limit.context` when
 * present. The last writer wins for duplicate IDs across providers.
 */
export function buildContextIndex(catalog: ModelsCatalogFile): ModelContextIndex {
  const index: ModelContextIndex = {};
  for (const provider of Object.values(catalog)) {
    if (!provider?.models) continue;
    for (const [modelId, entry] of Object.entries(provider.models)) {
      const ctx = entry?.limit?.context;
      if (typeof ctx === 'number' && ctx > 0) {
        index[modelId] = ctx;
      }
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Network fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the live catalog from models.dev and persist it to disk.
 *
 * On network or parse failure the error is surfaced as a thrown
 * {@link CatalogRefreshError} so callers can handle it explicitly (e.g.
 * fall back to a stale cache entry).
 *
 * @param dir - Directory to write the cache file into (defaults to
 *              {@link getCatalogDir}).
 * @returns The written file path and the parsed catalog.
 */
export async function fetchAndCacheCatalog(dir?: string): Promise<{
  filePath: string;
  catalog: ModelsCatalogFile;
}> {
  const cacheDir = dir ?? getCatalogDir();
  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) {
    throw new CatalogRefreshError(
      `HTTP ${response.status} fetching ${MODELS_DEV_URL}`,
      'E_CATALOG_HTTP',
    );
  }
  let catalog: ModelsCatalogFile;
  try {
    catalog = (await response.json()) as ModelsCatalogFile;
  } catch (err) {
    throw new CatalogRefreshError(
      `JSON parse error from ${MODELS_DEV_URL}: ${err instanceof Error ? err.message : String(err)}`,
      'E_CATALOG_PARSE',
    );
  }
  const filePath = writeCacheFile(cacheDir, catalog);
  return { filePath, catalog };
}

/**
 * Structured error thrown by {@link fetchAndCacheCatalog} when the network
 * request or JSON parse fails.
 */
export class CatalogRefreshError extends Error {
  /** Machine-readable error code. */
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'CatalogRefreshError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Context-index resolution with full fallback chain
// ---------------------------------------------------------------------------

/**
 * Load the context index from the disk cache only — no network fetch.
 *
 * Used by the runtime model-metadata resolver so that reading context lengths
 * never triggers an outbound HTTP request. Populate the cache first with
 * {@link resolveContextIndex} (called by `cleo llm refresh-catalog`).
 *
 * Returns `null` when no disk snapshot exists yet.
 *
 * @param dir - Cache directory override (used in tests).
 */
export function loadDiskCatalogIndex(dir?: string): {
  index: ModelContextIndex;
  source: 'disk-cache';
} | null {
  const cacheDir = dir ?? getCatalogDir();
  const latest = findLatestCacheFile(cacheDir);
  if (!latest) return null;
  const catalog = readCacheFile(latest);
  if (!catalog) return null;
  return { index: buildContextIndex(catalog), source: 'disk-cache' };
}

/**
 * Resolve a live (or stale-cached) {@link ModelContextIndex}.
 *
 * Resolution order:
 *   1. Try fetching from models.dev (always attempted at call time).
 *   2. On network failure, fall back to the most-recent disk cache entry.
 *   3. If the cache is empty, return `null` so the caller can use the
 *      bundled curated-models.json snapshot.
 *
 * This function performs a network request. Use {@link loadDiskCatalogIndex}
 * when you only need to read the locally-cached snapshot.
 *
 * @param dir - Cache directory override (used in tests).
 */
export async function resolveContextIndex(dir?: string): Promise<{
  index: ModelContextIndex;
  source: 'live' | 'stale-cache';
} | null> {
  const cacheDir = dir ?? getCatalogDir();
  try {
    const { catalog } = await fetchAndCacheCatalog(cacheDir);
    return { index: buildContextIndex(catalog), source: 'live' };
  } catch {
    // Network or parse failure — fall through to stale cache.
  }

  const latest = findLatestCacheFile(cacheDir);
  if (latest) {
    const catalog = readCacheFile(latest);
    if (catalog) {
      return { index: buildContextIndex(catalog), source: 'stale-cache' };
    }
  }

  return null;
}
