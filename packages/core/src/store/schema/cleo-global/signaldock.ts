/**
 * Global-scope `cleo.db` — consolidated **signaldock** domain (13 tables).
 *
 * Part of the consolidated GLOBAL-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11361). Signaldock is
 * the global agent-identity tier — it FOLDS into the global `cleo.db` per D1
 * (no standalone `signaldock.db` survives). Target-shape authoring only —
 * physical names carry the `signaldock_` domain prefix. The live runtime module
 * `schema/signaldock-schema.ts` keeps its UNPREFIXED names (`users`, `agents`,
 * …) until the exodus migration (T11248) swaps the substrate.
 *
 * ## Idempotent prefixer (AC1)
 *
 * All 13 source tables are bare and gain the `signaldock_` prefix at exodus:
 * `users` → `signaldock_users` · `organization` → `signaldock_organization` ·
 * `agents` → `signaldock_agents` · `claim_codes` → `signaldock_claim_codes` ·
 * `capabilities` → `signaldock_capabilities` · `skills` → `signaldock_skills`
 * (the global agent CAPABILITY/SKILL catalog — distinct from the `skills_*`
 * installed-skills registry) · `agent_capabilities` →
 * `signaldock_agent_capabilities` · `agent_skills` → `signaldock_agent_skills`
 * · `agent_connections` → `signaldock_agent_connections` · `accounts` →
 * `signaldock_accounts` · `sessions` → `signaldock_sessions` · `verifications`
 * → `signaldock_verifications` · `org_agent_keys` → `signaldock_org_agent_keys`.
 *
 * ## E10 typing applied
 *
 * - **§4 timestamps (INTEGER epoch non-conformers → TEXT ISO8601):** the
 *   signaldock cloud-sync tables stored `created_at` / `updated_at` (and
 *   `expires_at` / `used_at` / `last_seen` / `last_used_at` / `connected_at`)
 *   as raw INTEGER epoch. Every column the audit flagged `timestamp-epoch`
 *   becomes canonical `text` ISO8601; the matching `CHECK (col GLOB
 *   'YYYY-MM-DD*')` ships at exodus. (`agent_connections.last_heartbeat` is
 *   classified `numeric` by the audit — a heartbeat counter, NOT a flagged
 *   timestamp — so it stays `integer`. The better-auth `accounts` / `sessions`
 *   / `verifications` tables already use TEXT timestamps; left as-is.)
 * - **§5b enum-like bare TEXT → `{ enum }`:** `signaldock_users.role` →
 *   `{ enum: SIGNALDOCK_USER_ROLES }` and `signaldock_agents.status` →
 *   `{ enum: SIGNALDOCK_AGENT_STATUSES }` (the two signaldock §5b
 *   non-conformers; const arrays minted in-module per §8.3 from the cloud-sync
 *   writer conventions — better-auth roles + the conduit presence set).
 * - **§3b boolean non-conformer:** `signaldock_agents.is_active` was untyped
 *   INTEGER 0/1 → `integer({ mode:'boolean' })`. The remaining 0/1 columns the
 *   audit classified `numeric` (`email_verified`, `banned`, `two_factor_enabled`,
 *   `requires_reauth`, `can_spawn`, `sessions.active`) are NOT flagged as
 *   boolean non-conformers by the audit, so they keep their plain `integer`
 *   affinity (faithful to the audit classification).
 *
 * ## FK reconciliation to single-file Pattern A (AC4)
 *
 * Every signaldock FK is INTRA-domain (all 13 tables now live in the SAME global
 * `cleo.db` file), so the source `.references()` are preserved as native FKs:
 * `agents.owner_id` → `signaldock_users.id`, `agents.organization_id` →
 * `signaldock_organization.id`, `claim_codes.{agent_id,used_by}`,
 * `agent_capabilities`/`agent_skills` composite-PK junctions,
 * `accounts.user_id` / `sessions.user_id`, `org_agent_keys.{organization_id,
 * agent_id}`. None of these crossed a file boundary, so no soft-FK downgrade is
 * required (AC4 — no ATTACH).
 *
 * @task T11361
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (D1″ · global counts) · §3b · §4 · §5b
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 * @see ../signaldock-schema.ts (the runtime source module)
 */

