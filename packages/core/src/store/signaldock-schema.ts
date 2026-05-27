/**
 * Drizzle ORM schema for CLEO signaldock.db (global-tier agent identity database).
 *
 * Reverse-engineered from GLOBAL_EMBEDDED_MIGRATIONS in signaldock-sqlite.ts
 * (initial migration + T897 v3 column additions). Replaces the bare-SQL
 * bootstrap so drizzle-kit generate / check can operate on this database.
 *
 * Tables:
 *   - users              — Cloud-sync user accounts (zero rows in pure-local mode)
 *   - organization       — Cloud-sync org/team records
 *   - agents             — Global identity: canonical agent registry (cross-project)
 *   - claim_codes        — One-time agent claim tokens (api.signaldock.io provisioning)
 *   - capabilities       — Pre-seeded capability slug catalog
 *   - skills             — Pre-seeded skill slug catalog
 *   - agent_capabilities — Junction: agent <-> capability
 *   - agent_skills       — Junction: agent <-> skill
 *   - agent_connections  — Live transport connection tracking (heartbeat state)
 *   - accounts           — Cloud-sync OAuth/provider accounts
 *   - sessions           — Cloud-sync authenticated sessions
 *   - verifications      — Cloud-sync email/2FA verification tokens
 *   - org_agent_keys     — Org-scoped agent API keys (cloud use; zero rows locally)
 *
 * Post-T897 columns on `agents`:
 *   tier, can_spawn, orch_level, reports_to, cant_path, cant_sha256,
 *   installed_from, installed_at
 *
 * Post-T897 columns on `agent_skills`:
 *   source, attached_at
 *
 * Global-tier ONLY. This schema MUST NOT include tables from conduit.db
 * (project-local messaging: conversations, messages, delivery_jobs, dead_letters).
 *
 * @task T1166
 * @epic T1150
 * @related ADR-037 (signaldock/conduit split)
 * @related T310 (global identity tier)
 * @related T897 (agent registry v3)
 */

import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// Cloud-sync tables
// ---------------------------------------------------------------------------

/**
 * Cloud-sync: user accounts.
 * Zero rows in pure-local mode. Populated only when connected to
 * api.signaldock.io cloud services.
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    name: text('name'),
    slug: text('slug'),
    defaultAgentId: text('default_agent_id'),
    username: text('username'),
    displayUsername: text('display_username'),
    emailVerified: integer('email_verified').notNull().default(0),
    image: text('image'),
    role: text('role').notNull().default('user'),
    banned: integer('banned').notNull().default(0),
    banReason: text('ban_reason'),
    banExpires: text('ban_expires'),
    twoFactorEnabled: integer('two_factor_enabled').notNull().default(0),
    metadata: text('metadata'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('idx_users_slug').on(table.slug)],
);

/**
 * Cloud-sync: organization/team records.
 * Zero rows in pure-local mode.
 */
export const organization = sqliteTable(
  'organization',
  {
    id: text('id').primaryKey().notNull(),
    name: text('name').notNull(),
    slug: text('slug'),
    logo: text('logo'),
    metadata: text('metadata'),
    ownerId: text('owner_id'),
    createdAt: integer('created_at').notNull().default(sql`(strftime('%s','now'))`),
    updatedAt: integer('updated_at').notNull().default(sql`(strftime('%s','now'))`),
  },
  (table) => [index('idx_organization_slug').on(table.slug)],
);

// ---------------------------------------------------------------------------
// Global identity: agent registry
// ---------------------------------------------------------------------------

/**
 * Global identity: canonical agent registry (cross-project).
 *
 * `api_key_encrypted` uses KDF: HMAC-SHA256(machine-key || global-salt, agentId) — ADR-037 §5.
 * `requires_reauth` = 1 is set during T310 migration for all pre-existing agents.
 *
 * T897 v3 columns: tier, can_spawn, orch_level, reports_to, cant_path, cant_sha256,
 * installed_from, installed_at.
 *
 * @task T346
 * @task T897
 * @epic T310
 */
