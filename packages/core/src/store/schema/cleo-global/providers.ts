/**
 * Global-scope `cleo.db` — **declarative provider SSoT** (`providers`, 1 table).
 *
 * M3 Provider SSoT (epic T11667 · task T11703). This table is the queryable,
 * `cleo health`-visible home for the **declarative provider definitions** that today
 * live only as hand-written {@link ProviderProfile} modules in the in-process registry.
 * Each row is ONE provider's serializable {@link ProviderDef} (T11702) — identity,
 * aliases, auth methods, wire endpoint(s), models.dev catalog key, default headers,
 * optional OAuth flow, declarative request quirks — so the provider set becomes the
 * SSoT (DB table) the resolver, the CLI, and the alias resolver (T11704) read.
 *
 * The non-serializable RUNTIME hooks (`buildExtraBody` / `prepareMessages` / …) stay
 * on {@link ProviderProfile}; a `providers` row carries only DATA, with the quirk
 * closures reduced to declarative `request_quirks` descriptors.
 *
 * ## NOT the `accounts` credential pool / `models_catalog` — do not confuse them
 *
 * `accounts` (T11709) holds machine-wide LLM CREDENTIALS (the pool the runner picks
 * from); `models_catalog` (T11733) holds per-MODEL capability DATA. THIS table holds
 * per-PROVIDER declarative config (endpoints, aliases, auth methods). All three share
 * the cleo-global scope + E10 typing conventions but carry orthogonal data. The
 * provider set is freely readable (no secrets, no encryption — the OAuth `client_id`
 * is public; client SECRETS live in the `service_*` vault, T11937).
 *
 * ## E10 typing (mirrors sibling `accounts.ts` / `services.ts` / `models-catalog.ts`)
 *
 * - JSON-as-TEXT for the array/object fields (`aliases`, `auth_methods`, `endpoint`,
 *   `alt_endpoints`, `default_headers`, `env_vars`, `oauth`, `request_quirks`) — each
 *   serialized to its TEXT column (the documented json pattern).
 * - `seeded_at` is a TEXT ISO-8601 timestamp (GLOB-checked in the migration).
 * - No booleans/enums (the declarative shape is all id/JSON), so the only CHECKs the
 *   schema-parity gate (T11364) re-derives are the timestamp GLOB + the JSON columns'
 *   NOT NULL defaults.
 *
 * ## Active selection — natural PK `id`, no partial index
 *
 * `id` is the provider id (PK); a provider is looked up by `id` or resolved from an
 * alias (T11704 reads the `aliases` JSON). No raw partial unique index is required
 * (unlike `accounts`' active-pointer) — there is exactly one row per provider id.
 *
 * @task T11703
 * @epic T11667
 * @see ../../../../migrations/drizzle-cleo-global — the forward migration
 * @see ../../../llm/provider-registry/provider-seed.ts — the seeder that populates this table (T11703)
 * @see ../../../llm/provider-registry/provider-defs.ts — the builtin ProviderDef set (seed source)
 * @see ./accounts.ts — the sibling credential-pool table this directory mirrors
 * @see ./models-catalog.ts — the sibling catalog table this directory mirrors
 */

import { sql } from 'drizzle-orm';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * `providers` — the machine-wide declarative provider-definition table.
 *
 * One row per provider. The provider SSoT: seeded from the builtin
 * {@link ProviderDef} set (T11703 · derived from the in-process
 * {@link ProviderProfile} builtins), read by the resolver/CLI/alias resolver
 * (T11704). `id` is the provider id (PK); JSON columns hold the serialized
 * declarative fields. The seeder upserts on `id` (idempotent — re-open is a no-op).
 *
 * @task T11703
 */
export const providers = sqliteTable(
  'providers',
  {
    /** Provider id — the canonical lower-cased key (e.g. `anthropic`). Natural PK. */
    id: text('id').primaryKey(),
    /** Human-readable display name (e.g. `Anthropic Claude`). */
    displayName: text('display_name').notNull(),
    /** JSON array of case-insensitive aliases (the alias-resolver source). Serialized TEXT; defaults `[]`. */
    aliases: text('aliases').notNull().default('[]'),
    /** JSON array of `StoredAuthTypeWire` auth methods (`api_key`|`oauth`|`aws_sdk`). Serialized TEXT; defaults `[]`. */
    authMethods: text('auth_methods').notNull().default('[]'),
    /** JSON object — the primary `ProviderEndpoint` tagged union (discriminant `transport`). Serialized TEXT. */
    endpoint: text('endpoint').notNull(),
    /** JSON array of additional `ProviderEndpoint` variants (multi-protocol providers). Serialized TEXT; defaults `[]`. */
    altEndpoints: text('alt_endpoints').notNull().default('[]'),
    /** The models.dev catalog provider key (joins `models_catalog.provider_id`). */
    modelsDevId: text('models_dev_id').notNull(),
    /** JSON object of pinned default HTTP headers. Serialized TEXT; defaults `{}`. */
    defaultHeaders: text('default_headers').notNull().default('{}'),
    /** JSON array of credential env-var names. Serialized TEXT; defaults `[]`. */
    envVars: text('env_vars').notNull().default('[]'),
    /** JSON object — the optional `OAuthFlowDef` placeholder; NULL when the provider has no OAuth flow. */
    oauth: text('oauth'),
    /** JSON array of declarative `RequestQuirk` descriptors. Serialized TEXT; defaults `[]`. */
    requestQuirks: text('request_quirks').notNull().default('[]'),
    /** Provenance — where this row came from (e.g. `seed` | `plugin` | `import`). */
    source: text('source').notNull().default('seed'),
    /** ISO-8601 UTC instant this row was seeded/last upserted. Defaults to write time. */
    seededAt: text('seeded_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    // Lookup index — resolve providers by their models.dev catalog key (join to
    // models_catalog). `id` is already the PK, so no extra unique is needed.
    index('idx_providers_models_dev').on(table.modelsDevId),
  ],
);

/** Row type for `providers` SELECT queries. */
export type ProviderRow = typeof providers.$inferSelect;
/** Row type for `providers` INSERT/UPSERT operations. */
export type NewProviderRow = typeof providers.$inferInsert;