import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// E10 §5b — enum const arrays minted in-module (cloud-sync writer conventions)
// ---------------------------------------------------------------------------

/**
 * Legal `signaldock_users.role` values — better-auth account roles.
 *
 * E10 §5b: `users.role` was bare `text('role')` (default `'user'`). The
 * signaldock users table mirrors the api.signaldock.io better-auth admin-plugin
 * role set; populated only on cloud sync. Default `'user'`.
 *
 * @task T11361
 */
export const SIGNALDOCK_USER_ROLES = ['user', 'admin'] as const;

/** TypeScript union derived from {@link SIGNALDOCK_USER_ROLES}. */
export type SignaldockUserRole = (typeof SIGNALDOCK_USER_ROLES)[number];

/**
 * Legal `signaldock_agents.status` values — agent presence.
 *
 * E10 §5b: `agents.status` was bare `text('status')` (default `'online'`). The
 * presence set is the one the conduit client distinguishes (`status ===
 * 'online'` for reachability) plus the standard presence states.
 *
 * @task T11361
 */
export const SIGNALDOCK_AGENT_STATUSES = ['online', 'offline', 'busy', 'away'] as const;

/** TypeScript union derived from {@link SIGNALDOCK_AGENT_STATUSES}. */
export type SignaldockAgentStatus = (typeof SIGNALDOCK_AGENT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Cloud-sync: user accounts + organizations
// ---------------------------------------------------------------------------

/**
 * `signaldock_users` — cloud-sync user accounts (zero rows in pure-local mode).
 * Bare `users` → `signaldock_users` under the AC1 idempotent prefixer.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const signaldockUsers = sqliteTable(
  'signaldock_users',
  {
    /** User id. Primary key. */
    id: text('id').primaryKey(),
    /** Login email (unique). */
    email: text('email').notNull().unique(),
    /** Hashed password. */
    passwordHash: text('password_hash').notNull(),
    /** Display name. */
    name: text('name'),
    /** URL slug. */
    slug: text('slug'),
    /** Default agent id for this user (soft FK → signaldock_agents.agent_id). */
    defaultAgentId: text('default_agent_id'),
    /** Login username. */
    username: text('username'),
    /** Display username. */
    displayUsername: text('display_username'),
    /** Email-verified flag (0/1; audit-classified numeric, not a flagged boolean). */
    emailVerified: integer('email_verified').notNull().default(0),
    /** Avatar image URL. */
    image: text('image'),
    /** Account role from {@link SIGNALDOCK_USER_ROLES} (E10 §5b — was bare TEXT). */
    role: text('role', { enum: SIGNALDOCK_USER_ROLES }).notNull().default('user'),
    /** Banned flag (0/1; audit-classified numeric). */
    banned: integer('banned').notNull().default(0),
    /** Ban reason text. */
    banReason: text('ban_reason'),
    /** Ban-expiry timestamp text. */
    banExpires: text('ban_expires'),
    /** Two-factor-enabled flag (0/1; audit-classified numeric). */
    twoFactorEnabled: integer('two_factor_enabled').notNull().default(0),
    /** JSON metadata blob (serialized TEXT). */
    metadata: text('metadata'),
    /** ISO-8601 UTC creation instant (E10 §4: epoch → TEXT ISO8601). */
    createdAt: text('created_at').notNull(),
    /** ISO-8601 UTC last-update instant (E10 §4: epoch → TEXT ISO8601). */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_signaldock_users_slug').on(table.slug)],
);

/**
 * `signaldock_organization` — cloud-sync org/team records (zero rows locally).
 * Bare `organization` → `signaldock_organization`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const signaldockOrganization = sqliteTable(
  'signaldock_organization',
  {
    /** Organization id. Primary key. */
    id: text('id').primaryKey().notNull(),
    /** Organization name. */
    name: text('name').notNull(),
    /** URL slug. */
    slug: text('slug'),
    /** Logo URL. */
    logo: text('logo'),
    /** JSON metadata blob (serialized TEXT). */
    metadata: text('metadata'),
    /** Owner user id (soft FK → signaldock_users.id). */
    ownerId: text('owner_id'),
    /** ISO-8601 UTC creation instant (E10 §4: epoch → TEXT ISO8601). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (E10 §4: epoch → TEXT ISO8601). */
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_signaldock_organization_slug').on(table.slug)],
);

