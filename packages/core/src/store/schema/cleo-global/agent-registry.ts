/**
 * Global-scope `cleo.db` — consolidated **Agent Registry** domain (13 tables).
 *
 * The Agent Registry is the GLOBAL agent-identity tier (formerly labelled
 * "signaldock" — the rename landed under T11622 / SG-AGENT-IDENTITY E4). It holds
 * agents / capabilities / skills / credentials and has ZERO send/receive
 * functions — agent-to-agent messaging is owned by the conduit domain. The
 * external `api.signaldock.io` URL retained below is an EXTERNAL Conduit transport
 * channel, NOT this local registry; it intentionally keeps the legacy hostname.
 *
 * Part of the consolidated GLOBAL-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11361). The Agent
 * Registry FOLDS into the global `cleo.db` per D1 (no standalone identity-DB file
 * survives). Physical names carry the `agent_registry_` domain prefix — these are
 * the runtime READ + WRITE tables after the T11622 cutover (folds T11578 AC2).
 *
 * ## Idempotent prefixer (AC1)
 *
 * All 13 source tables are bare and gain the `agent_registry_` prefix at exodus:
 * `users` → `agent_registry_users` · `organization` → `agent_registry_organization` ·
 * `agents` → `agent_registry_agents` · `claim_codes` → `agent_registry_claim_codes` ·
 * `capabilities` → `agent_registry_capabilities` · `skills` → `agent_registry_skills`
 * (the global agent CAPABILITY/SKILL catalog — distinct from the `skills_*`
 * installed-skills registry) · `agent_capabilities` →
 * `agent_registry_agent_capabilities` · `agent_skills` → `agent_registry_agent_skills`
 * · `agent_connections` → `agent_registry_agent_connections` · `accounts` →
 * `agent_registry_accounts` · `sessions` → `agent_registry_sessions` · `verifications`
 * → `agent_registry_verifications` · `org_agent_keys` → `agent_registry_org_agent_keys`.
 *
 * ## E10 typing applied
 *
 * - **§4 timestamps (INTEGER epoch non-conformers → TEXT ISO8601):** the
 *   agent-registry cloud-sync tables stored `created_at` / `updated_at` (and
 *   `expires_at` / `used_at` / `last_seen` / `last_used_at` / `connected_at`)
 *   as raw INTEGER epoch. Every column the audit flagged `timestamp-epoch`
 *   becomes canonical `text` ISO8601; the matching `CHECK (col GLOB
 *   'YYYY-MM-DD*')` ships at exodus. (`agent_connections.last_heartbeat` is
 *   classified `numeric` by the audit — a heartbeat counter, NOT a flagged
 *   timestamp — so it stays `integer`. The better-auth `accounts` / `sessions`
 *   / `verifications` tables already use TEXT timestamps; left as-is.)
 * - **§5b enum-like bare TEXT → `{ enum }`:** `agent_registry_users.role` →
 *   `{ enum: AGENT_REGISTRY_USER_ROLES }` and `agent_registry_agents.status` →
 *   `{ enum: AGENT_REGISTRY_AGENT_STATUSES }` (the two agent-registry §5b
 *   non-conformers; const arrays minted in-module per §8.3 from the cloud-sync
 *   writer conventions — better-auth roles + the conduit presence set).
 * - **§3b boolean non-conformer:** `agent_registry_agents.is_active` was untyped
 *   INTEGER 0/1 → `integer({ mode:'boolean' })`. The remaining 0/1 columns the
 *   audit classified `numeric` (`email_verified`, `banned`, `two_factor_enabled`,
 *   `requires_reauth`, `can_spawn`, `sessions.active`) are NOT flagged as
 *   boolean non-conformers by the audit, so they keep their plain `integer`
 *   affinity (faithful to the audit classification).
 *
 * ## FK reconciliation to single-file Pattern A (AC4)
 *
 * Every agent-registry FK is INTRA-domain (all 13 tables now live in the SAME global
 * `cleo.db` file), so the source `.references()` are preserved as native FKs:
 * `agents.owner_id` → `agent_registry_users.id`, `agents.organization_id` →
 * `agent_registry_organization.id`, `claim_codes.{agent_id,used_by}`,
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
 * @see ../agent-registry-schema.ts (the legacy bare-named runtime schema module)
 * @task T11622 (Signaldock → Agent Registry rename + runtime cutover; folds T11578 AC2)
 */

import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// E10 §5b — enum const arrays minted in-module (cloud-sync writer conventions)
// ---------------------------------------------------------------------------

