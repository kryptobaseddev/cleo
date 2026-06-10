/**
 * Zod mirror + TypeScript types for the curated models catalog (E8 · T11731).
 *
 * This is the type+validation SSoT for the **shipped, offline-first** provider+model
 * catalog seed that populates the global `models_catalog` table (T11733) and backs
 * offline/degraded catalog reads (T11737). It mirrors the JSON Schema in the sibling
 * `catalog-schema.json` (draft 2020-12) one-to-one.
 *
 * ## Offline-first — NO network is implied by these types
 *
 * The {@link CuratedCatalog} shape describes a committed, build-time snapshot of the
 * models.dev wire shape. Nothing here fetches; the network refresh op
 * (`cleo llm refresh-catalog`) is a SEPARATE leaf. The seeder reads the bundled
 * `curated-catalog.json` (validated against {@link curatedCatalogSchema}) and upserts
 * every row offline.
 *
 * ## models_catalog row parity (AC4)
 *
 * {@link modelsCatalogRowSelectSchema} / {@link modelsCatalogRowInsertSchema} describe the
 * FLATTENED per-row shape persisted in the `models_catalog` DB table — the json/cost/
 * modalities sub-objects serialize to TEXT columns, booleans to `integer({mode:'boolean'})`.
 * {@link flattenCatalogToRows} (in core) maps a {@link CuratedCatalog} → these rows.
 *
 * Contracts-purity (Gate 10): this module exports ONLY zod schemas (values) and
 * `z.infer` types — no bodied runtime helpers. The flatten/seed logic lives in core.
 *
 * @module llm/catalog-schema
 * @task T11731
 * @epic T11694 (E8-CATALOG-CURATION)
 */

import { z } from 'zod';

/** Legal `models_catalog.status` availability-lifecycle values. */
export const CATALOG_MODEL_STATUSES = [
  'stable',
  'beta',
  'preview',
  'deprecated',
  'retired',
] as const;

/** TypeScript union of {@link CATALOG_MODEL_STATUSES}. */
export type CatalogModelStatus = (typeof CATALOG_MODEL_STATUSES)[number];

/** Legal provider auth mechanisms carried in a catalog provider entry. */
export const CATALOG_AUTH_TYPES = ['api_key', 'oauth', 'bedrock', 'vertex'] as const;

/** TypeScript union of {@link CATALOG_AUTH_TYPES}. */
export type CatalogAuthType = (typeof CATALOG_AUTH_TYPES)[number];

/** ISO date `YYYY-MM-DD` matcher (the catalog sort/version key shape). */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

/** Semver `MAJOR.MINOR.PATCH` matcher for the catalog snapshot version. */
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'must be semver (MAJOR.MINOR.PATCH)');

/** Input/output modality lists for a model. */
export const catalogModalitiesSchema = z
  .object({
    input: z.array(z.string()),
    output: z.array(z.string()),
  })
  .strict();

/** Per-1M-token cost facets for a model (all optional — providers vary). */
export const catalogCostSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
    context_over_200k: z.number().optional(),
  })
  .strict();

/** Context/output token-window limits for a model. */
export const catalogLimitSchema = z
  .object({
    context: z.number(),
    output: z.number(),
  })
  .strict();

/** The provider-of-record (npm package + api protocol) for a model. */
export const catalogModelProviderSchema = z
  .object({
    npm: z.string(),
    api: z.string(),
  })
  .strict();

/** Full models.dev wire capability set for a single model entry. */
export const catalogModelEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    family: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    temperature: z.boolean(),
    interleaved: z.boolean(),
    tool_call: z.boolean(),
    modalities: catalogModalitiesSchema,
    cost: catalogCostSchema,
    limit: catalogLimitSchema,
    status: z.enum(CATALOG_MODEL_STATUSES),
    release_date: isoDate,
    provider: catalogModelProviderSchema,
  })
  .strict();

/** A provider record in the catalog envelope. */
export const catalogProviderSchema = z
  .object({
    id: z.string(),
    endpoint: z.string(),
    authTypes: z.array(z.enum(CATALOG_AUTH_TYPES)).min(1),
    npm: z.string().optional(),
  })
  .strict();

/**
 * Top-level shape of the curated catalog seed (`curated-catalog.json`).
 *
 * `providers` is keyed by provider id; `models` is keyed by provider id → model id →
 * {@link catalogModelEntrySchema}.
 */
export const curatedCatalogSchema = z
  .object({
    $schema: z.string().optional(),
    version: semver,
    lastUpdated: isoDate,
    providers: z.record(z.string(), catalogProviderSchema),
    models: z.record(z.string(), z.record(z.string(), catalogModelEntrySchema)),
  })
  .strict();

/** The validated curated catalog seed shape. */
export type CuratedCatalog = z.infer<typeof curatedCatalogSchema>;
/** A single model entry from the curated catalog. */
export type CatalogModelEntry = z.infer<typeof catalogModelEntrySchema>;
/** A single provider entry from the curated catalog. */
export type CatalogProvider = z.infer<typeof catalogProviderSchema>;

/**
 * INSERT/UPSERT shape for one `models_catalog` row (the flattened persistence form).
 *
 * The catalog's nested `modalities` / `cost` sub-objects are JSON-serialized into the
 * `modalities` / `cost` TEXT columns; booleans persist as `integer({mode:'boolean'})`.
 * `provider_id` is the catalog key; `models_dev_id` mirrors the entry `id`.
 */
export const modelsCatalogRowInsertSchema = z
  .object({
    id: z.string(),
    providerId: z.string(),
    name: z.string(),
    family: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    temperature: z.boolean(),
    interleaved: z.boolean(),
    toolCall: z.boolean(),
    modalities: z.string(),
    cost: z.string(),
    contextLimit: z.number().nullable().optional(),
    outputLimit: z.number().nullable().optional(),
    status: z.enum(CATALOG_MODEL_STATUSES),
    releaseDate: isoDate,
    modelsDevId: z.string(),
    source: z.string(),
    seededAt: z.string().optional(),
  })
  .strict();

/** SELECT shape for one `models_catalog` row (adds the always-present `seededAt`). */
export const modelsCatalogRowSelectSchema = modelsCatalogRowInsertSchema.extend({
  seededAt: z.string(),
});

/** INSERT/UPSERT row type for `models_catalog`. */
export type ModelsCatalogRowInsert = z.infer<typeof modelsCatalogRowInsertSchema>;
/** SELECT row type for `models_catalog`. */
export type ModelsCatalogRowSelect = z.infer<typeof modelsCatalogRowSelectSchema>;