// ---------------------------------------------------------------------------
// Global identity: agent registry
// ---------------------------------------------------------------------------

/**
 * `signaldock_agents` — canonical cross-project agent registry (global
 * identity). Bare `agents` → `signaldock_agents`.
 *
 * T897 v3 columns: tier, can_spawn, orch_level, reports_to, cant_path,
 * cant_sha256, installed_from, installed_at.
 *
 * @task T11361 (target shape) · T346 / T897 (original)
 */
export const signaldockAgents = sqliteTable(
  'signaldock_agents',
  {
    /** Agent id. Primary key. */
    id: text('id').primaryKey(),
    /** Canonical agent identifier (unique). */
    agentId: text('agent_id').notNull().unique(),
    /** Agent display name. */
    name: text('name').notNull(),
    /** Agent description. */
    description: text('description'),
    /** Agent class. */
    class: text('class').notNull().default('custom'),
    /** Privacy tier ("public" / "private" / …). */
    privacyTier: text('privacy_tier').notNull().default('public'),
    /** Owner user id (intra-domain FK → signaldock_users.id). */
    ownerId: text('owner_id').references(() => signaldockUsers.id),
    /** Transport endpoint URL. */
    endpoint: text('endpoint'),
    /** Webhook signing secret. */
    webhookSecret: text('webhook_secret'),
    /** JSON array of capability slugs (serialized TEXT). */
    capabilities: text('capabilities').notNull().default('[]'),
    /** JSON array of skill slugs (serialized TEXT). */
    skills: text('skills').notNull().default('[]'),
    /** Avatar URL. */
    avatar: text('avatar'),
    /** Cumulative messages sent. */
    messagesSent: integer('messages_sent').notNull().default(0),
    /** Cumulative messages received. */
    messagesReceived: integer('messages_received').notNull().default(0),
    /** Conversation count. */
    conversationCount: integer('conversation_count').notNull().default(0),
    /** Friend count. */
    friendCount: integer('friend_count').notNull().default(0),
    /** Agent presence from {@link SIGNALDOCK_AGENT_STATUSES} (E10 §5b — was bare TEXT). */
    status: text('status', { enum: SIGNALDOCK_AGENT_STATUSES }).notNull().default('online'),
    /** Epoch-ms last-seen heartbeat (audit-classified numeric, not a flagged timestamp). */
    lastSeen: integer('last_seen'),
    /** JSON payment-config blob (serialized TEXT). */
    paymentConfig: text('payment_config'),
    /** Hashed API key. */
    apiKeyHash: text('api_key_hash'),
    /** Owning organization id (intra-domain FK → signaldock_organization.id). */
    organizationId: text('organization_id').references(() => signaldockOrganization.id, {
      onDelete: 'set null',
    }),
    /** ISO-8601 UTC creation instant (E10 §4: epoch → TEXT ISO8601). */
    createdAt: text('created_at').notNull(),
    /** ISO-8601 UTC last-update instant (E10 §4: epoch → TEXT ISO8601). */
    updatedAt: text('updated_at').notNull(),
    /** Transport type ("http" / …). */
    transportType: text('transport_type').notNull().default('http'),
    /** KDF-encrypted API key (ADR-037 §5). */
    apiKeyEncrypted: text('api_key_encrypted'),
    /** Cloud API base URL. */
    apiBaseUrl: text('api_base_url').notNull().default('https://api.signaldock.io'),
    /** Free-form classification label. */
    classification: text('classification'),
    /** JSON transport-config blob (serialized TEXT). */
    transportConfig: text('transport_config').notNull().default('{}'),
    /** Whether this agent is active (E10 §3b: untyped INTEGER 0/1 → typed boolean). */
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    /** Epoch-ms last-used instant (E10 §4: epoch → TEXT ISO8601). */
    lastUsedAt: text('last_used_at'),
    /** Requires-reauth flag (0/1; audit-classified numeric). */
    requiresReauth: integer('requires_reauth').notNull().default(0),
    /** Tier taxonomy from ADR-044 (project / global / packaged / fallback). */
    tier: text('tier').notNull().default('global'),
    /** Whether this agent may spawn sub-agents (0/1; audit-classified numeric). */
    canSpawn: integer('can_spawn').notNull().default(0),
    /** Orchestration level: 0=worker, 1=lead, 2=orchestrator. */
    orchLevel: integer('orch_level').notNull().default(2),
    /** Agent id this agent reports to (soft FK → signaldock_agents.agent_id). */
    reportsTo: text('reports_to'),
    /** Absolute path to the agent's .cant definition file. */
    cantPath: text('cant_path'),
    /** SHA-256 checksum of the .cant file at install time. */
    cantSha256: text('cant_sha256'),
    /** Installation provenance (seed / user / manual). */
    installedFrom: text('installed_from'),
    /** ISO-8601 UTC install instant (already canonical TEXT, §4). */
    installedAt: text('installed_at'),
  },
  (table) => [
    index('idx_signaldock_agents_owner').on(table.ownerId),
    index('idx_signaldock_agents_class').on(table.class),
    index('idx_signaldock_agents_privacy').on(table.privacyTier),
    index('idx_signaldock_agents_org').on(table.organizationId),
    index('idx_signaldock_agents_transport_type').on(table.transportType),
    index('idx_signaldock_agents_is_active').on(table.isActive),
    index('idx_signaldock_agents_last_used').on(table.lastUsedAt),
    index('idx_signaldock_agents_tier').on(table.tier),
    index('idx_signaldock_agents_cant_path').on(table.cantPath),
  ],
);