/**
 * Legal `agent_registry_users.role` values — better-auth account roles.
 *
 * E10 §5b: `users.role` was bare `text('role')` (default `'user'`). The
 * agent-registry users table mirrors the api.signaldock.io better-auth admin-plugin
 * role set; populated only on cloud sync. Default `'user'`.
 *
 * @task T11361
 */
export const AGENT_REGISTRY_USER_ROLES = ['user', 'admin'] as const;

/** TypeScript union derived from {@link AGENT_REGISTRY_USER_ROLES}. */
export type AgentRegistryUserRole = (typeof AGENT_REGISTRY_USER_ROLES)[number];

/**
 * Legal `agent_registry_agents.status` values — agent presence.
 *
 * E10 §5b: `agents.status` was bare `text('status')` (default `'online'`). The
 * presence set is the one the conduit client distinguishes (`status ===
 * 'online'` for reachability) plus the standard presence states.
 *
 * @task T11361
 */
export const AGENT_REGISTRY_AGENT_STATUSES = ['online', 'offline', 'busy', 'away'] as const;

/** TypeScript union derived from {@link AGENT_REGISTRY_AGENT_STATUSES}. */
export type AgentRegistryAgentStatus = (typeof AGENT_REGISTRY_AGENT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Cloud-sync: user accounts + organizations
// ---------------------------------------------------------------------------

/**
 * `agent_registry_users` — cloud-sync user accounts (zero rows in pure-local mode).
 * Bare `users` → `agent_registry_users` under the AC1 idempotent prefixer.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const agentRegistryUsers = sqliteTable(
  'agent_registry_users',
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
    /** Default agent id for this user (soft FK → agent_registry_agents.agent_id). */
    defaultAgentId: text('default_agent_id'),
    /** Login username. */
    username: text('username'),
    /** Display username. */
    displayUsername: text('display_username'),
    /** Email-verified flag (0/1; audit-classified numeric, not a flagged boolean). */
    emailVerified: integer('email_verified').notNull().default(0),
    /** Avatar image URL. */
    image: text('image'),
    /** Account role from {@link AGENT_REGISTRY_USER_ROLES} (E10 §5b — was bare TEXT). */
    role: text('role', { enum: AGENT_REGISTRY_USER_ROLES }).notNull().default('user'),
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
  (table) => [index('idx_agent_registry_users_slug').on(table.slug)],
);

/**
 * `agent_registry_organization` — cloud-sync org/team records (zero rows locally).
 * Bare `organization` → `agent_registry_organization`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const agentRegistryOrganization = sqliteTable(
  'agent_registry_organization',
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
    /** Owner user id (soft FK → agent_registry_users.id). */
    ownerId: text('owner_id'),
    /** ISO-8601 UTC creation instant (E10 §4: epoch → TEXT ISO8601). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (E10 §4: epoch → TEXT ISO8601). */
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_agent_registry_organization_slug').on(table.slug)],
);

// ---------------------------------------------------------------------------
// Global identity: agent registry
// ---------------------------------------------------------------------------

/**
 * `agent_registry_agents` — canonical cross-project agent registry (global
 * identity). Bare `agents` → `agent_registry_agents`.
 *
 * T897 v3 columns: tier, can_spawn, orch_level, reports_to, cant_path,
 * cant_sha256, installed_from, installed_at.
 *
 * @task T11361 (target shape) · T346 / T897 (original)
 */