export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    class: text('class').notNull().default('custom'),
    privacyTier: text('privacy_tier').notNull().default('public'),
    ownerId: text('owner_id').references(() => users.id),
    endpoint: text('endpoint'),
    webhookSecret: text('webhook_secret'),
    capabilities: text('capabilities').notNull().default('[]'),
    skills: text('skills').notNull().default('[]'),
    avatar: text('avatar'),
    messagesSent: integer('messages_sent').notNull().default(0),
    messagesReceived: integer('messages_received').notNull().default(0),
    conversationCount: integer('conversation_count').notNull().default(0),
    friendCount: integer('friend_count').notNull().default(0),
    status: text('status').notNull().default('online'),
    lastSeen: integer('last_seen'),
    paymentConfig: text('payment_config'),
    apiKeyHash: text('api_key_hash'),
    organizationId: text('organization_id').references(() => organization.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    transportType: text('transport_type').notNull().default('http'),
    apiKeyEncrypted: text('api_key_encrypted'),
    apiBaseUrl: text('api_base_url').notNull().default('https://api.signaldock.io'),
    classification: text('classification'),
    transportConfig: text('transport_config').notNull().default('{}'),
    isActive: integer('is_active').notNull().default(1),
    lastUsedAt: integer('last_used_at'),
    requiresReauth: integer('requires_reauth').notNull().default(0),
    // T897 v3 columns
    /** Tier taxonomy from ADR-044: project, global, packaged, fallback. */
    tier: text('tier').notNull().default('global'),
    /** Whether this agent is permitted to spawn sub-agents. */
    canSpawn: integer('can_spawn').notNull().default(0),
    /** Orchestration level: 0=worker, 1=lead, 2=orchestrator. */
    orchLevel: integer('orch_level').notNull().default(2),
    /** Agent ID this agent reports to (parent in hierarchy). */
    reportsTo: text('reports_to'),
    /** Absolute path to the agent's .cant definition file. */
    cantPath: text('cant_path'),
    /** SHA-256 checksum of the .cant file at install time. */
    cantSha256: text('cant_sha256'),
    /** Installation provenance: seed, user, manual. */
    installedFrom: text('installed_from'),
    /** ISO 8601 timestamp when the agent was installed. */
    installedAt: text('installed_at'),
  },
  (table) => [
    index('agents_owner_idx').on(table.ownerId),
    index('agents_class_idx').on(table.class),
    index('agents_privacy_idx').on(table.privacyTier),
    index('agents_org_idx').on(table.organizationId),
    index('idx_agents_transport_type').on(table.transportType),
    index('idx_agents_is_active').on(table.isActive),
    index('idx_agents_last_used').on(table.lastUsedAt),
    // Partial index: only rows where requires_reauth = 1.
    // NOTE: drizzle-orm sqlite-core does not directly support WHERE on index.
    // The partial index is created by the migration SQL but omitted from the
    // schema definition (drizzle does not generate WHERE clauses for indexes).
    // T897 indexes:
    index('idx_agents_tier').on(table.tier),
    index('idx_agents_cant_path').on(table.cantPath),
  ],
);

// ---------------------------------------------------------------------------
// Cloud-sync: claim codes
// ---------------------------------------------------------------------------

/**
 * Cloud-sync: one-time agent claim tokens (api.signaldock.io provisioning).
 */
export const claimCodes = sqliteTable(
  'claim_codes',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    code: text('code').notNull().unique(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    usedBy: text('used_by').references(() => users.id),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('claim_codes_agent_idx').on(table.agentId)],
);

// ---------------------------------------------------------------------------
// Identity catalog
// ---------------------------------------------------------------------------

/**
 * Identity catalog: pre-seeded capability slugs (19 entries).
 */
export const capabilities = sqliteTable('capabilities', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * Identity catalog: pre-seeded skill slugs (36 entries).
 */
export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  createdAt: integer('created_at').notNull(),
});

// ---------------------------------------------------------------------------
// Junction tables
// ---------------------------------------------------------------------------

/**
 * Junction: agent <-> capability catalog bindings.
 */