// ---------------------------------------------------------------------------
// Cloud-sync: claim codes
// ---------------------------------------------------------------------------

/**
 * `signaldock_claim_codes` — one-time agent claim tokens (cloud provisioning).
 * Bare `claim_codes` → `signaldock_claim_codes`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const signaldockClaimCodes = sqliteTable(
  'signaldock_claim_codes',
  {
    /** Claim code id. Primary key. */
    id: text('id').primaryKey(),
    /** Agent being claimed (intra-domain FK → signaldock_agents.id). */
    agentId: text('agent_id')
      .notNull()
      .references(() => signaldockAgents.id),
    /** One-time claim code (unique). */
    code: text('code').notNull().unique(),
    /** ISO-8601 UTC expiry instant (E10 §4: epoch → TEXT ISO8601). */
    expiresAt: text('expires_at').notNull(),
    /** ISO-8601 UTC used instant; NULL until used (E10 §4: epoch → TEXT ISO8601). */
    usedAt: text('used_at'),
    /** User who used the code (intra-domain FK → signaldock_users.id). */
    usedBy: text('used_by').references(() => signaldockUsers.id),
    /** ISO-8601 UTC creation instant (E10 §4: epoch → TEXT ISO8601). */
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_signaldock_claim_codes_agent').on(table.agentId)],
);

// ---------------------------------------------------------------------------
// Identity catalog
// ---------------------------------------------------------------------------

/**
 * `signaldock_capabilities` — pre-seeded capability-slug catalog. Bare
 * `capabilities` → `signaldock_capabilities`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const signaldockCapabilities = sqliteTable('signaldock_capabilities', {
  /** Capability id. Primary key. */
  id: text('id').primaryKey(),
  /** Capability slug (unique). */
  slug: text('slug').notNull().unique(),
  /** Capability display name. */
  name: text('name').notNull(),
  /** Capability description. */
  description: text('description').notNull(),
  /** Capability category. */
  category: text('category').notNull(),
  /** ISO-8601 UTC creation instant (E10 §4: epoch → TEXT ISO8601). */
  createdAt: text('created_at').notNull(),
});

/**
 * `signaldock_skills` — pre-seeded agent skill-slug catalog. Bare `skills` →
 * `signaldock_skills`. (The agent CAPABILITY catalog — distinct from the
 * installed-skills `skills_*` registry in `./skills.ts`.)
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const signaldockSkills = sqliteTable('signaldock_skills', {
  /** Skill id. Primary key. */
  id: text('id').primaryKey(),
  /** Skill slug (unique). */
  slug: text('slug').notNull().unique(),
  /** Skill display name. */
  name: text('name').notNull(),
  /** Skill description. */
  description: text('description').notNull(),
  /** Skill category. */
  category: text('category').notNull(),
  /** ISO-8601 UTC creation instant (E10 §4: epoch → TEXT ISO8601). */
  createdAt: text('created_at').notNull(),
});