export const agentRegistryAgents = sqliteTable(
  'agent_registry_agents',
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
    /** Owner user id (intra-domain FK → agent_registry_users.id). */
    ownerId: text('owner_id').references(() => agentRegistryUsers.id),
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
    /** Agent presence from {@link AGENT_REGISTRY_AGENT_STATUSES} (E10 §5b — was bare TEXT). */
    status: text('status', { enum: AGENT_REGISTRY_AGENT_STATUSES }).notNull().default('online'),
    /** Epoch-ms last-seen heartbeat (audit-classified numeric, not a flagged timestamp). */
    lastSeen: integer('last_seen'),
    /** JSON payment-config blob (serialized TEXT). */
    paymentConfig: text('payment_config'),
    /** Hashed API key. */
    apiKeyHash: text('api_key_hash'),
    /** Owning organization id (intra-domain FK → agent_registry_organization.id). */
    organizationId: text('organization_id').references(() => agentRegistryOrganization.id, {
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
    /**
     * Cloud API base URL. The `api.signaldock.io` default is the EXTERNAL Conduit
     * transport channel — it intentionally retains the legacy hostname and is NOT
     * part of the Agent Registry rename (T11622). It configures where the agent
     * talks to the cloud, not where the local registry lives.
     */
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
    /** Agent id this agent reports to (soft FK → agent_registry_agents.agent_id). */
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
    index('idx_agent_registry_agents_owner').on(table.ownerId),
    index('idx_agent_registry_agents_class').on(table.class),
    index('idx_agent_registry_agents_privacy').on(table.privacyTier),
    index('idx_agent_registry_agents_org').on(table.organizationId),
    index('idx_agent_registry_agents_transport_type').on(table.transportType),
    index('idx_agent_registry_agents_is_active').on(table.isActive),
    index('idx_agent_registry_agents_last_used').on(table.lastUsedAt),
    index('idx_agent_registry_agents_tier').on(table.tier),
    index('idx_agent_registry_agents_cant_path').on(table.cantPath),
  ],
);

// ---------------------------------------------------------------------------
// Cloud-sync: claim codes
// ---------------------------------------------------------------------------

/**
 * `agent_registry_claim_codes` — one-time agent claim tokens (cloud provisioning).
 * Bare `claim_codes` → `agent_registry_claim_codes`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const agentRegistryClaimCodes = sqliteTable(
  'agent_registry_claim_codes',
  {
    /** Claim code id. Primary key. */
    id: text('id').primaryKey(),
    /** Agent being claimed (intra-domain FK → agent_registry_agents.id). */
    agentId: text('agent_id')
      .notNull()
      .references(() => agentRegistryAgents.id),
    /** One-time claim code (unique). */
    code: text('code').notNull().unique(),
    /** ISO-8601 UTC expiry instant (E10 §4: epoch → TEXT ISO8601). */
    expiresAt: text('expires_at').notNull(),
    /** ISO-8601 UTC used instant; NULL until used (E10 §4: epoch → TEXT ISO8601). */
    usedAt: text('used_at'),
    /** User who used the code (intra-domain FK → agent_registry_users.id). */
    usedBy: text('used_by').references(() => agentRegistryUsers.id),
    /** ISO-8601 UTC creation instant (E10 §4: epoch → TEXT ISO8601). */
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_agent_registry_claim_codes_agent').on(table.agentId)],
);

// ---------------------------------------------------------------------------
// Identity catalog
// ---------------------------------------------------------------------------

/**
 * `agent_registry_capabilities` — pre-seeded capability-slug catalog. Bare
 * `capabilities` → `agent_registry_capabilities`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const agentRegistryCapabilities = sqliteTable('agent_registry_capabilities', {
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
 * `agent_registry_skills` — pre-seeded agent skill-slug catalog. Bare `skills` →
 * `agent_registry_skills`. (The agent CAPABILITY catalog — distinct from the
 * installed-skills `skills_*` registry in `./skills.ts`.)
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const agentRegistrySkills = sqliteTable('agent_registry_skills', {
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
 * `agent_registry_agent_capabilities` — agent ↔ capability junction. Bare
 * `agent_capabilities` → `agent_registry_agent_capabilities`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const agentRegistryAgentCapabilities = sqliteTable(
  'agent_registry_agent_capabilities',
  {
    /** Agent id (intra-domain FK → agent_registry_agents.id). */
    agentId: text('agent_id')
      .notNull()
      .references(() => agentRegistryAgents.id),
    /** Capability id (intra-domain FK → agent_registry_capabilities.id). */
    capabilityId: text('capability_id')
      .notNull()
      .references(() => agentRegistryCapabilities.id),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.capabilityId] })],
);

/**
 * `agent_registry_agent_skills` — agent ↔ skill junction. Bare `agent_skills` →
 * `agent_registry_agent_skills`. T897 v3 columns: source, attached_at.
 *
 * @task T11361 (target shape) · T897 (original)
 */
