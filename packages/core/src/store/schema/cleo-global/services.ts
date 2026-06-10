/**
 * Global-scope `cleo.db` — **universal service-credential vault** (3 tables).
 *
 * EP-UNIVERSAL-SERVICE-VAULT (epic T11765 · saga SG-VAULT-CORE T10409 · M2 W1a ·
 * task T11937). The **service** half of the universal vault — machine-wide OAuth /
 * API credentials for third-party SERVICES (github, google, notion, figma, …) —
 * cannibalized from onecli's `app_connections` / `app_configs` /
 * `agent_app_connections`, DROPPING every org / project / billing column (the
 * vault is machine-wide, exactly like the `accounts` LLM-credential pool — T11709,
 * the established precedent this directory mirrors). Three tables:
 *
 *  - `service_connections` — one user-connected credential per `(provider, label)`:
 *    the encrypted token blob + non-secret metadata (scopes, expiry, username).
 *  - `service_configs` — per-provider BYOC (bring-your-own-client) OAuth app:
 *    enabled flag + encrypted client secret + non-secret settings (client id,
 *    scopes). One row per provider.
 *  - `agent_service_grants` — per-agent access to a connection, plus the
 *    `session_policy` (block / rate-limit / manual-approval) the trust gate
 *    evaluates BEFORE any decrypt (T11937 AC4 — policy-before-decrypt).
 *
 * ## NOT the LLM credential pool (`accounts`) — do not confuse the two
 *
 * `accounts` (T11709) holds MODEL-API credentials (the pool the LLM runner picks
 * from). These `service_*` tables hold SERVICE-API credentials (the things an
 * agent's tools call: github, gmail, …). Different physical names, different
 * consumers, different egress path. The crypto, ISO-timestamp typing, and
 * accessor patterns are shared by design.
 *
 * ## Encrypted at rest (global KDF — reuse, no new crypto · T11710)
 *
 * `credentials_enc` (the `{access_token, refresh_token}` JSON blob) and
 * `client_secret_enc` (the BYOC client secret) are `encryptGlobal()` ciphertext
 * (packages/core/src/crypto/credentials.ts), NEVER plaintext. They keep the
 * versioned `0x01 + 12B IV + 16B authTag` framing and decrypt via the project-
 * INDEPENDENT KDF `HMAC-SHA256(machine-key || globalSalt, id)` with
 * `id = service:${provider}:${label}` — so a service credential decrypts
 * consistently for the machine regardless of the reading project's cwd.
 *
 * ## E10 typing (per docs/migration/sqlite-schema-canonical.md)
 *
 * TEXT ISO-8601 timestamps (`*_at`, GLOB-checked in the migration); named enums
 * ({@link SERVICE_CONNECTION_STATUSES}); typed booleans (`enabled`); JSON-as-TEXT
 * (`scopes`, `metadata`, `settings`, `session_policy`). The consolidated
 * schema-parity gate (T11364) re-derives the CHECK set from THIS metadata, so the
 * forward migration's CHECKs must match it exactly.
 *
 * @task T11937
 * @epic T11765
 * @saga T10409
 * @see ../../../crypto/credentials.ts — `encryptGlobal` / `decryptGlobal` (T11710)
 * @see ./accounts.ts — `accounts` (the SIBLING LLM-credential-pool table, T11709)
 * @see ../../service-connections-accessor.ts — the store CRUD + sealed-handle egress
 * @see ../../service-trust-gate.ts — policy-before-decrypt grant evaluation
 * @see ../../../../migrations/drizzle-cleo-global — the forward migration
 */

import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * Legal `service_connections.status` values — the lifecycle of a connection.
 *
 * - `active` — usable; the token is (or can be refreshed to) valid.
 * - `expired` — the access token (and refresh, if any) has lapsed; needs re-auth.
 * - `revoked` — the user (or provider) revoked the grant; never usable again.
 *
 * @task T11937
 */