// ---------------------------------------------------------------------------
// Junction tables
// ---------------------------------------------------------------------------

/**
 * `signaldock_agent_capabilities` — agent ↔ capability junction. Bare
 * `agent_capabilities` → `signaldock_agent_capabilities`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const signaldockAgentCapabilities = sqliteTable(
  'signaldock_agent_capabilities',
  {
    /** Agent id (intra-domain FK → signaldock_agents.id). */
    agentId: text('agent_id')
      .notNull()
      .references(() => signaldockAgents.id),
    /** Capability id (intra-domain FK → signaldock_capabilities.id). */
    capabilityId: text('capability_id')
      .notNull()
      .references(() => signaldockCapabilities.id),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.capabilityId] })],
);

/**
 * `signaldock_agent_skills` — agent ↔ skill junction. Bare `agent_skills` →
 * `signaldock_agent_skills`. T897 v3 columns: source, attached_at.
 *
 * @task T11361 (target shape) · T897 (original)
 */
export const signaldockAgentSkills = sqliteTable(
  'signaldock_agent_skills',
  {
    /** Agent id (intra-domain FK → signaldock_agents.id). */
    agentId: text('agent_id')
      .notNull()
      .references(() => signaldockAgents.id),
    /** Skill id (intra-domain FK → signaldock_skills.id). */
    skillId: text('skill_id')
      .notNull()
      .references(() => signaldockSkills.id),
    /** Skill-attachment provenance (cant / manual / computed). */
    source: text('source').notNull().default('manual'),
    /** ISO-8601 UTC attachment instant (already canonical TEXT, §4). */
    attachedAt: text('attached_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.skillId] }),
    index('idx_signaldock_agent_skills_source').on(table.source),
  ],
);

// ---------------------------------------------------------------------------
// Agent connections
// ---------------------------------------------------------------------------

/**
 * `signaldock_agent_connections` — live transport connection tracking
 * (heartbeat state). Bare `agent_connections` → `signaldock_agent_connections`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const signaldockAgentConnections = sqliteTable(
  'signaldock_agent_connections',
  {
    /** Connection id. Primary key. */
    id: text('id').primaryKey().notNull(),
    /** Connected agent id (soft FK → signaldock_agents.agent_id). */
    agentId: text('agent_id').notNull(),
    /** Transport type ("http" / …). */
    transportType: text('transport_type').notNull().default('http'),
    /** Transport-specific connection identifier. */
    connectionId: text('connection_id'),
    /** ISO-8601 UTC connect instant (E10 §4: epoch → TEXT ISO8601). */
    connectedAt: text('connected_at').notNull(),
    /** Epoch-ms last heartbeat (audit-classified numeric, not a flagged timestamp). */
    lastHeartbeat: integer('last_heartbeat').notNull(),
    /** JSON connection-metadata blob (serialized TEXT). */
    connectionMetadata: text('connection_metadata'),
    /** ISO-8601 UTC creation instant (E10 §4: epoch → TEXT ISO8601). */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_signaldock_agent_connections_agent').on(table.agentId),
    index('idx_signaldock_agent_connections_transport').on(table.transportType),
    index('idx_signaldock_agent_connections_heartbeat').on(table.lastHeartbeat),
    unique().on(table.agentId, table.connectionId),
  ],
);

// ---------------------------------------------------------------------------
// Cloud-sync: OAuth, sessions, verifications (better-auth — already TEXT ts)
// ---------------------------------------------------------------------------