export const agentRegistryAgentSkills = sqliteTable(
  'agent_registry_agent_skills',
  {
    /** Agent id (intra-domain FK → agent_registry_agents.id). */
    agentId: text('agent_id')
      .notNull()
      .references(() => agentRegistryAgents.id),
    /** Skill id (intra-domain FK → agent_registry_skills.id). */
    skillId: text('skill_id')
      .notNull()
      .references(() => agentRegistrySkills.id),
    /** Skill-attachment provenance (cant / manual / computed). */
    source: text('source').notNull().default('manual'),
    /** ISO-8601 UTC attachment instant (already canonical TEXT, §4). */
    attachedAt: text('attached_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.skillId] }),
    index('idx_agent_registry_agent_skills_source').on(table.source),
  ],
);

// ---------------------------------------------------------------------------
// Agent connections
// ---------------------------------------------------------------------------

/**
 * `agent_registry_agent_connections` — live transport connection tracking
 * (heartbeat state). Bare `agent_connections` → `agent_registry_agent_connections`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const agentRegistryAgentConnections = sqliteTable(
  'agent_registry_agent_connections',
  {
    /** Connection id. Primary key. */
    id: text('id').primaryKey().notNull(),
    /** Connected agent id (soft FK → agent_registry_agents.agent_id). */
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
    index('idx_agent_registry_agent_connections_agent').on(table.agentId),
    index('idx_agent_registry_agent_connections_transport').on(table.transportType),
    index('idx_agent_registry_agent_connections_heartbeat').on(table.lastHeartbeat),
    unique().on(table.agentId, table.connectionId),
  ],
);

// ---------------------------------------------------------------------------
// Cloud-sync: OAuth, sessions, verifications (better-auth — already TEXT ts)
// ---------------------------------------------------------------------------

/**
 * `agent_registry_accounts` — cloud-sync OAuth/provider accounts. Bare `accounts` →
 * `agent_registry_accounts`. (better-auth timestamps already canonical TEXT, §4.)
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const agentRegistryAccounts = sqliteTable(
  'agent_registry_accounts',
  {
    /** Account row id. Primary key. */
    id: text('id').primaryKey().notNull(),
    /** Owning user (intra-domain FK → agent_registry_users.id). */
    userId: text('user_id')
      .notNull()
      .references(() => agentRegistryUsers.id, { onDelete: 'cascade' }),
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
    index('idx_agent_registry_accounts_user_id').on(table.userId),
    unique('idx_agent_registry_accounts_provider').on(table.providerId, table.accountId),
  ],
);

/**
 * `agent_registry_sessions` — cloud-sync authenticated sessions. Bare `sessions` →
 * `agent_registry_sessions`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const agentRegistrySessions = sqliteTable(
  'agent_registry_sessions',
  {
    /** Session id. Primary key. */
    id: text('id').primaryKey().notNull(),
    /** Owning user (intra-domain FK → agent_registry_users.id). */
    userId: text('user_id')
      .notNull()
      .references(() => agentRegistryUsers.id, { onDelete: 'cascade' }),
    /** Session token (unique). */
    token: text('token').notNull().unique(),
    /** Client IP address. */
    ipAddress: text('ip_address'),
    /** Client user-agent string. */
    userAgent: text('user_agent'),
    /** ISO-8601 UTC expiry instant (canonical TEXT, §4). */
    expiresAt: text('expires_at').notNull(),
    /** Active organization id (soft FK → agent_registry_organization.id). */
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
  (table) => [index('idx_agent_registry_sessions_user_id').on(table.userId)],
);

/**
 * `agent_registry_verifications` — cloud-sync email/2FA verification tokens. Bare
 * `verifications` → `agent_registry_verifications`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const agentRegistryVerifications = sqliteTable(
  'agent_registry_verifications',
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
  (table) => [index('idx_agent_registry_verifications_identifier').on(table.identifier)],
);

// ---------------------------------------------------------------------------
// Cloud-sync: org agent keys
// ---------------------------------------------------------------------------

/**
 * `agent_registry_org_agent_keys` — org-scoped agent API keys (cloud use; zero rows
 * locally). Bare `org_agent_keys` → `agent_registry_org_agent_keys`.
 *
 * @task T11361 (target shape) · T346 (original)
 */
export const agentRegistryOrgAgentKeys = sqliteTable(
  'agent_registry_org_agent_keys',
  {
    /** Key row id. Primary key. */
    id: text('id').primaryKey().notNull(),
    /** Owning organization (intra-domain FK → agent_registry_organization.id). */
    organizationId: text('organization_id')
      .notNull()
      .references(() => agentRegistryOrganization.id, { onDelete: 'cascade' }),
    /** Scoped agent (intra-domain FK → agent_registry_agents.id). */
    agentId: text('agent_id')
      .notNull()
      .references(() => agentRegistryAgents.id, { onDelete: 'cascade' }),
    /** Creator user id. */
    createdBy: text('created_by').notNull(),
    /** ISO-8601 UTC creation instant (E10 §4: epoch → TEXT ISO8601). */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_agent_registry_org_agent_keys_org').on(table.organizationId),
    index('idx_agent_registry_org_agent_keys_agent').on(table.agentId),
  ],
);

// ---------------------------------------------------------------------------
// Inferred row + insert types
// ---------------------------------------------------------------------------

