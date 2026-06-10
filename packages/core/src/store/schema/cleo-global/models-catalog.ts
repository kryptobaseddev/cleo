/**
 * Global-scope `cleo.db` — **models.dev catalog SSoT** (`models_catalog`, 1 table).
 *
 * E8-CATALOG-CURATION (epic T11694 · task T11733). This table is the queryable,
 * `cleo health`-visible home for the **provider+model capability catalog** that
 * today lives only as a disk JSON cache (`llm-catalog/`) and a tiny bundled
 * `curated-models.json`. Each row is ONE model — its full models.dev wire
 * capability set (modalities, cost, limits, reasoning/tool-call flags, status,
 * release date) — so the catalog becomes the SSoT (DB table) with the disk cache
 * demoted to an offline/degraded fallback MIRROR (T11737).
 *
 * It is the catalog half of the "catalog-driven models, NO hardcoded" North Star
 * spine: the resolver default model derives from this table sorted by
 * `release_date` DESC (T11944), killing the hardcoded `claude-haiku-4-5` literal —
 * the static literal survives ONLY as the offline-only last-resort floor when this
 * table is empty/unseeded.
 *
 * ## NOT the `accounts` credential pool — do not confuse the two
 *
 * `accounts` (T11709) holds machine-wide LLM CREDENTIALS (the pool the runner picks
 * from). THIS table holds CATALOG DATA (model capabilities) — no secrets, no
 * encryption. They share the cleo-global scope and the E10 typing conventions, but
 * carry orthogonal data. The catalog is freely readable; credentials are sealed.
 *
 * ## E10 typing (mirrors sibling `accounts.ts` / `services.ts`)
 *
 * - Booleans (`attachment`/`reasoning`/`temperature`/`interleaved`/`tool_call`) use
 *   `integer({mode:'boolean'})` (CHECK `(0, 1)` in the migration).
 * - `modalities` / `cost` are JSON blobs serialized to TEXT (documented json pattern).
 * - `release_date` is TEXT `YYYY-MM-DD` with a GLOB date check; `seeded_at` is a TEXT
 *   ISO-8601 timestamp.
 * - `status` is a named enum ({@link CATALOG_MODEL_STATUSES}, minted in contracts).
 *
 * ## Active selection — `release_date`-sorted, latest wins
 *
 * The resolver default and any "newest model for provider X" query reads this table
 * ordered by `(provider_id, release_date DESC)` — the `idx_models_catalog_provider_release`
 * index backs that scan. No raw partial unique index is required (unlike `accounts`'
 * active-pointer); `id` is the natural PK and `(provider_id, models_dev_id)` is a
 * natural unique key for the upsert.
 *
 * @task T11733
 * @epic T11694
 * @see ../../../../migrations/drizzle-cleo-global — the forward migration
 * @see ../../../llm/catalog-seeder.ts — the seeder that populates this table (T11734)
 * @see ../../../llm/catalog-resolver.ts — the table-first read chokepoint (T11737)
 * @see ./accounts.ts — the sibling credential-pool table this directory mirrors
 */

import { CATALOG_MODEL_STATUSES } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * `models_catalog` — the machine-wide provider+model capability catalog table.
 *
 * One row per model. The catalog SSoT: seeded from the shipped offline
 * `curated-catalog.json` (T11734), read table-first via `resolveCatalogEntry()`
 * (T11737), and consulted by the resolver default (latest `release_date` wins —
 * T11944). `id` is the model id (PK); `(provider_id, models_dev_id)` is the natural
 * upsert key.
 *
 * @task T11733
 */
export const modelsCatalog = sqliteTable(
  'models_catalog',
  {
    /** Model id — the catalog key (e.g. `claude-haiku-4-5-20251001`). Natural PK. */
    id: text('id').primaryKey(),
    /** Provider key (models.dev id, e.g. `anthropic` | `openai` | `google`). */
    providerId: text('provider_id').notNull(),
    /** Human-readable display name (e.g. `Claude Haiku 4.5`). */
    name: text('name').notNull(),
    /** Model family (e.g. `claude` | `gpt` | `gemini`). */
    family: text('family').notNull(),
    /** Supports file/image attachments. */
    attachment: integer('attachment', { mode: 'boolean' }).notNull().default(false),
    /** Supports extended reasoning / thinking. */
    reasoning: integer('reasoning', { mode: 'boolean' }).notNull().default(false),
    /** Honours a temperature parameter. */
    temperature: integer('temperature', { mode: 'boolean' }).notNull().default(true),
    /** Supports interleaved thinking blocks. */
    interleaved: integer('interleaved', { mode: 'boolean' }).notNull().default(false),
    /** Supports tool / function calling. */
    toolCall: integer('tool_call', { mode: 'boolean' }).notNull().default(false),
    /** JSON blob: `{ input: string[]; output: string[] }` modalities (serialized TEXT). */
    modalities: text('modalities').notNull().default('{"input":["text"],"output":["text"]}'),
    /** JSON blob: per-1M-token cost facets `{ input?, output?, cache_read?, … }` (serialized TEXT). */
    cost: text('cost').notNull().default('{}'),
    /** Max context window (tokens); NULL when the catalog entry omits a limit. */
    contextLimit: integer('context_limit'),
    /** Max output tokens; NULL when the catalog entry omits a limit. */
    outputLimit: integer('output_limit'),
    /**
     * Availability lifecycle — `stable` | `beta` | `preview` | `deprecated` | `retired`
     * ({@link CATALOG_MODEL_STATUSES}, minted in contracts).
     */
    status: text('status', { enum: CATALOG_MODEL_STATUSES }).notNull().default('stable'),
    /**
     * ISO release date `YYYY-MM-DD` (GLOB-checked in the migration). The SSoT sort key —
     * the resolver default picks the row with the LATEST `release_date` for a provider.
     */
    releaseDate: text('release_date').notNull(),
    /** The models.dev entry id (mirrors `id`; kept distinct for the natural upsert key). */
    modelsDevId: text('models_dev_id').notNull(),
    /** Provenance — where this row came from (e.g. `seed` | `refresh` | `import`). */
    source: text('source').notNull().default('seed'),
    /** ISO-8601 UTC instant this row was seeded/last upserted. Defaults to write time. */
    seededAt: text('seeded_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    // The natural upsert key — a models.dev id is unique within a provider.
    unique('ux_models_catalog_provider_modeldev').on(table.providerId, table.modelsDevId),
    // The default-resolution scan — newest model per provider (release_date DESC).
    index('idx_models_catalog_provider_release').on(table.providerId, table.releaseDate),
    // Lifecycle scans (e.g. exclude retired) per provider.
    index('idx_models_catalog_provider_status').on(table.providerId, table.status),
  ],
);

/** Row type for `models_catalog` SELECT queries. */
export type ModelsCatalogRow = typeof modelsCatalog.$inferSelect;
/** Row type for `models_catalog` INSERT/UPSERT operations. */
export type NewModelsCatalogRow = typeof modelsCatalog.$inferInsert;