/**
 * `signaldock_accounts` — cloud-sync OAuth/provider accounts. Bare `accounts` →
 * `signaldock_accounts`. (better-auth timestamps already canonical TEXT, §4.)
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const signaldockAccounts = sqliteTable(
  'signaldock_accounts',
  {
    /** Account row id. Primary key. */
    id: text('id').primaryKey().notNull(),
    /** Owning user (intra-domain FK → signaldock_users.id). */
    userId: text('user_id')
      .notNull()
      .references(() => signaldockUsers.id, { onDelete: 'cascade' }),
    /** Provider account id. */
    accountId: text('account_id').notNull(),
    /** OAuth provider id. */
    providerId: text('provider_id').notNull(),
    /** Access token. */
    accessToken: text('access_token'),
    /** Refresh token. */
    refreshToken: text('refresh_token'),
    /** ID token. */
    idToken: text('id_token'),
    /** ISO-8601 access-token expiry (canonical TEXT, §4). */
    accessTokenExpiresAt: text('access_token_expires_at'),
    /** ISO-8601 refresh-token expiry (canonical TEXT, §4). */
    refreshTokenExpiresAt: text('refresh_token_expires_at'),
    /** Granted scope string. */
    scope: text('scope'),
    /** Local password hash (credentials provider). */
    password: text('password'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull(),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_signaldock_accounts_user_id').on(table.userId),
    unique('idx_signaldock_accounts_provider').on(table.providerId, table.accountId),
  ],
);

/**
 * `signaldock_sessions` — cloud-sync authenticated sessions. Bare `sessions` →
 * `signaldock_sessions`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const signaldockSessions = sqliteTable(
  'signaldock_sessions',
  {
    /** Session id. Primary key. */
    id: text('id').primaryKey().notNull(),
    /** Owning user (intra-domain FK → signaldock_users.id). */
    userId: text('user_id')
      .notNull()
      .references(() => signaldockUsers.id, { onDelete: 'cascade' }),
    /** Session token (unique). */
    token: text('token').notNull().unique(),
    /** Client IP address. */
    ipAddress: text('ip_address'),
    /** Client user-agent string. */
    userAgent: text('user_agent'),
    /** ISO-8601 UTC expiry instant (canonical TEXT, §4). */
    expiresAt: text('expires_at').notNull(),
    /** Active organization id (soft FK → signaldock_organization.id). */
    activeOrganizationId: text('active_organization_id'),
    /** Impersonating admin user id, if any. */
    impersonatedBy: text('impersonated_by'),
    /** Active flag (0/1; audit-classified numeric). */
    active: integer('active').notNull().default(1),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull(),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_signaldock_sessions_user_id').on(table.userId)],
);

/**
 * `signaldock_verifications` — cloud-sync email/2FA verification tokens. Bare
 * `verifications` → `signaldock_verifications`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const signaldockVerifications = sqliteTable(
  'signaldock_verifications',
  {
    /** Verification id. Primary key. */
    id: text('id').primaryKey().notNull(),
    /** Identifier being verified (email / phone). */
    identifier: text('identifier').notNull(),
    /** Verification value/token. */
    value: text('value').notNull(),
    /** ISO-8601 UTC expiry instant (canonical TEXT, §4). */
    expiresAt: text('expires_at').notNull(),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull(),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_signaldock_verifications_identifier').on(table.identifier)],
);

// ---------------------------------------------------------------------------
// Cloud-sync: org agent keys
// ---------------------------------------------------------------------------

/**
 * `signaldock_org_agent_keys` — org-scoped agent API keys (cloud use; zero rows
 * locally). Bare `org_agent_keys` → `signaldock_org_agent_keys`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const signaldockOrgAgentKeys = sqliteTable(
  'signaldock_org_agent_keys',
  {
    /** Key row id. Primary key. */
    id: text('id').primaryKey().notNull(),
    /** Owning organization (intra-domain FK → signaldock_organization.id). */
    organizationId: text('organization_id')
      .notNull()
      .references(() => signaldockOrganization.id, { onDelete: 'cascade' }),
    /** Scoped agent (intra-domain FK → signaldock_agents.id). */
    agentId: text('agent_id')
      .notNull()
      .references(() => signaldockAgents.id, { onDelete: 'cascade' }),
    /** Creator user id. */
    createdBy: text('created_by').notNull(),
    /** ISO-8601 UTC creation instant (E10 §4: epoch → TEXT ISO8601). */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_signaldock_org_agent_keys_org').on(table.organizationId),
    index('idx_signaldock_org_agent_keys_agent').on(table.agentId),
  ],
);

// ---------------------------------------------------------------------------
// Inferred row + insert types
// ---------------------------------------------------------------------------