/** Row type for `agent_registry_users` SELECT (target shape). */
export type AgentRegistryUserRow = typeof agentRegistryUsers.$inferSelect;
/** Row type for `agent_registry_users` INSERT (target shape). */
export type NewAgentRegistryUserRow = typeof agentRegistryUsers.$inferInsert;
/** Row type for `agent_registry_organization` SELECT (target shape). */
export type AgentRegistryOrganizationRow = typeof agentRegistryOrganization.$inferSelect;
/** Row type for `agent_registry_organization` INSERT (target shape). */
export type NewAgentRegistryOrganizationRow = typeof agentRegistryOrganization.$inferInsert;
/** Row type for `agent_registry_agents` SELECT (target shape). */
export type AgentRegistryAgentRow = typeof agentRegistryAgents.$inferSelect;
/** Row type for `agent_registry_agents` INSERT (target shape). */
export type NewAgentRegistryAgentRow = typeof agentRegistryAgents.$inferInsert;
/** Row type for `agent_registry_claim_codes` SELECT (target shape). */
export type AgentRegistryClaimCodeRow = typeof agentRegistryClaimCodes.$inferSelect;
/** Row type for `agent_registry_claim_codes` INSERT (target shape). */
export type NewAgentRegistryClaimCodeRow = typeof agentRegistryClaimCodes.$inferInsert;
/** Row type for `agent_registry_capabilities` SELECT (target shape). */
export type AgentRegistryCapabilityRow = typeof agentRegistryCapabilities.$inferSelect;
/** Row type for `agent_registry_capabilities` INSERT (target shape). */
export type NewAgentRegistryCapabilityRow = typeof agentRegistryCapabilities.$inferInsert;
/** Row type for `agent_registry_skills` SELECT (target shape). */
export type AgentRegistrySkillRow = typeof agentRegistrySkills.$inferSelect;
/** Row type for `agent_registry_skills` INSERT (target shape). */
export type NewAgentRegistrySkillRow = typeof agentRegistrySkills.$inferInsert;
/** Row type for `agent_registry_agent_capabilities` SELECT (target shape). */
export type AgentRegistryAgentCapabilityRow = typeof agentRegistryAgentCapabilities.$inferSelect;
/** Row type for `agent_registry_agent_capabilities` INSERT (target shape). */
export type NewAgentRegistryAgentCapabilityRow = typeof agentRegistryAgentCapabilities.$inferInsert;
/** Row type for `agent_registry_agent_skills` SELECT (target shape). */
export type AgentRegistryAgentSkillRow = typeof agentRegistryAgentSkills.$inferSelect;
/** Row type for `agent_registry_agent_skills` INSERT (target shape). */
export type NewAgentRegistryAgentSkillRow = typeof agentRegistryAgentSkills.$inferInsert;
/** Row type for `agent_registry_agent_connections` SELECT (target shape). */
export type AgentRegistryAgentConnectionRow = typeof agentRegistryAgentConnections.$inferSelect;
/** Row type for `agent_registry_agent_connections` INSERT (target shape). */
export type NewAgentRegistryAgentConnectionRow = typeof agentRegistryAgentConnections.$inferInsert;
/** Row type for `agent_registry_accounts` SELECT (target shape). */
export type AgentRegistryAccountRow = typeof agentRegistryAccounts.$inferSelect;
/** Row type for `agent_registry_accounts` INSERT (target shape). */
export type NewAgentRegistryAccountRow = typeof agentRegistryAccounts.$inferInsert;
/** Row type for `agent_registry_sessions` SELECT (target shape). */
export type AgentRegistrySessionRow = typeof agentRegistrySessions.$inferSelect;
/** Row type for `agent_registry_sessions` INSERT (target shape). */
export type NewAgentRegistrySessionRow = typeof agentRegistrySessions.$inferInsert;
/** Row type for `agent_registry_verifications` SELECT (target shape). */
export type AgentRegistryVerificationRow = typeof agentRegistryVerifications.$inferSelect;
/** Row type for `agent_registry_verifications` INSERT (target shape). */
export type NewAgentRegistryVerificationRow = typeof agentRegistryVerifications.$inferInsert;
/** Row type for `agent_registry_org_agent_keys` SELECT (target shape). */
export type AgentRegistryOrgAgentKeyRow = typeof agentRegistryOrgAgentKeys.$inferSelect;
/** Row type for `agent_registry_org_agent_keys` INSERT (target shape). */
export type NewAgentRegistryOrgAgentKeyRow = typeof agentRegistryOrgAgentKeys.$inferInsert;
