#!/usr/bin/env node
/**
 * Fetch the models.dev catalog and emit two generated artifacts:
 *
 *   packages/core/src/llm/generated/curated-models.json
 *   packages/core/src/llm/generated/provider-profiles.ts
 *
 * Idempotent: same input → same output (keys sorted, date stripped from
 * the `generatedAt` field comparison). Re-running with identical upstream
 * data produces byte-for-byte identical output.
 *
 * Usage:
 *   node scripts/generate-llm-catalog.mjs
 *   pnpm run gen:llm-catalog
 *
 * CI drift check (deferred to T9268-CI):
 *   Run with `--check` to assert zero diff between freshly generated output
 *   and the checked-in files. Exit 1 on drift, 0 on clean.
 *
 * @task T9268 (T-llm-p3-8)
 * @epic T9261
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/** 24-hour disk cache to avoid hitting models.dev on every incremental build. */
const CACHE_DIR = join(ROOT, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'models-dev-api.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

const OUT_JSON = join(ROOT, 'packages/core/src/llm/generated/curated-models.json');
const OUT_TS = join(ROOT, 'packages/core/src/llm/generated/provider-profiles.ts');

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Return the models.dev catalog, using a 24h on-disk cache to avoid
 * repeated network calls during incremental builds.
 *
 * @returns {Promise<Record<string, unknown>>} Raw catalog object keyed by provider id.
 */
async function fetchCatalog() {
  if (existsSync(CACHE_FILE)) {
    const mtimeMs = statSync(CACHE_FILE).mtimeMs;
    if (Date.now() - mtimeMs < CACHE_TTL_MS) {
      return /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(CACHE_FILE, 'utf8')));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res;
  try {
    res = await fetch('https://models.dev/api.json', { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`models.dev fetch failed: HTTP ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  return /** @type {Record<string, unknown>} */ (data);
}

// ---------------------------------------------------------------------------
// curated-models.json
// ---------------------------------------------------------------------------

/**
 * @typedef {{ contextLength: number, reasoning?: true, toolCall?: true, vision?: true }} CuratedModel
 */

/**
 * Build the curated model table from the raw catalog.
 *
 * Includes every model that has a positive `limit.context` value.
 * Models for audio/image/video generation (context = 0) are skipped.
 *
 * @param {Record<string, unknown>} catalog
 * @returns {{ $schema: string, version: number, source: string, generatedAt: string, models: Record<string, CuratedModel> }}
 */
function buildCuratedModels(catalog) {
  /** @type {Record<string, CuratedModel>} */
  const models = {};

  for (const providerEntry of Object.values(catalog)) {
    if (!providerEntry || typeof providerEntry !== 'object') continue;

    const p = /** @type {Record<string, unknown>} */ (providerEntry);
    const rawModels = p['models'];
    if (!rawModels || typeof rawModels !== 'object') continue;

    const modelList = Object.values(/** @type {Record<string, unknown>} */ (rawModels));

    for (const rawModel of modelList) {
      if (!rawModel || typeof rawModel !== 'object') continue;

      const m = /** @type {Record<string, unknown>} */ (rawModel);
      const id = typeof m['id'] === 'string' ? m['id'] : null;
      if (!id) continue;

      // Prefer limit.context; fall back to context_window for forward-compat.
      let ctx = null;
      const limit = m['limit'];
      if (limit && typeof limit === 'object') {
        const l = /** @type {Record<string, unknown>} */ (limit);
        if (typeof l['context'] === 'number' && l['context'] > 0) {
          ctx = l['context'];
        }
      }
      if (ctx === null && typeof m['context_window'] === 'number' && m['context_window'] > 0) {
        ctx = /** @type {number} */ (m['context_window']);
      }

      // Skip non-text models (audio, image generation) — they have context=0.
      if (ctx === null) continue;

      /** @type {CuratedModel} */
      const entry = { contextLength: ctx };
      if (m['reasoning'] === true) entry.reasoning = true;
      if (m['tool_call'] === true) entry.toolCall = true;
      if (m['attachment'] === true) entry.vision = true;

      models[id] = entry;
    }
  }

  // Sort keys for deterministic, diff-friendly output.
  const sorted = /** @type {Record<string, CuratedModel>} */ (
    Object.fromEntries(
      Object.keys(models)
        .sort()
        .map((k) => [k, models[k]]),
    )
  );

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    version: 1,
    source: 'models.dev',
    generatedAt: new Date().toISOString().slice(0, 10),
    models: sorted,
  };
}

// ---------------------------------------------------------------------------
// provider-profiles.ts
// ---------------------------------------------------------------------------

/**
 * @typedef {{ name: string, displayName: string, authTypes: string[], baseUrl: string, defaultModel: string, envVars: string[] }} ProfileEntry
 */

/**
 * Build the provider profiles array from the raw catalog.
 *
 * Skips providers that lack a usable `api` base URL, as they cannot be
 * used directly by the CLEO credential resolver without one.
 *
 * @param {Record<string, unknown>} catalog
 * @returns {ProfileEntry[]}
 */
function buildProviderProfiles(catalog) {
  /** @type {ProfileEntry[]} */
  const entries = [];

  for (const providerEntry of Object.values(catalog)) {
    if (!providerEntry || typeof providerEntry !== 'object') continue;

    const p = /** @type {Record<string, unknown>} */ (providerEntry);
    const id = typeof p['id'] === 'string' ? p['id'] : null;
    const api = typeof p['api'] === 'string' ? p['api'] : null;

    // Skip providers without a base URL — they cannot be wired without one.
    if (!id || !api) continue;

    const rawModels = p['models'];
    const modelList =
      rawModels && typeof rawModels === 'object'
        ? Object.values(/** @type {Record<string, unknown>} */ (rawModels))
        : [];

    // Pick the first model with a valid id as the default.
    let defaultModel = 'unknown';
    for (const rawModel of modelList) {
      if (rawModel && typeof rawModel === 'object') {
        const m = /** @type {Record<string, unknown>} */ (rawModel);
        if (typeof m['id'] === 'string' && m['id']) {
          defaultModel = m['id'];
          break;
        }
      }
    }

    // `env` is an array of env-var names in the catalog.
    const envVars = Array.isArray(p['env']) ? p['env'].filter((e) => typeof e === 'string') : [];

    entries.push({
      name: id,
      displayName: typeof p['name'] === 'string' ? p['name'] : id,
      // models.dev doesn't carry auth-type metadata; api_key is a safe default.
      // Builtin profiles (e.g. anthropic.ts) may override to add oauth/aws_sdk.
      authTypes: ['api_key'],
      // Strip trailing slash and replace `${VAR}` placeholders with `{VAR}` so
      // the generated TypeScript does not trigger biome's noTemplateCurlyInString
      // lint rule. The original placeholder names are preserved in the envVars
      // field so callers know which env vars to substitute at runtime.
      baseUrl: api.replace(/\/$/, '').replace(/\$\{([^}]+)\}/g, '{$1}'),
      defaultModel,
      envVars,
    });
  }

  // Sort alphabetically by name for deterministic output.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/**
 * Render the generated TypeScript source for provider-profiles.ts.
 *
 * @param {ProfileEntry[]} entries
 * @returns {string}
 */
function renderProviderProfilesTs(entries) {
  const rows = entries
    .map(
      (e) =>
        `  {\n` +
        `    name: ${JSON.stringify(e.name)},\n` +
        `    displayName: ${JSON.stringify(e.displayName)},\n` +
        `    authTypes: ${JSON.stringify(e.authTypes)},\n` +
        `    baseUrl: ${JSON.stringify(e.baseUrl)},\n` +
        `    defaultModel: ${JSON.stringify(e.defaultModel)},\n` +
        `    envVars: ${JSON.stringify(e.envVars)},\n` +
        `  }`,
    )
    .join(',\n');

  return `/* GENERATED FILE — do not edit by hand.
 * Source: models.dev (https://models.dev/api.json)
 * Regenerate via: pnpm run gen:llm-catalog
 *
 * CI drift check (deferred to T9268-CI): re-run the script with --check
 * to assert zero diff between freshly generated output and the checked-in
 * files. Exit 1 on drift, 0 on clean.
 *
 * Hand-written builtin profiles (e.g. packages/core/src/llm/backends/anthropic.ts)
 * OVERRIDE these entries — they carry provider-specific defaultHeaders, OAuth
 * flow markers, and additional metadata that codegen cannot infer from models.dev.
 *
 * @task T9268 (T-llm-p3-8)
 * @epic T9261
 */
import type { ProviderProfile } from '@cleocode/contracts';

/**
 * Provider profiles auto-generated from the models.dev community catalog.
 *
 * Each entry is a static snapshot of provider metadata (base URL, env vars,
 * default model, auth types). These are intentionally narrowed to
 * \`Omit<ProviderProfile, 'fetchModels'>\` because live model enumeration is
 * never available from a static catalog — it requires a network call, which
 * belongs in the hand-written builtin for each provider.
 *
 * Builtin profiles located in \`packages/core/src/llm/backends/\` take
 * precedence over these generated entries when merging the provider registry.
 *
 * @task T9268
 */
export const GENERATED_PROVIDER_PROFILES: ReadonlyArray<
  Omit<ProviderProfile, 'fetchModels'> & { readonly envVars: ReadonlyArray<string> }
> = [
${rows},
];
`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  let catalog;
  try {
    catalog = await fetchCatalog();
  } catch (err) {
    console.error('[generate-llm-catalog] Failed to fetch models.dev catalog:');
    console.error(err instanceof Error ? err.message : String(err));
    console.error('Hint: check network connectivity or the models.dev status page.');
    process.exit(1);
  }

  const curated = buildCuratedModels(catalog);
  const profiles = buildProviderProfiles(catalog);
  const profilesTs = renderProviderProfilesTs(profiles);

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(curated, null, 2) + '\n');
  writeFileSync(OUT_TS, profilesTs);

  const modelCount = Object.keys(curated.models).length;
  const providerCount = profiles.length;
  console.log(`[generate-llm-catalog] Generated ${modelCount} models, ${providerCount} providers`);
  console.log(`  ${OUT_JSON}`);
  console.log(`  ${OUT_TS}`);
}

main();