export const SERVICE_CONNECTION_STATUSES = ['active', 'expired', 'revoked'] as const;

/** TypeScript union derived from {@link SERVICE_CONNECTION_STATUSES}. */
export type ServiceConnectionStatus = (typeof SERVICE_CONNECTION_STATUSES)[number];

/**
 * `service_connections` — one user-connected service credential per `(provider, label)`.
 *
 * `credentials_enc` is the `encryptGlobal()` ciphertext of the
 * `{access_token, refresh_token}` JSON blob (NEVER plaintext). `scopes` is the
 * JSON-serialized granted scope list; `metadata` is non-secret JSON (e.g. the
 * connected `username`/`email`) safe to display. The `(provider, label)` pair is
 * unique. The OAuth build/exchange/refresh that POPULATES `credentials_enc` is
 * T11939 — this table is the clean seam it writes into.
 *
 * @task T11937
 */
export const serviceConnections = sqliteTable(
  'service_connections',
  {
    /** Surrogate primary key (autoincrement via INTEGER PRIMARY KEY rowid alias). */
    id: integer('id').primaryKey(),
    /** Stable service-provider key (e.g. `github` | `google`). Joins SERVICE_PROVIDERS. */
    provider: text('provider').notNull(),
    /**
     * Human-readable connection label, unique WITHIN a provider (e.g. `personal`,
     * `work-org`). The `(provider, label)` pair is the natural unique key and the
     * `${provider}:${label}` half of the `encryptGlobal` id.
     */
    label: text('label').notNull(),
    /**
     * Connection lifecycle — `active` | `expired` | `revoked`
     * ({@link SERVICE_CONNECTION_STATUSES}). Only `active` connections resolve.
     */
    status: text('status', { enum: SERVICE_CONNECTION_STATUSES }).notNull().default('active'),
    /**
     * Encrypted credential blob — `encryptGlobal()` ciphertext of the
     * `{access_token, refresh_token}` JSON (`0x01 + 12B IV + 16B authTag` framing,
     * T11710). NEVER plaintext. NULL until the OAuth dance (T11939) writes a token.
     */
    credentialsEnc: text('credentials_enc'),
    /** JSON-serialized granted scope list (non-secret). Serialized TEXT; defaults to `[]`. */
    scopes: text('scopes').notNull().default('[]'),
    /** ISO-8601 UTC access-token expiry; NULL for a non-expiring token. */
    expiresAt: text('expires_at'),
    /**
     * Free-form NON-SECRET JSON (e.g. connected `username` / `email` / account id)
     * safe to display. NEVER holds token material. Serialized TEXT; defaults `{}`.
     */
    metadata: text('metadata').notNull().default('{}'),
    /** ISO-8601 UTC instant the connection was first established. Defaults to write time. */
    connectedAt: text('connected_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant. Defaults to write time; bumped on mutation. */
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    // A label is unique within a provider — the natural unique key.
    unique('ux_service_connections_provider_label').on(table.provider, table.label),
    // Lookup index — resolve a provider's active connections.
    index('idx_service_connections_provider_status').on(table.provider, table.status),
  ],
);

/** Row type for `service_connections` SELECT queries. */
export type ServiceConnectionRow = typeof serviceConnections.$inferSelect;
/** Row type for `service_connections` INSERT/UPSERT operations. */
export type NewServiceConnectionRow = typeof serviceConnections.$inferInsert;

/**
 * `service_configs` — per-provider BYOC (bring-your-own-client) OAuth app config.
 *
 * When a user brings their own OAuth client (rather than using CLEO's first-party
 * app), the client id + non-secret OAuth settings live in `settings` (JSON) and
 * the client SECRET lives encrypted in `client_secret_enc`. One row per provider
 * (`UNIQUE(provider)`). `enabled` toggles whether the BYOC config is used. This
 * is the clean seam the OAuth flow (T11939) reads to prefer a user client over
 * the registry default.
 *
 * @task T11937
 */
export const serviceConfigs = sqliteTable(
  'service_configs',
  {
    /** Surrogate primary key. */
    id: integer('id').primaryKey(),
    /** Stable service-provider key — unique (one BYOC config per provider). */
    provider: text('provider').notNull(),
    /** Whether this BYOC config is active. Typed boolean (CHECK IN (0,1)). Default false. */
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    /**
     * Encrypted BYOC client secret — `encryptGlobal()` ciphertext (id
     * `service-config:${provider}`). NEVER plaintext. NULL for a public-client
     * (PKCE) provider that has no secret.
     */
    clientSecretEnc: text('client_secret_enc'),
    /**
     * Non-secret BYOC settings JSON — the user's OAuth `client_id`, custom
     * `scopes`, custom endpoints, etc. NEVER holds the client secret. Serialized
     * TEXT; defaults `{}`.
     */
    settings: text('settings').notNull().default('{}'),
    /** ISO-8601 UTC row-creation instant. Defaults to write time. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant. Defaults to write time; bumped on mutation. */
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    // One BYOC config per provider.
    unique('ux_service_configs_provider').on(table.provider),
  ],
);

/** Row type for `service_configs` SELECT queries. */
export type ServiceConfigRow = typeof serviceConfigs.$inferSelect;
/** Row type for `service_configs` INSERT/UPSERT operations. */
export type NewServiceConfigRow = typeof serviceConfigs.$inferInsert;

/**
 * `agent_service_grants` — per-agent access to a service connection + policy.
 *
 * A grant authorizes one `agent_id` to use one `service_connection_id`, carrying
 * the `session_policy` JSON (block / rate-limit / manual-approval) the trust gate
 * (T11937 AC4) evaluates BEFORE any `decryptGlobal`. ABSENCE of a grant denies;
 * a `block` policy denies; only a passing policy lets the store decrypt. The
 * composite `(agent_id, service_connection_id)` is the primary key.
 *
 * `service_connection_id` references `service_connections(id)` — both tables live
 * in the SAME global `cleo.db` file (Pattern A), so the FK is in-file and
 * enforceable. The FK is declared natively (intra-domain, single global file —
 * mirrors the agent-registry FK convention).
 *
 * @task T11937
 */
export const agentServiceGrants = sqliteTable(
  'agent_service_grants',
  {
    /** The granted agent's id (FK-soft to the agent registry; string id). */
    agentId: text('agent_id').notNull(),
    /** The service connection this grant authorizes — references `service_connections(id)`. */
    serviceConnectionId: integer('service_connection_id')
      .notNull()
      .references(() => serviceConnections.id),
    /**
     * Per-session access policy JSON evaluated BEFORE decrypt. Shape (see
     * {@link import('../../service-trust-gate.js').SessionPolicy}):
     * `{ mode: 'allow'|'block', rateLimit?: {...}, manualApproval?: boolean }`.
     * Serialized TEXT; defaults `{"mode":"allow"}` (a bare grant = allow).
     */
    sessionPolicy: text('session_policy').notNull().default('{"mode":"allow"}'),
    /** ISO-8601 UTC grant-creation instant. Defaults to write time. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant. Defaults to write time; bumped on mutation. */
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    // A grant is uniquely identified by (agent, connection).
    primaryKey({ columns: [table.agentId, table.serviceConnectionId] }),
    // Lookup index — resolve all grants for one agent.
    index('idx_agent_service_grants_agent').on(table.agentId),
  ],
);

/** Row type for `agent_service_grants` SELECT queries. */
export type AgentServiceGrantRow = typeof agentServiceGrants.$inferSelect;
/** Row type for `agent_service_grants` INSERT/UPSERT operations. */
export type NewAgentServiceGrantRow = typeof agentServiceGrants.$inferInsert;