/** Row type for `signaldock_users` SELECT (target shape). */
export type SignaldockUserRow = typeof signaldockUsers.$inferSelect;
/** Row type for `signaldock_users` INSERT (target shape). */
export type NewSignaldockUserRow = typeof signaldockUsers.$inferInsert;
/** Row type for `signaldock_organization` SELECT (target shape). */
export type SignaldockOrganizationRow = typeof signaldockOrganization.$inferSelect;
/** Row type for `signaldock_organization` INSERT (target shape). */
export type NewSignaldockOrganizationRow = typeof signaldockOrganization.$inferInsert;
/** Row type for `signaldock_agents` SELECT (target shape). */
export type SignaldockAgentRow = typeof signaldockAgents.$inferSelect;
/** Row type for `signaldock_agents` INSERT (target shape). */
export type NewSignaldockAgentRow = typeof signaldockAgents.$inferInsert;
/** Row type for `signaldock_claim_codes` SELECT (target shape). */
export type SignaldockClaimCodeRow = typeof signaldockClaimCodes.$inferSelect;
/** Row type for `signaldock_claim_codes` INSERT (target shape). */
export type NewSignaldockClaimCodeRow = typeof signaldockClaimCodes.$inferInsert;
/** Row type for `signaldock_capabilities` SELECT (target shape). */
export type SignaldockCapabilityRow = typeof signaldockCapabilities.$inferSelect;
/** Row type for `signaldock_capabilities` INSERT (target shape). */
export type NewSignaldockCapabilityRow = typeof signaldockCapabilities.$inferInsert;
/** Row type for `signaldock_skills` SELECT (target shape). */
export type SignaldockSkillRow = typeof signaldockSkills.$inferSelect;
/** Row type for `signaldock_skills` INSERT (target shape). */
export type NewSignaldockSkillRow = typeof signaldockSkills.$inferInsert;
/** Row type for `signaldock_agent_capabilities` SELECT (target shape). */
export type SignaldockAgentCapabilityRow = typeof signaldockAgentCapabilities.$inferSelect;
/** Row type for `signaldock_agent_capabilities` INSERT (target shape). */
export type NewSignaldockAgentCapabilityRow = typeof signaldockAgentCapabilities.$inferInsert;
/** Row type for `signaldock_agent_skills` SELECT (target shape). */
export type SignaldockAgentSkillRow = typeof signaldockAgentSkills.$inferSelect;
/** Row type for `signaldock_agent_skills` INSERT (target shape). */
export type NewSignaldockAgentSkillRow = typeof signaldockAgentSkills.$inferInsert;
/** Row type for `signaldock_agent_connections` SELECT (target shape). */
export type SignaldockAgentConnectionRow = typeof signaldockAgentConnections.$inferSelect;
/** Row type for `signaldock_agent_connections` INSERT (target shape). */
export type NewSignaldockAgentConnectionRow = typeof signaldockAgentConnections.$inferInsert;
/** Row type for `signaldock_accounts` SELECT (target shape). */
export type SignaldockAccountRow = typeof signaldockAccounts.$inferSelect;
/** Row type for `signaldock_accounts` INSERT (target shape). */
export type NewSignaldockAccountRow = typeof signaldockAccounts.$inferInsert;
/** Row type for `signaldock_sessions` SELECT (target shape). */
export type SignaldockSessionRow = typeof signaldockSessions.$inferSelect;
/** Row type for `signaldock_sessions` INSERT (target shape). */
export type NewSignaldockSessionRow = typeof signaldockSessions.$inferInsert;
/** Row type for `signaldock_verifications` SELECT (target shape). */
export type SignaldockVerificationRow = typeof signaldockVerifications.$inferSelect;
/** Row type for `signaldock_verifications` INSERT (target shape). */
export type NewSignaldockVerificationRow = typeof signaldockVerifications.$inferInsert;
/** Row type for `signaldock_org_agent_keys` SELECT (target shape). */
export type SignaldockOrgAgentKeyRow = typeof signaldockOrgAgentKeys.$inferSelect;
/** Row type for `signaldock_org_agent_keys` INSERT (target shape). */
export type NewSignaldockOrgAgentKeyRow = typeof signaldockOrgAgentKeys.$inferInsert;