export const agentCapabilities = sqliteTable(
  'agent_capabilities',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    capabilityId: text('capability_id')
      .notNull()
      .references(() => capabilities.id),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.capabilityId] })],
);

/**
 * Junction: agent <-> skill catalog bindings.
 *
 * T897 v3 columns: source, attached_at.
 *
 * @task T897
 */
export const agentSkills = sqliteTable(
  'agent_skills',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id),
    /** Skill attachment provenance: cant, manual, computed. */
    source: text('source').notNull().default('manual'),
    /** ISO 8601 timestamp when the skill was attached to this agent. */
    attachedAt: text('attached_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.skillId] }),
    index('idx_agent_skills_source').on(table.source),
  ],
);

// ---------------------------------------------------------------------------
// Agent connections
// ---------------------------------------------------------------------------

/**
 * Live transport connection tracking (heartbeat state).
 */
export const agentConnections = sqliteTable(
  'agent_connections',
  {
    id: text('id').primaryKey().notNull(),
    agentId: text('agent_id').notNull(),
    transportType: text('transport_type').notNull().default('http'),
    connectionId: text('connection_id'),
    connectedAt: integer('connected_at').notNull(),
    lastHeartbeat: integer('last_heartbeat').notNull(),
    connectionMetadata: text('connection_metadata'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_agent_connections_agent').on(table.agentId),
    index('idx_agent_connections_transport').on(table.transportType),
    index('idx_agent_connections_heartbeat').on(table.lastHeartbeat),
    unique().on(table.agentId, table.connectionId),
  ],
);

// ---------------------------------------------------------------------------
// Cloud-sync: OAuth, sessions, verifications
// ---------------------------------------------------------------------------

/**
 * Cloud-sync: OAuth/provider accounts.
 */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: text('access_token_expires_at'),
    refreshTokenExpiresAt: text('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_accounts_user_id').on(table.userId),
    unique('idx_accounts_provider').on(table.providerId, table.accountId),
  ],
);

/**
 * Cloud-sync: authenticated sessions.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    expiresAt: text('expires_at').notNull(),
    activeOrganizationId: text('active_organization_id'),
    impersonatedBy: text('impersonated_by'),
    active: integer('active').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_sessions_user_id').on(table.userId)],
);

/**
 * Cloud-sync: email/2FA verification tokens.
 */
export const verifications = sqliteTable(
  'verifications',
  {
    id: text('id').primaryKey().notNull(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_verifications_identifier').on(table.identifier)],
);

// ---------------------------------------------------------------------------
// Cloud-sync: org agent keys
// ---------------------------------------------------------------------------

/**
 * Org-scoped agent API keys (cloud use; zero rows locally).
 */
export const orgAgentKeys = sqliteTable(
  'org_agent_keys',
  {
    id: text('id').primaryKey().notNull(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('org_agent_keys_org_idx').on(table.organizationId),
    index('org_agent_keys_agent_idx').on(table.agentId),
  ],
);

// ---------------------------------------------------------------------------
// Re-export types for downstream use
// ---------------------------------------------------------------------------

/** Row type for the `users` table. */
export type User = typeof users.$inferSelect;
/** Insert type for the `users` table. */
export type NewUser = typeof users.$inferInsert;

/** Row type for the `organization` table. */
export type Organization = typeof organization.$inferSelect;
/** Insert type for the `organization` table. */
export type NewOrganization = typeof organization.$inferInsert;

/** Row type for the `agents` table. */
export type Agent = typeof agents.$inferSelect;
/** Insert type for the `agents` table. */
export type NewAgent = typeof agents.$inferInsert;

/** Row type for the `capabilities` table. */
export type Capability = typeof capabilities.$inferSelect;

/** Row type for the `skills` table. */
export type Skill = typeof skills.$inferSelect;

/** Row type for the `agentConnections` table. */
export type AgentConnection = typeof agentConnections.$inferSelect;
/** Insert type for the `agentConnections` table. */
export type NewAgentConnection = typeof agentConnections.$inferInsert;
