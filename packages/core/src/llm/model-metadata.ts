/**
 * Model metadata resolution — context window lengths and provenance.
 *
 * Resolution priority (mirrors Hermes `_resolve_context_length`):
 *   1. Live API probe (DEFERRED — see TODO below)
 *   2. Curated table exact match
 *   3. Curated table prefix-alias (strips date / version suffix)
 *   4. {@link DEFAULT_CONTEXT_LENGTH} fallback
 *
 * @task T9264
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /** Where this value came from. */
  source: 'curated' | 'curated-alias' | 'default';
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
 * @param model   - Model identifier (e.g. `"claude-sonnet-4-6-20251001"`).
 * @param baseUrl - Base URL of the provider API (reserved for Tier-1 live probe).
 * @param apiKey  - API key for the provider (reserved for Tier-1 live probe).
 * @returns Resolved metadata with provenance.
 */
export async function getModelMetadata(
  model: string,
  baseUrl?: string,
  apiKey?: string,
): Promise<ModelMetadata> {
  // TODO(T9264): Tier-1 — live API probe. When baseUrl + apiKey are provided,
  // fetch /models or equivalent endpoint and return { contextLength, source: 'live' }.
  // For now, fall through to curated/alias/default.
  void baseUrl;
  void apiKey;

  const curated = lookupCurated(model);
  if (curated !== null) {
    return {
      contextLength: curated.entry.contextLength,
      source: curated.strips === 0 ? 'curated' : 'curated-alias',
      livePending: true,
    };
  }

  // Tier 4: default fallback
  return {
    contextLength: DEFAULT_CONTEXT_LENGTH,
    source: 'default',
    livePending: true,
  };
}

/**
 * Resolve the context window length for a model.
 *
 * Resolution priority:
 *   1. Live API probe (DEFERRED — Tier 1 lands in a follow-up task)
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
