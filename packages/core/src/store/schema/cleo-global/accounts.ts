/**
 * Global-scope `cleo.db` — **LLM credential pool** (`accounts`, 1 table).
 *
 * EP-PROVIDER-VAULT (epic T10410 · task T11709 · saga SG-VAULT-CORE T10409). This
 * table is the queryable, `cleo health`-visible home for the **pooled LLM provider
 * credentials** that today live as a plaintext JSON blob with no schema, no index,
 * and no health surface. Each row is one credential ("account") for one provider —
 * an API key or OAuth token pair — plus the rotation / cooldown / health metadata
 * the pool runner uses to pick the next live account and to retire dead ones.
 *
 * ## NOT `agent_registry_accounts` (do not confuse the two)
 *
 * The consolidated global `cleo.db` ALSO carries `agent_registry_accounts` — the
 * better-auth OAuth-account table from the agent-identity tier (the cloud-sync
 * `accounts` source, renamed under T11622). That table is a SaaS account record;
 * THIS table (`accounts`, bare) is the local machine-wide LLM-credential pool. The
 * two never overlap: the physical names differ (`accounts` vs
 * `agent_registry_accounts`) and the JS exports differ (`accounts` here vs
 * `agentRegistryAccounts`). The bare name `accounts` is the credential pool.
 *
 * ## Encrypted at rest (global KDF — T11710)
 *
 * `secretEnc` / `refreshEnc` are ciphertext, NEVER plaintext. They are produced by
 * `encryptGlobal()` (packages/core/src/crypto/credentials.ts, T11710) — the
 * project-INDEPENDENT KDF `HMAC-SHA256(machine-key || globalSalt, id)` reusing the
 * machine-local `getGlobalSalt()` (store/global-salt.ts). The ciphertext keeps the
 * versioned `0x01 + 12B IV + 16B authTag` framing. Global (not project-bound)
 * encryption is required because an LLM credential must decrypt consistently for
 * the same machine regardless of which project's cwd the pool is read from.
 *
 * ## Active-account pointer (`isActive`)
 *
 * `isActive` is the per-provider "currently-selected" pointer: AT MOST ONE row per
 * `provider` may carry `isActive = 1`. drizzle-orm cannot model a partial-`WHERE`
 * unique index, so the one-active-per-provider invariant is enforced by a raw-SQL
 * **partial unique index** `ux_accounts_active_provider ON accounts (provider)
 * WHERE is_active = 1` emitted in the forward migration (the established repo
 * pattern — cf. `_writer_leases.active`, T11627). This module declares only the
 * full-column table plus the non-partial `(provider, label)` unique index, which
 * drizzle CAN emit.
 *
 * @task T11709
 * @epic T10410
 * @saga T10409
 * @see ../../../crypto/credentials.ts — `encryptGlobal` / `decryptGlobal` (T11710)
 * @see ../../global-salt.ts — `getGlobalSalt` (the reused machine-local salt)
 * @see ./agent-registry.ts — `agentRegistryAccounts` (the UNRELATED OAuth-account table)
 * @see ../../../../migrations/drizzle-cleo-global — the forward migration (raw partial index)
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * Legal `accounts.status` values — the health lifecycle of a pooled credential.
 *
 * - `ok` — usable; the pool may select it.
 * - `exhausted` — rate-limited / quota-hit; usable again after `cooldownResetAt`.
 * - `dead` — permanently unusable (revoked key, hard auth failure); never selected.
 *
 * @task T11709
 */
export const ACCOUNT_STATUSES = ['ok', 'exhausted', 'dead'] as const;

/** TypeScript union derived from {@link ACCOUNT_STATUSES}. */
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * `accounts` — the machine-wide pooled-LLM-credential table.
 *
 * One row per credential ("account") for one provider. Carries the encrypted
 * secret/refresh material plus the rotation, cooldown, and health metadata the
 * pool runner consults to choose the next live account (highest `priority` among
 * `status = 'ok'`) and to retire dead ones. The `(provider, label)` pair is unique;
 * `isActive` is the per-provider active pointer (one active row per provider,
 * enforced by the raw-SQL partial unique index in the migration).
 *
 * @task T11709
 */
export const accounts = sqliteTable(
  'accounts',
  {
    /** Surrogate primary key (autoincrement via INTEGER PRIMARY KEY rowid alias). */
    id: integer('id').primaryKey(),
    /** Provider key (e.g. `anthropic` | `openai` | `google`). Selection is per-provider. */
    provider: text('provider').notNull(),
    /**
     * Human-readable credential label, unique WITHIN a provider (e.g. `work-key`,
     * `personal-oauth`). The `(provider, label)` pair is the natural unique key.
     */
    label: text('label').notNull(),
    /** Credential kind — `api-key` | `oauth` (drives which `*_enc` columns are populated). */
    authType: text('auth_type').notNull(),
    /**
     * Encrypted primary secret (API key or OAuth access token), `encryptGlobal()`
     * ciphertext (`0x01 + 12B IV + 16B authTag` framing, T11710). NEVER plaintext.
     */
    secretEnc: text('secret_enc'),
    /**
     * Encrypted OAuth refresh token, `encryptGlobal()` ciphertext. NULL for an
     * `api-key` credential (no refresh material).
     */
    refreshEnc: text('refresh_enc'),
    /** ISO-8601 UTC expiry of the secret; NULL for a non-expiring API key. */
    expiresAt: text('expires_at'),
    /** Selection priority — HIGHER is preferred. The pool picks the highest live priority. */
    priority: integer('priority').notNull().default(0),
    /** Provenance — where this credential came from (e.g. `env` | `oauth-flow` | `import`). */
    source: text('source'),
    /**
     * Health lifecycle — `ok` | `exhausted` | `dead` ({@link ACCOUNT_STATUSES}).
     * Only `ok` rows are eligible for selection.
     */
    status: text('status', { enum: ACCOUNT_STATUSES }).notNull().default('ok'),
    /** Last transport/provider error code observed (e.g. `429` | `invalid_api_key`); NULL when healthy. */
    lastErrorCode: text('last_error_code'),
    /**
     * ISO-8601 UTC instant an `exhausted` credential becomes eligible again; NULL
     * when not cooling down. The pool skips an `exhausted` row until `now >= this`.
     */
    cooldownResetAt: text('cooldown_reset_at'),
    /** Monotonic count of requests served by this credential (rotation telemetry). */
    requestCount: integer('request_count').notNull().default(0),
    /** Free-form JSON blob for forward-compatible per-credential metadata (serialized TEXT). */
    metadata: text('metadata').notNull().default('{}'),
    /**
     * Per-provider active-pointer. AT MOST ONE row per `provider` carries `true`,
     * enforced by the raw-SQL partial unique index `ux_accounts_active_provider`
     * (drizzle cannot model a partial-`WHERE` unique). Defaults to `false`.
     */
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
    /** ISO-8601 UTC row-creation instant. Defaults to write time. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant. Defaults to write time; bumped on mutation. */
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    // The natural unique key: a label is unique within a provider. drizzle CAN
    // emit this (non-partial) unique; the per-provider active pointer is the
    // SEPARATE partial unique index emitted as raw SQL in the migration.
    unique('ux_accounts_provider_label').on(table.provider, table.label),
    // Selection index — the pool scans live rows per provider ordered by priority.
    index('idx_accounts_provider_status_priority').on(table.provider, table.status, table.priority),
  ],
);

/** Row type for `accounts` SELECT queries. */
export type AccountRow = typeof accounts.$inferSelect;
/** Row type for `accounts` INSERT/UPSERT operations. */
export type NewAccountRow = typeof accounts.$inferInsert;
