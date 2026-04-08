---
task: T328
epic: T310
type: specification
pipeline_stage: specification
feeds_into: [T310-decomposition, T310-implementation]
depends_on: [T326, T327]
related_adr: ADR-037
created: 2026-04-08
---

# T310 Specification: Conduit + Signaldock Technical Contracts

> Formalizes ADR-037 into testable contracts. Every DDL statement,
> function signature, and CLI flag here is a contract the implementation
> phase must honor.

---

## 1. Scope

### In scope (v2026.4.12)

- Project-tier rename: `.cleo/signaldock.db` → `.cleo/conduit.db`
- Module rename: `signaldock-sqlite.ts` → `conduit-sqlite.ts`
- New global-tier `$XDG_DATA_HOME/cleo/signaldock.db` schema + file creation
- New `project_agent_refs` override table in conduit.db (ADR-037 §3)
- New global-salt file at `$XDG_DATA_HOME/cleo/global-salt`
- New KDF: `HMAC-SHA256(machine-key || global-salt, agentId)` (ADR-037 §5)
- Automatic first-run migration from signaldock.db → conduit.db + global signaldock.db (ADR-037 §8)
- Accessor layer refactor: cross-DB reads (INNER JOIN project_agent_refs + global agents), split writes
- CLI changes: `cleo agent attach`, `cleo agent detach`, `cleo agent remove --global`, `cleo agent list --global`
- Backup registry extended: project tier adds conduit.db; global tier adds signaldock.db + global-salt file copy
- Unit tests (per-module) and integration tests (cross-project lifecycle)

### Out of scope (deferred)

- Cloud-sync protocol implementation (schema tables preserved per ADR-037 §2, but sync logic is a separate epic)
- Global message bus (LocalTransport stays project-scoped per ADR-037 §7 / Q7=A)
- Cross-machine backup portability (T311 epic)
- Schema slimming of cloud-only tables (future epic; Q2=C keeps them per ADR-037 §2)
- `cleo agent remove --global` cross-project scan via filesystem walk (scan is best-effort; `--force` available per ADR-037 §6)

---

## 2. Database Schemas

### 2.1 Project-tier: `.cleo/conduit.db`

**Purpose**: Per-project messaging state and project-local agent reference overrides.
Replaces the project-tier role of `.cleo/signaldock.db`.

All tables in this section carry over from the existing signaldock-sqlite.ts embedded migrations
(migration `2026-03-28-000000_initial` and subsequent migrations), with the following changes:
- Identity tables (agents, capabilities, skills, agent_capabilities, agent_skills, agent_connections,
  users, organization, accounts, sessions, verifications, claim_codes, org_agent_keys) are NOT
  included — they move to global tier (Section 2.2).
- `project_agent_refs` is a new table (see below).

**Typical row counts**: messages ~4–1000 (project DMs), conversations ~1–200, project_agent_refs ~1–20.
**Access pattern**: write-heavy for messages during active agent sessions; read-heavy for project_agent_refs.

```sql
-- conduit.db initial migration: 2026-04-12-000000_initial_conduit
-- All tables use CREATE TABLE IF NOT EXISTS for idempotency.

-- Project-scoped conversations (LocalTransport DM threads).
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    participants TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    message_count INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Project-scoped agent-to-agent messages (LocalTransport content).
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text',
    status TEXT NOT NULL DEFAULT 'pending',
    attachments TEXT NOT NULL DEFAULT '[]',
    group_id TEXT,
    metadata TEXT DEFAULT '{}',
    reply_to TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    read_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS messages_from_agent_idx ON messages(from_agent_id);
CREATE INDEX IF NOT EXISTS messages_to_agent_idx ON messages(to_agent_id);
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL;

-- FTS5 virtual table for full-text search on message content.
-- NOTE: Must be migrated using VACUUM INTO, not DDL-only copy, to preserve triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(content, from_agent_id, content='messages', content_rowid='rowid');
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, from_agent_id)
        VALUES (new.rowid, new.content, new.from_agent_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, from_agent_id)
        VALUES('delete', old.rowid, old.content, old.from_agent_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, from_agent_id)
        VALUES('delete', old.rowid, old.content, old.from_agent_id);
    INSERT INTO messages_fts(rowid, content, from_agent_id)
        VALUES (new.rowid, new.content, new.from_agent_id);
END;

-- Async delivery queue for deferred message dispatch.
CREATE TABLE IF NOT EXISTS delivery_jobs (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 6,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_jobs_status ON delivery_jobs(status, next_attempt_at);

-- Dead-letter queue for messages that exceeded max delivery attempts.
CREATE TABLE IF NOT EXISTS dead_letters (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dead_letters_message ON dead_letters(message_id);

-- Pinned messages within a conversation.
CREATE TABLE IF NOT EXISTS message_pins (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    pinned_by TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(message_id, pinned_by)
);
CREATE INDEX IF NOT EXISTS idx_pins_conversation ON message_pins(conversation_id);
CREATE INDEX IF NOT EXISTS idx_pins_agent ON message_pins(pinned_by);

-- File/blob attachments associated with messages.
CREATE TABLE IF NOT EXISTS attachments (
    slug TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    content BLOB NOT NULL,
    original_size INTEGER NOT NULL,
    compressed_size INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'text',
    title TEXT,
    tokens INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL DEFAULT 0,
    storage_key TEXT,
    mode TEXT NOT NULL DEFAULT 'draft',
    version_count INTEGER NOT NULL DEFAULT 1,
    current_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_conversation_idx ON attachments(conversation_id);
CREATE INDEX IF NOT EXISTS attachments_agent_idx ON attachments(from_agent_id);

-- Version history for attachments (collaborative editing).
CREATE TABLE IF NOT EXISTS attachment_versions (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    author_agent_id TEXT NOT NULL,
    change_type TEXT NOT NULL DEFAULT 'patch',
    patch_text TEXT,
    storage_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    original_size INTEGER NOT NULL,
    compressed_size INTEGER NOT NULL,
    tokens INTEGER NOT NULL,
    change_summary TEXT,
    sections_modified TEXT NOT NULL DEFAULT '[]',
    tokens_added INTEGER NOT NULL DEFAULT 0,
    tokens_removed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(slug, version_number)
);
CREATE INDEX IF NOT EXISTS idx_attachment_versions_slug ON attachment_versions(slug);
CREATE INDEX IF NOT EXISTS idx_attachment_versions_author ON attachment_versions(author_agent_id);

-- Approval records for attachment content review.
CREATE TABLE IF NOT EXISTS attachment_approvals (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    reviewer_agent_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    comment TEXT,
    version_reviewed INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(slug, reviewer_agent_id)
);
CREATE INDEX IF NOT EXISTS idx_attachment_approvals_slug ON attachment_approvals(slug);

-- Contributor statistics per attachment (who edited, how much).
CREATE TABLE IF NOT EXISTS attachment_contributors (
    slug TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    version_count INTEGER NOT NULL DEFAULT 0,
    total_tokens_added INTEGER NOT NULL DEFAULT 0,
    total_tokens_removed INTEGER NOT NULL DEFAULT 0,
    first_contribution_at INTEGER NOT NULL,
    last_contribution_at INTEGER NOT NULL,
    PRIMARY KEY (slug, agent_id)
);

-- NEW TABLE (ADR-037 §3, Q6=A): Per-project agent reference overrides.
-- agent_id is a soft FK to global signaldock.db:agents.agent_id.
-- Cross-DB FK enforcement is not possible in SQLite; the accessor layer validates
-- on every cross-DB join (see Section 3.5).
CREATE TABLE IF NOT EXISTS project_agent_refs (
    agent_id TEXT PRIMARY KEY,
    attached_at TEXT NOT NULL,
    role TEXT,
    capabilities_override TEXT,
    last_used_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
);
-- Partial index: covers the dominant query path (list enabled agents).
CREATE INDEX IF NOT EXISTS idx_project_agent_refs_enabled
    ON project_agent_refs(enabled) WHERE enabled = 1;

-- Schema tracking tables (mirror the pattern from signaldock-sqlite.ts).
CREATE TABLE IF NOT EXISTS _conduit_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE TABLE IF NOT EXISTS _conduit_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
```

**project_agent_refs column semantics** (ADR-037 §3):

| Column | Type | Semantics |
|---|---|---|
| `agent_id` | TEXT PK | Soft FK to `global signaldock.db:agents.agent_id`. Accessor validates on every cross-DB join. |
| `attached_at` | TEXT | ISO-8601 timestamp when `cleo agent attach` created this row. |
| `role` | TEXT nullable | Project-specific role override. Overrides global agent's default `class` for this project context. |
| `capabilities_override` | TEXT nullable | JSON blob for per-project capability tweaks. Merged with global capabilities by the accessor layer. |
| `last_used_at` | TEXT nullable | ISO-8601 project-local activity tracking. Updated by `AgentRegistryAccessor.markUsed()`. |
| `enabled` | INTEGER | `1` = active in this project; `0` = detached (row retained for audit trail). |

### 2.2 Global-tier: `$XDG_DATA_HOME/cleo/signaldock.db`

**Purpose**: Canonical cross-project agent identity, capabilities catalog, and cloud-sync tables.
Lives at `getCleoHome()/signaldock.db` (e.g. `~/.local/share/cleo/signaldock.db` on Linux).

**Typical row counts**: agents ~2–50 per machine, capabilities ~19 (pre-seeded), skills ~36 (pre-seeded).
**Access pattern**: read-heavy for agent identity lookup; write on registration and auth changes.

```sql
-- global signaldock.db initial migration: 2026-04-12-000000_initial_global_signaldock

-- Cloud-sync: user accounts (zero rows in pure-local mode; preserved for api.signaldock.io sync).
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    slug TEXT,
    default_agent_id TEXT,
    username TEXT,
    display_username TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    banned INTEGER NOT NULL DEFAULT 0,
    ban_reason TEXT,
    ban_expires TEXT,
    two_factor_enabled INTEGER NOT NULL DEFAULT 0,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slug ON users(slug);

-- Cloud-sync: organization/team records.
CREATE TABLE IF NOT EXISTS organization (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    slug TEXT,
    logo TEXT,
    metadata TEXT,
    owner_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_slug ON organization(slug);

-- Global identity: canonical agent registry (cross-project).
-- api_key_encrypted uses KDF: HMAC-SHA256(machine-key || global-salt, agentId) — ADR-037 §5.
-- requires_reauth=1 is set during T310 migration for all pre-existing agents.
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    class TEXT NOT NULL DEFAULT 'custom',
    privacy_tier TEXT NOT NULL DEFAULT 'public',
    owner_id TEXT REFERENCES users(id),
    endpoint TEXT,
    webhook_secret TEXT,
    capabilities TEXT NOT NULL DEFAULT '[]',
    skills TEXT NOT NULL DEFAULT '[]',
    avatar TEXT,
    messages_sent INTEGER NOT NULL DEFAULT 0,
    messages_received INTEGER NOT NULL DEFAULT 0,
    conversation_count INTEGER NOT NULL DEFAULT 0,
    friend_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'online',
    last_seen INTEGER,
    payment_config TEXT,
    api_key_hash TEXT,
    organization_id TEXT REFERENCES organization(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    transport_type TEXT NOT NULL DEFAULT 'http',
    api_key_encrypted TEXT,
    api_base_url TEXT NOT NULL DEFAULT 'https://api.signaldock.io',
    classification TEXT,
    transport_config TEXT NOT NULL DEFAULT '{}',
    is_active INTEGER NOT NULL DEFAULT 1,
    last_used_at INTEGER,
    requires_reauth INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_agent_id_idx ON agents(agent_id);
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents(owner_id);
CREATE INDEX IF NOT EXISTS agents_class_idx ON agents(class);
CREATE INDEX IF NOT EXISTS agents_privacy_idx ON agents(privacy_tier);
CREATE INDEX IF NOT EXISTS agents_org_idx ON agents(organization_id);
CREATE INDEX IF NOT EXISTS idx_agents_transport_type ON agents(transport_type);
CREATE INDEX IF NOT EXISTS idx_agents_is_active ON agents(is_active);
CREATE INDEX IF NOT EXISTS idx_agents_last_used ON agents(last_used_at);
CREATE INDEX IF NOT EXISTS idx_agents_reauth ON agents(requires_reauth) WHERE requires_reauth = 1;

-- Cloud-sync: one-time agent claim tokens (api.signaldock.io provisioning).
CREATE TABLE IF NOT EXISTS claim_codes (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    code TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS claim_codes_code_idx ON claim_codes(code);
CREATE INDEX IF NOT EXISTS claim_codes_agent_idx ON claim_codes(agent_id);

-- Identity catalog: pre-seeded capability slugs (19 entries).
CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Identity catalog: pre-seeded skill slugs (36 entries).
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Junction: agent ↔ capability catalog bindings.
CREATE TABLE IF NOT EXISTS agent_capabilities (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    capability_id TEXT NOT NULL REFERENCES capabilities(id),
    PRIMARY KEY (agent_id, capability_id)
);

-- Junction: agent ↔ skills catalog bindings.
CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    skill_id TEXT NOT NULL REFERENCES skills(id),
    PRIMARY KEY (agent_id, skill_id)
);

-- Live transport connection tracking (heartbeat state).
CREATE TABLE IF NOT EXISTS agent_connections (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL,
    transport_type TEXT NOT NULL DEFAULT 'http',
    connection_id TEXT,
    connected_at BIGINT NOT NULL,
    last_heartbeat BIGINT NOT NULL,
    connection_metadata TEXT,
    created_at BIGINT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
    UNIQUE(agent_id, connection_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_connections_agent ON agent_connections(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_connections_transport ON agent_connections(transport_type);
CREATE INDEX IF NOT EXISTS idx_agent_connections_heartbeat ON agent_connections(last_heartbeat);

-- Cloud-sync: OAuth/provider accounts.
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,
    access_token_expires_at TEXT,
    refresh_token_expires_at TEXT,
    scope TEXT,
    password TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider_id, account_id);

-- Cloud-sync: authenticated sessions.
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    ip_address TEXT,
    user_agent TEXT,
    expires_at TEXT NOT NULL,
    active_organization_id TEXT,
    impersonated_by TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- Cloud-sync: email/2FA verification tokens.
CREATE TABLE IF NOT EXISTS verifications (
    id TEXT PRIMARY KEY NOT NULL,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verifications_identifier ON verifications(identifier);

-- Org-scoped agent API keys (cloud use; zero rows locally).
CREATE TABLE IF NOT EXISTS org_agent_keys (
    id TEXT PRIMARY KEY NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS org_agent_keys_org_idx ON org_agent_keys(organization_id);
CREATE INDEX IF NOT EXISTS org_agent_keys_agent_idx ON org_agent_keys(agent_id);

-- Schema tracking.
CREATE TABLE IF NOT EXISTS _signaldock_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE TABLE IF NOT EXISTS _signaldock_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
```

### 2.3 Global-tier: `$XDG_DATA_HOME/cleo/global-salt`

```
File:        $XDG_DATA_HOME/cleo/global-salt
             (resolved via getCleoHome() + '/global-salt')
Type:        binary
Size:        32 bytes (exactly)
Permissions: 0o600 (owner read-write only; enforced on write and checked on read)
Content:     crypto.randomBytes(32) — generated ONCE on first post-migration cleo invocation
Lifecycle:
  - Generated on first call to getGlobalSalt() if the file does not exist
  - Written atomically: tmp file → fsync → rename to final path → chmod 0o600
  - Never overwritten automatically (overwrite = full API key invalidation event)
  - Backed up only with --scope global (T311 epic); see Section 6.2
  - If deleted or corrupted, all api_key_encrypted values in global signaldock.db
    become undecryptable; agents must re-authenticate (accepted risk per ADR-037 §5)
Fingerprint: first 4 bytes (hex) logged once at INFO level on cleo startup
```

---

## 3. API Contracts

### 3.1 conduit-sqlite.ts (new module, replaces project-tier role of signaldock-sqlite.ts)

```typescript
// File: packages/core/src/store/conduit-sqlite.ts

import type { DatabaseSync } from 'node:sqlite';

/** Database file name within .cleo/ directory. */
export const CONDUIT_DB_FILENAME = 'conduit.db';

/** Schema version for conduit databases. */
export const CONDUIT_SCHEMA_VERSION = '2026.4.12';

/**
 * Returns the project-tier conduit.db path.
 * Resolves to `<projectRoot>/.cleo/conduit.db` using getCleoDirAbsolute().
 *
 * @param cwd - Optional working directory; defaults to process.cwd()
 */
export function getConduitDbPath(cwd?: string): string;

/**
 * Ensure conduit.db exists at the project tier with the full schema applied.
 * Idempotent — safe to call multiple times.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Object with action ('created' | 'exists') and the database path
 */
export async function ensureConduitDb(
    cwd?: string
): Promise<{ action: 'created' | 'exists'; path: string }>;

/**
 * Check conduit.db health: table count, WAL mode, schema version.
 * Used by `cleo doctor` to verify conduit.db integrity.
 *
 * @returns Health report or null-equivalent if DB does not exist
 */
export async function checkConduitDbHealth(cwd?: string): Promise<{
    exists: boolean;
    path: string;
    tableCount: number;
    walMode: boolean;
    schemaVersion: string | null;
    foreignKeysEnabled: boolean;
} | null>;

// project_agent_refs table accessors

/**
 * Attach a globally-registered agent to the current project.
 * Creates a project_agent_refs row with enabled=1.
 * If the row already exists with enabled=0, re-enables it instead of inserting.
 *
 * @throws Error with code E_NOT_FOUND if agentId does not exist in global signaldock.db
 */
export function attachAgentToProject(
    db: DatabaseSync,
    agentId: string,
    opts?: { role?: string; capabilitiesOverride?: string }
): void;

/**
 * Detach an agent from the current project.
 * Sets project_agent_refs.enabled=0 (row retained for audit; global identity untouched).
 * No-op if the row does not exist.
 */
export function detachAgentFromProject(db: DatabaseSync, agentId: string): void;

/**
 * List all project_agent_refs rows.
 *
 * @param opts.enabledOnly - When true (default), filters to enabled=1 rows only
 */
export function listProjectAgentRefs(
    db: DatabaseSync,
    opts?: { enabledOnly?: boolean }
): ProjectAgentRef[];

/**
 * Get a single project_agent_refs row by agentId.
 * Returns null if the agent is not referenced in this project.
 */
export function getProjectAgentRef(
    db: DatabaseSync,
    agentId: string
): ProjectAgentRef | null;

/**
 * Update last_used_at for a project_agent_refs row (ISO-8601 timestamp).
 * No-op if the row does not exist.
 */
export function updateProjectAgentLastUsed(db: DatabaseSync, agentId: string): void;
```

**ProjectAgentRef type** (MUST be defined in `packages/contracts/src/`; do not inline):

```typescript
// File: packages/contracts/src/agent.ts (extend existing file)

/** A per-project agent reference row from conduit.db:project_agent_refs. */
export interface ProjectAgentRef {
    /** Soft FK to global signaldock.db:agents.agent_id. */
    agentId: string;
    /** ISO-8601 timestamp when this agent was attached to the project. */
    attachedAt: string;
    /** Project-specific role override; null means use global agent class. */
    role: string | null;
    /** JSON string of per-project capability overrides; null means use global. */
    capabilitiesOverride: string | null;
    /** ISO-8601 timestamp of last project-local activity; null if never used. */
    lastUsedAt: string | null;
    /** Whether the agent is active in this project. */
    enabled: boolean;
}

/** An agent record merged from global signaldock.db:agents + conduit.db:project_agent_refs. */
export interface AgentWithProjectOverride extends AgentCredential {
    /** Per-project attachment metadata; null when queried with includeGlobal=true and not attached. */
    projectRef: ProjectAgentRef | null;
}
```

### 3.2 signaldock-sqlite.ts (refactored: global-tier only)

The existing file is refactored in-place — it is NOT deleted. All project-tier table DDL is
removed; only global-identity tables remain. The module's public API narrows to the global scope.

```typescript
// File: packages/core/src/store/signaldock-sqlite.ts (REFACTORED)

/** Database file name within the global cleo home directory. */
export const GLOBAL_SIGNALDOCK_DB_FILENAME = 'signaldock.db';

/** Schema version for global signaldock databases. */
export const GLOBAL_SIGNALDOCK_SCHEMA_VERSION = '2026.4.12';

/**
 * Returns the GLOBAL-tier signaldock.db path.
 * Resolves to getCleoHome() + '/signaldock.db'.
 * Guard: asserts resolved path starts with getCleoHome() (defense in depth).
 */
export function getGlobalSignaldockDbPath(): string;

/**
 * Ensure global signaldock.db exists with the full global schema applied.
 * Idempotent — safe to call multiple times.
 *
 * @returns Object with action ('created' | 'exists') and the database path
 */
export async function ensureGlobalSignaldockDb(): Promise<{
    action: 'created' | 'exists';
    path: string;
}>;

/**
 * Check global signaldock.db health: table count, WAL mode, schema version.
 * Used by `cleo doctor`.
 */
export async function checkGlobalSignaldockDbHealth(): Promise<{
    exists: boolean;
    path: string;
    tableCount: number;
    walMode: boolean;
    schemaVersion: string | null;
    foreignKeysEnabled: boolean;
} | null>;

// NOTE: getSignaldockDbPath (project-tier) is REMOVED from this file's exports.
// Existing callers in conduit/local-transport.ts and internal.ts must be updated
// to import getConduitDbPath from conduit-sqlite.ts instead.
// The re-export in packages/core/src/internal.ts must be updated accordingly.
```

### 3.3 global-salt.ts (new module)

```typescript
// File: packages/core/src/store/global-salt.ts

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getCleoHome } from '../paths.js';

/** Expected size of the global-salt file in bytes. */
export const GLOBAL_SALT_SIZE = 32;

/** Filename within getCleoHome(). */
export const GLOBAL_SALT_FILENAME = 'global-salt';

/**
 * Returns the absolute path to the global-salt file.
 * Equivalent to path.join(getCleoHome(), 'global-salt').
 */
export function getGlobalSaltPath(): string;

/**
 * Returns the 32-byte global salt Buffer.
 *
 * Behavior:
 *   - If the file does not exist: generates 32 random bytes, writes atomically
 *     with permissions 0o600, then returns the bytes.
 *   - If the file exists: reads and returns the bytes.
 *   - Memoizes the result in-process for the session lifetime (no repeated I/O
 *     on hot paths).
 *
 * Atomic write sequence:
 *   1. Write to a .tmp sibling file
 *   2. fsync the tmp file descriptor
 *   3. fs.renameSync(tmp, finalPath)
 *   4. fs.chmodSync(finalPath, 0o600)
 *
 * @throws Error if the file exists but cannot be read (e.g., wrong permissions)
 */
export function getGlobalSalt(): Buffer;

/**
 * Runtime integrity check for the global-salt file.
 * Called on startup after ensureGlobalSignaldockDb().
 *
 * Checks:
 *   - File exists (if not, defers to getGlobalSalt() to create it)
 *   - File size is exactly GLOBAL_SALT_SIZE bytes
 *   - File permissions are 0o600 on POSIX systems (skipped on Windows)
 *
 * @throws Error with descriptive message if any check fails
 */
export function validateGlobalSalt(): void;

/**
 * Clears the in-process memoized salt.
 * ONLY for use in test isolation — never call in production code.
 */
export function _clearGlobalSaltCache_TESTING_ONLY(): void;
```

### 3.4 api-key-kdf.ts (new module)

```typescript
// File: packages/core/src/store/api-key-kdf.ts

import crypto from 'node:crypto';

/**
 * Derive a 32-byte API key using the T310 global KDF.
 *
 * Algorithm: HMAC-SHA256(key=machineKey || globalSalt, message=agentId)
 *
 * Security properties (ADR-037 §5):
 *   - Machine-bound: machineKey differs per machine
 *   - Salt-isolated: globalSalt is machine-local; not copied cross-machine
 *   - Agent-bound: agentId as HMAC message ensures per-agent uniqueness
 *   - Three-factor: compromise of agentId alone cannot reconstruct the key
 *
 * @param opts.machineKey  - 32-byte machine-specific key from getCleoHome()/machine-key
 * @param opts.globalSalt  - 32-byte salt from getGlobalSalt()
 * @param opts.agentId     - Agent identifier string (business key, not UUID)
 * @returns 32-byte derived key Buffer
 */
export function deriveApiKey(opts: {
    machineKey: Buffer;
    globalSalt: Buffer;
    agentId: string;
}): Buffer;

/**
 * Decrypt an api_key_encrypted value stored using the LEGACY KDF.
 *
 * Legacy KDF: HMAC-SHA256(machineKey, projectPath) → AES-256-GCM key
 * (packages/core/src/crypto/credentials.ts::deriveProjectKey)
 *
 * Used exclusively in the T310 migration module to decrypt existing keys
 * before re-encrypting with the new KDF.
 *
 * @param opts.machineKey   - 32-byte machine key
 * @param opts.projectPath  - Absolute project path used as HMAC message in the old scheme
 * @returns 32-byte legacy derived key Buffer
 */
export function deriveLegacyProjectKey(opts: {
    machineKey: Buffer;
    projectPath: string;
}): Buffer;
```

### 3.5 agent-registry-accessor.ts (refactored)

The existing `AgentRegistryAccessor` class is refactored to perform cross-DB reads (INNER JOIN
conduit.db:project_agent_refs with global signaldock.db:agents) and split writes (identity data
to global, project-state to project_agent_refs). The constructor signature changes to accept an
explicit project root rather than a generic `projectPath`.

```typescript
// File: packages/core/src/store/agent-registry-accessor.ts (REFACTORED)

import type { AgentCredential, AgentListFilter, AgentRegistryAPI, AgentWithProjectOverride } from '@cleocode/contracts';

/**
 * Cross-DB agent lookup.
 *
 * Performs an INNER JOIN between conduit.db:project_agent_refs and
 * global signaldock.db:agents on agent_id. An agent with a global identity
 * but no project_agent_refs row (or enabled=0) is invisible by default.
 *
 * @param projectRoot      - Absolute path to the project root
 * @param agentId          - Agent business identifier
 * @param opts.includeGlobal - When true, returns global identity even without a project ref
 * @returns Merged agent record or null if not found
 */
export function lookupAgent(
    projectRoot: string,
    agentId: string,
    opts?: { includeGlobal?: boolean }
): AgentWithProjectOverride | null;

/**
 * Lists agents visible in the current project.
 *
 * Default: INNER JOIN conduit.db:project_agent_refs (enabled=1) with global agents.
 * includeGlobal=true: returns all global agents regardless of project_agent_refs.
 *
 * @param projectRoot             - Absolute path to the project root
 * @param opts.includeGlobal      - Include all global agents (bypasses project filter)
 * @param opts.includeDisabled    - Include agents with enabled=0 in project_agent_refs
 * @returns Array of merged agent records
 */
export function listAgentsForProject(
    projectRoot: string,
    opts?: { includeGlobal?: boolean; includeDisabled?: boolean }
): AgentWithProjectOverride[];

/**
 * Creates a new agent: writes identity to global signaldock.db AND attaches
 * to the current project via conduit.db:project_agent_refs.
 *
 * Write order: global first, then project ref. If the project ref write fails,
 * the global row remains (recoverable via `cleo agent attach <id>`).
 *
 * @param projectRoot - Absolute path to the project root
 * @param spec        - Agent creation spec (without createdAt/updatedAt)
 * @returns Merged agent record including the new project ref
 */
export function createProjectAgent(
    projectRoot: string,
    spec: Omit<AgentCredential, 'createdAt' | 'updatedAt'>
): AgentWithProjectOverride;

/** AgentRegistryAccessor class — backward-compatible wrapper around the above functions. */
export class AgentRegistryAccessor implements AgentRegistryAPI {
    /** @param projectPath - Absolute path to project root (passed as cwd or process.cwd()) */
    constructor(private readonly projectPath: string);

    /** Lists project-scoped agents (INNER JOIN, enabled=1 only). */
    list(filter?: AgentListFilter): Promise<AgentCredential[]>;

    /** Lists all global agents (no project filter). Exposed for --global CLI flag. */
    listGlobal(filter?: AgentListFilter): Promise<AgentCredential[]>;

    /** Get agent by agentId. Project-scoped by default; pass includeGlobal for global lookup. */
    get(agentId: string, opts?: { includeGlobal?: boolean }): Promise<AgentCredential | null>;

    /**
     * Register (create or update) an agent.
     * Writes identity to global signaldock.db; attaches to project via project_agent_refs.
     */
    register(credential: Omit<AgentCredential, 'createdAt' | 'updatedAt'>): Promise<AgentCredential>;

    /**
     * Update agent identity fields. Writes to global signaldock.db only.
     * Project-specific fields (role, capabilitiesOverride) use updateProjectRef().
     */
    update(agentId: string, updates: Partial<Omit<AgentCredential, 'agentId' | 'createdAt'>>): Promise<AgentCredential>;

    /**
     * Remove agent from current project (detach from project_agent_refs).
     * Does NOT delete from global signaldock.db (per ADR-037 §6 / Q4=C).
     */
    remove(agentId: string): Promise<void>;

    /**
     * Remove agent from global signaldock.db.
     * Requires explicit opt-in. Warns if other project refs exist.
     *
     * @param opts.force - Skip cross-project scan warning (when scan is infeasible)
     */
    removeGlobal(agentId: string, opts?: { force?: boolean }): Promise<void>;

    /** Update last_used_at in both global agents table and project_agent_refs. */
    markUsed(agentId: string): Promise<void>;

    /** Get the most recently used active agent in this project. */
    getActive(): Promise<AgentCredential | null>;

    /** Rotate API key via cloud endpoint and re-encrypt with new KDF in global signaldock.db. */
    rotateKey(agentId: string): Promise<{ agentId: string; newApiKey: string }>;
}
```

---

## 4. Migration Procedure

### 4.1 Migration module

```
File: packages/core/src/store/migrate-signaldock-to-conduit.ts
```

### 4.2 Detection

```typescript
/**
 * Returns true when the legacy migration is needed for the given project.
 * Detection heuristic (ADR-037 §8):
 *   - .cleo/signaldock.db EXISTS AND .cleo/conduit.db DOES NOT EXIST
 * Idempotent: returns false once conduit.db is present, regardless of .bak state.
 */
export function needsMigration(projectRoot: string): boolean {
    const legacyPath = path.join(projectRoot, '.cleo', 'signaldock.db');
    const conduitPath = path.join(projectRoot, '.cleo', 'conduit.db');
    return fs.existsSync(legacyPath) && !fs.existsSync(conduitPath);
}
```

### 4.3 Migration sequence (atomic intent per file)

```
Step 1:  Open legacy .cleo/signaldock.db in READ-ONLY mode.
         Abort immediately (ERROR) if the file is unreadable.

Step 2:  Run PRAGMA integrity_check on the legacy DB.
         If integrity_check returns anything other than 'ok', abort and log ERROR
         with recovery instructions. Do NOT create conduit.db or .bak.

Step 3:  Ensure global $XDG_DATA_HOME/cleo/ directory exists (mkdirSync recursive).

Step 4:  Ensure $XDG_DATA_HOME/cleo/signaldock.db exists (ensureGlobalSignaldockDb()).
         If it already exists (a prior project migrated first), continue — INSERT OR IGNORE
         handles duplicates.

Step 5:  Ensure $XDG_DATA_HOME/cleo/global-salt exists (getGlobalSalt() creates if absent).

Step 6:  Read machine-key from $XDG_DATA_HOME/cleo/machine-key (existing credential path).

Step 7:  Create .cleo/conduit.db with the new conduit schema (ensureConduitDb(projectRoot)).

Step 8:  BEGIN TRANSACTION on conduit.db.
  8a: Copy project-tier tables verbatim (row-by-row INSERT or VACUUM INTO subset):
      messages, conversations, delivery_jobs, dead_letters, message_pins, attachments,
      attachment_versions, attachment_approvals, attachment_contributors.
  8b: Rebuild messages_fts from the copied messages table:
      INSERT INTO messages_fts(messages_fts) VALUES('rebuild')
  8c: Derive project_agent_refs rows from legacy agents table:
      For each agent row in legacy signaldock.db:
        INSERT INTO conduit.db:project_agent_refs (
          agent_id    = agents.agent_id,
          attached_at = datetime(agents.created_at, 'unixepoch'),
          role        = agents.classification,
          capabilities_override = NULL,
          last_used_at = CASE WHEN agents.last_used_at IS NOT NULL
                              THEN datetime(agents.last_used_at, 'unixepoch')
                              ELSE NULL END,
          enabled     = 1
        ) ON CONFLICT(agent_id) DO NOTHING;
Step 9:  COMMIT conduit.db transaction.
         On failure: ROLLBACK, delete partial conduit.db, log ERROR.

Step 10: Run PRAGMA integrity_check on conduit.db.
         If not 'ok': move conduit.db to conduit.db.broken-<timestamp>, log ERROR.

Step 11: BEGIN TRANSACTION on global signaldock.db.
  11a: For each agent in legacy: decrypt api_key_encrypted using legacy KDF
       (HMAC-SHA256(machine-key, projectPath) → AES-256-GCM decrypt),
       re-encrypt using new KDF (HMAC-SHA256(machine-key || global-salt, agentId) → AES-256-GCM),
       then INSERT OR IGNORE into global agents table with requires_reauth=1.
       If an agent_id already exists globally (prior project migration), SKIP re-keying — the
       existing global row takes precedence. requires_reauth stays whatever it was.
  11b: Copy capabilities, skills, agent_capabilities, agent_skills rows using INSERT OR IGNORE.
  11c: Copy cloud-sync tables (users, accounts, sessions, verifications, organization,
       claim_codes) using INSERT OR IGNORE.

Step 12: COMMIT global signaldock.db transaction.
         On failure: ROLLBACK global transaction. conduit.db remains valid.
         Log ERROR with recovery instructions.

Step 13: Run PRAGMA integrity_check on global signaldock.db.
         If not 'ok': move broken global signaldock.db to signaldock.db.broken-<timestamp>,
         log ERROR.

Step 14: Atomic rename:
         fs.renameSync(.cleo/signaldock.db, .cleo/signaldock.db.pre-t310.bak)
         On failure: log ERROR. Next run re-attempts from Step 1 (conduit.db absent = needs migration).

Step 15: Log INFO: "T310 migration complete: <n> agents migrated to global, conduit.db created"
         Log WARN: "API keys have been re-keyed. External systems holding old API keys
                    (CI env vars, remote agent configs) must be updated."
         Log INFO: "Recovery: if problems occur, rename .pre-t310.bak to signaldock.db
                    and delete conduit.db to re-run migration."
```

### 4.4 Error handling

| Failure at step | Action |
|---|---|
| 1 (legacy unreadable) | Abort; no changes; log ERROR |
| 2 (legacy integrity fail) | Abort; no changes; log ERROR |
| 7 (conduit create) | Abort; no changes yet; log ERROR |
| 8-9 (conduit write/commit) | ROLLBACK conduit; delete partial conduit.db; log ERROR |
| 10 (conduit integrity fail) | Move broken conduit.db to `.broken-<ts>`; log ERROR |
| 11-12 (global write/commit) | ROLLBACK global; conduit.db valid; log ERROR |
| 13 (global integrity fail) | Move broken global signaldock.db to `.broken-<ts>`; log ERROR |
| 14 (rename) | Log ERROR; next run re-attempts (idempotent: conduit.db still absent) |

In all error cases: cleo continues starting (non-fatal). The user can diagnose without being locked out.

### 4.5 Idempotency

- `needsMigration()` returns false if conduit.db already exists → entire migration is a no-op.
- If `.pre-t310.bak` exists alongside conduit.db, migration considers itself already done.
- Global `INSERT OR IGNORE` prevents duplicates when multiple projects migrate the same agent.

### 4.6 Wire-up location

```
File: packages/cleo/src/cli/index.ts

Startup sequence (before any accessor is called):
  1. detectAndRemoveLegacyGlobalFiles()  [existing]
  2. runConduitMigrationIfNeeded()        [NEW — calls needsMigration() + runMigration()]
  3. ensureConduitDb()                    [creates conduit.db on fresh install]
  4. ensureGlobalSignaldockDb()           [creates global signaldock.db on fresh install]
  5. validateGlobalSalt()                 [integrity check]
```

---

## 5. CLI Contracts

### 5.1 New verbs

```
cleo agent attach <id>
  Creates a project_agent_refs row in conduit.db for the given agent.
  Agent must already exist in global signaldock.db (E_NOT_FOUND if not).
  If a row already exists with enabled=0, re-enables it.
  On success: prints "Agent <id> attached to current project."
  Exit codes: 0 success, 4 E_NOT_FOUND (agent not in global), 6 E_VALIDATION

cleo agent detach <id>
  Sets project_agent_refs.enabled=0 in conduit.db.
  Does NOT delete from global signaldock.db.
  On success: prints "Agent <id> detached from current project."
  Alias: equivalent to `cleo agent remove <id>` (no --global).
  Exit codes: 0 success, 4 E_NOT_FOUND (agent not in project)
```

### 5.2 Modified verbs

```
cleo agent list [--global]
  Without --global (default, Q1=B per ADR-037 §4):
    INNER JOIN conduit.db:project_agent_refs (enabled=1) with global signaldock.db:agents.
    Returns only agents visible in the current project.
  With --global:
    Full scan of global signaldock.db:agents. No project filter. Shows all registered identities.
  Output columns (both modes): agent_id, name, classification, transport_type, is_active, last_used_at

cleo agent remove <id> [--global [--force]]
  Without --global:
    Deletes the project_agent_refs row in conduit.db for <id> in the current project.
    Does NOT touch global signaldock.db:agents.
    Equivalent to `cleo agent detach <id>`.
    Exit codes: 0 success, 4 E_NOT_FOUND
  With --global:
    Deletes agents row from global signaldock.db:agents.
    Pre-check: scans known project roots (from registry or filesystem) for project_agent_refs
    rows referencing <id>. If any found, prints WARNING listing affected projects.
    If scan is infeasible, prints WARNING and requires --force to proceed.
    Exit codes: 0 success, 4 E_NOT_FOUND, exit 1 if references found and --force not passed
  With --global --force:
    Skips cross-project scan warning; proceeds with global deletion.
    Post-deletion: any project_agent_refs rows pointing to this agent_id become dangling
    soft FKs (resolved to null on next cross-DB join; logged as WARN by accessor layer).
```

### 5.3 Unchanged verbs (transparent to split)

The following verbs route through `AgentRegistryAccessor` which handles the cross-DB join
transparently. No CLI-level changes required:

```
cleo agent create   — calls createProjectAgent(); writes global + project ref
cleo agent info     — calls lookupAgent() with includeGlobal=false
cleo agent auth     — updates api_key_encrypted in global signaldock.db via KDF
```

### 5.4 Exit code contracts

All new verbs use the existing exit code scheme from `packages/contracts/src/`:

| Exit code | Constant | Meaning |
|---|---|---|
| 0 | — | Success |
| 4 | E_NOT_FOUND | Agent not found (project or global scope as applicable) |
| 6 | E_VALIDATION | Invalid argument or constraint violation |
| 1 | — | Generic error (scan found references; use --force to override) |

---

## 6. Backup Registry Changes

### 6.1 Project tier (sqlite-backup.ts::SNAPSHOT_TARGETS)

Add `conduit` target alongside existing `tasks` and `brain`:

```typescript
// File: packages/core/src/store/sqlite-backup.ts

// Import the new conduit DB getter (to be created in conduit-sqlite.ts)
import { getConduitNativeDb } from './conduit-sqlite.js';

const SNAPSHOT_TARGETS: SnapshotTarget[] = [
    { prefix: 'tasks',   getDb: getNativeDb },
    { prefix: 'brain',   getDb: getBrainNativeDb },
    { prefix: 'conduit', getDb: getConduitNativeDb },  // NEW — T310
];
```

`getConduitNativeDb()` follows the same pattern as `getNativeDb()` and `getBrainNativeDb()`:
returns the live `DatabaseSync` handle for the current process, or `null` if not yet initialized.

### 6.2 Global tier (sqlite-backup.ts::GLOBAL_SNAPSHOT_TARGETS)

Activate the pre-reserved `signaldock` slot (currently reserved at `sqlite-backup.ts:311`):

```typescript
// File: packages/core/src/store/sqlite-backup.ts

// Import the new global signaldock DB getter (to be created in signaldock-sqlite.ts)
import { getGlobalSignaldockNativeDb } from './signaldock-sqlite.js';

const GLOBAL_SNAPSHOT_TARGETS: SnapshotTarget[] = [
    { prefix: 'nexus',      getDb: getNexusNativeDb },
    { prefix: 'signaldock', getDb: getGlobalSignaldockNativeDb },  // ACTIVATED — T310
];
```

`vacuumIntoGlobalBackup('signaldock', opts)` is already wired in the function signature at
`sqlite-backup.ts:347`; activating the target makes it reachable.

### 6.3 Global-salt file backup

The global-salt file is a 32-byte binary file, not an SQLite database. It MUST be backed up via
raw file copy, NOT `VACUUM INTO`.

```typescript
// New function in sqlite-backup.ts (or a new global-salt-backup.ts module):

/**
 * Back up the global-salt file to $XDG_DATA_HOME/cleo/backups/global-salt-<timestamp>
 * with 0o600 permissions. Rotates to MAX_SNAPSHOTS (10) copies.
 *
 * Called alongside vacuumIntoGlobalBackup() in session-end and manual backup hooks.
 * Non-fatal: errors are swallowed — salt backup failure must never block cleo.
 *
 * @param cleoHomeOverride - Override getCleoHome() for test isolation
 * @returns Object with snapshotPath and any rotated file paths
 */
export async function backupGlobalSalt(
    opts?: { cleoHomeOverride?: string }
): Promise<{ snapshotPath: string; rotated: string[] }>;
```

Rotation filename pattern: `global-salt-YYYYMMDD-HHmmss` (no `.db` extension — it is a binary file).
Snapshot permissions: `0o600`.

### 6.4 Integration with T311

T311 (backup export/import) will bundle conduit.db (project), signaldock.db (global), and
global-salt (global) into a single portable export via `cleo backup export --scope project|global`.
This spec only enumerates what is registered; T311 handles bundling and cross-machine portability.

The global-salt is explicitly NOT portable across machines (per ADR-037 §5): it must be excluded
from any `--scope global` bundle intended for cross-machine restore unless the user explicitly
acknowledges the KDF invalidation consequence.

---

## 7. Test Scenarios

### 7.1 Unit tests: conduit-sqlite.test.ts

```
TC-001: getConduitDbPath returns path ending in '.cleo/conduit.db'
TC-002: ensureConduitDb creates file with correct schema on fresh install
TC-003: ensureConduitDb is idempotent (second call returns action='exists', no schema errors)
TC-004: attachAgentToProject inserts row with enabled=1
TC-005: attachAgentToProject re-enables an existing row with enabled=0 (no duplicate insert)
TC-006: detachAgentFromProject sets enabled=0 (does not delete row)
TC-007: listProjectAgentRefs returns only enabled=1 rows by default
TC-008: listProjectAgentRefs returns enabled=0 rows when enabledOnly=false
TC-009: getProjectAgentRef returns null for unknown agent_id
TC-010: updateProjectAgentLastUsed updates last_used_at to current ISO timestamp
TC-011: All conduit messaging tables present (conversations, messages, delivery_jobs, dead_letters,
         message_pins, attachments, attachment_versions, attachment_approvals, attachment_contributors)
TC-012: messages_fts virtual table exists and triggers are functional (insert → FTS row visible)
```

### 7.2 Unit tests: global-signaldock.test.ts

```
TC-020: getGlobalSignaldockDbPath returns path within getCleoHome()
TC-021: ensureGlobalSignaldockDb creates file with correct global schema on fresh install
TC-022: ensureGlobalSignaldockDb is idempotent
TC-023: agents table contains requires_reauth column (T310 migration field)
TC-024: All cloud-sync tables present (users, organization, accounts, sessions, verifications,
         claim_codes, org_agent_keys) with zero rows on fresh install
TC-025: capabilities and skills tables present (pre-seed rows populated on ensureGlobalSignaldockDb)
TC-026: agent_capabilities and agent_skills junction tables present
TC-027: agent_connections table present with correct schema
```

### 7.3 Unit tests: global-salt.test.ts

```
TC-030: getGlobalSaltPath returns path within getCleoHome()
TC-031: getGlobalSalt() creates file on first call (32 bytes, 0o600 permissions)
TC-032: getGlobalSalt() returns same bytes on second call (memoized)
TC-033: getGlobalSalt() reads from disk correctly after clearing cache
TC-034: validateGlobalSalt() passes on a valid 32-byte 0o600 file
TC-035: validateGlobalSalt() throws when file size is wrong (e.g., 31 bytes)
TC-036: validateGlobalSalt() throws when file permissions are too permissive (0o644) on POSIX
TC-037: _clearGlobalSaltCache_TESTING_ONLY() allows re-generation in test isolation
```

### 7.4 Unit tests: api-key-kdf.test.ts

```
TC-040: deriveApiKey returns a 32-byte Buffer
TC-041: deriveApiKey is deterministic: same inputs → same output
TC-042: deriveApiKey with different agentId → different output (agent-bound)
TC-043: deriveApiKey with different globalSalt → different output (salt-isolated)
TC-044: deriveApiKey with different machineKey → different output (machine-bound)
TC-045: deriveLegacyProjectKey matches the existing credentials.ts::deriveProjectKey output
TC-046: deriveApiKey output differs from deriveLegacyProjectKey for same agent (KDF migration)
```

### 7.5 Unit tests: agent-registry-accessor.test.ts

```
TC-050: lookupAgent returns null for unknown agentId (project scope)
TC-051: lookupAgent returns agent when project_agent_refs row exists and enabled=1
TC-052: lookupAgent returns null when project_agent_refs row has enabled=0
TC-053: lookupAgent with includeGlobal=true returns agent even without project ref
TC-054: listAgentsForProject returns only project-attached agents by default
TC-055: listAgentsForProject with includeGlobal=true returns all global agents
TC-056: createProjectAgent writes to global signaldock.db AND creates project_agent_refs row
TC-057: AgentRegistryAccessor.remove() deletes project_agent_refs; global row untouched
TC-058: AgentRegistryAccessor.removeGlobal() deletes global agents row
TC-059: AgentRegistryAccessor.markUsed() updates last_used_at in both DBs
```

### 7.6 Migration tests: migrate-signaldock-to-conduit.test.ts

```
TC-060: needsMigration returns false when conduit.db exists (no legacy)
TC-061: needsMigration returns false when signaldock.db absent (fresh install)
TC-062: needsMigration returns true when signaldock.db present AND conduit.db absent
TC-063: Migration with 0 agents: creates conduit.db + global signaldock.db + .pre-t310.bak
TC-064: Migration with 2 agents: both migrated to global; 2 project_agent_refs rows created
TC-065: Migration with 2 agents: api_key_encrypted re-keyed (old key unreadable after migration)
TC-066: Multiple projects migrating same agentId: second migration uses INSERT OR IGNORE; global row preserved
TC-067: Migration is idempotent: running again when conduit.db exists is a no-op
TC-068: Legacy integrity_check failure aborts migration; no .pre-t310.bak created; conduit.db absent
TC-069: Conduit write failure rolls back; conduit.db absent; retry succeeds
TC-070: Migration preserves all message rows in conduit.db:messages
TC-071: Migration preserves all conversation rows in conduit.db:conversations
TC-072: Post-migration: messages_fts search returns expected results
TC-073: .pre-t310.bak is NOT deleted by migration (recovery path preserved)
```

### 7.7 CLI integration tests: agent lifecycle

```
TC-080: cleo agent create in Project A → agent in global signaldock.db + project_agent_refs in A's conduit.db
TC-081: cleo agent list in Project A → shows agent (INNER JOIN)
TC-082: cleo agent list in Project B (fresh conduit.db) → does NOT show agent
TC-083: cleo agent attach <id> in Project B → project_agent_refs row created; now visible in B
TC-084: cleo agent list --global in Project B → shows all global agents including A's agent
TC-085: cleo agent remove <id> in Project A → detached from A; global intact; still visible in B
TC-086: cleo agent remove --global <id> in Project A → WARNS (B still references); exits 1
TC-087: cleo agent remove --global --force <id> → removes from global; B's ref is now dangling
TC-088: cleo agent detach <id> → sets enabled=0; same result as cleo agent remove <id>
```

### 7.8 KDF / reauth integration tests

```
TC-090: Pre-T310 agent (migrated) has requires_reauth=1 in global signaldock.db
TC-091: cleo agent auth on a requires_reauth=1 agent prompts for credentials and clears flag
TC-092: API key derived by new KDF is distinct from API key derived by legacy KDF for same agent
TC-093: Cross-machine simulation: different machineKey → different derived API key for same agentId
```

### 7.9 Backup integration tests

```
TC-100: vacuumIntoBackupAll includes conduit.db snapshot in .cleo/backups/sqlite/
TC-101: vacuumIntoGlobalBackup('signaldock') writes snapshot to $XDG_DATA_HOME/cleo/backups/sqlite/
TC-102: backupGlobalSalt writes binary file to $XDG_DATA_HOME/cleo/backups/global-salt-<ts>
TC-103: Backup rotation: 11th conduit snapshot deletes the oldest
TC-104: listSqliteBackupsAll returns conduit key in its result map
TC-105: listGlobalSqliteBackups('signaldock') returns the global signaldock snapshots
```

---

## 8. Non-Functional Requirements

### Performance

- Cross-DB JOIN on agent lookup MUST add less than 5ms per call on typical hardware
  (measured by a benchmark test against a DB with 50 agents in both tiers).
- Migration MUST complete in less than 2 seconds for typical installs (less than 100 agents,
  less than 1000 messages). Measured in integration test TC-064.
- `getGlobalSalt()` MUST be memoized in-process. No repeated disk I/O after first call.
- `getGlobalSaltPath()` and `getGlobalSignaldockDbPath()` MUST be pure (no I/O).

### Safety

- Migration MUST NOT delete legacy signaldock.db without first creating `.pre-t310.bak`
  (Step 14 happens after both conduit.db and global signaldock.db are committed and verified).
- PRAGMA integrity_check runs before any rename (Steps 10 and 13).
- global-salt file permissions MUST be checked at startup (validateGlobalSalt() in startup hook).
- API key reauth is explicit: the `requires_reauth=1` flag causes a prompt on next `cleo agent auth`
  invocation. No silent key regeneration. No silent plaintext API key exposure.
- `removeGlobal()` MUST warn (and exit 1) when other project refs exist, unless `--force` is passed.

### Observability

- Migration steps logged at INFO level (visible in `cleo doctor` output and cleo.log).
- KDF derivation inputs and outputs are NOT logged (secret material).
- global-salt fingerprint (first 4 bytes as hex) logged once at INFO level on cleo startup.
- Any dangling soft FK (project_agent_refs row with no matching global agent) logged at WARN level
  on accessor read, with the dangling agent_id included.

---

## 9. File Boundaries for Implementation Phase

Each implementation subtask SHOULD touch no more than 3 source files plus its test file.
The following groupings are guidance for T329 decomposition:

| Subtask group | Primary files |
|---|---|
| conduit schema + ensure + path helper | `conduit-sqlite.ts` (new), `paths.ts` (add `getConduitDbPath` if not inlined) |
| global signaldock schema + ensure + path helper | `signaldock-sqlite.ts` (refactor), `paths.ts` (add `getGlobalSignaldockDbPath`) |
| global-salt module | `global-salt.ts` (new) |
| KDF module | `api-key-kdf.ts` (new), `credentials.ts` (add `deriveLegacyProjectKey` re-export) |
| project_agent_refs accessors (conduit-sqlite.ts additions) | `conduit-sqlite.ts`, `contracts/src/agent.ts` |
| accessor refactor | `agent-registry-accessor.ts` |
| migration executor | `migrate-signaldock-to-conduit.ts` (new), `cli/index.ts` (startup wire-up) |
| LocalTransport path update | `conduit/local-transport.ts`, `conduit/factory.ts` |
| CLI verbs (attach, detach, remove --global) | `cli/commands/agent.ts` |
| backup registry | `sqlite-backup.ts` |
| internal.ts re-export audit | `internal.ts` (update re-exports and deprecate old names) |
| unit tests | per-module test files (see Section 7) |
| integration tests | new `__tests__/t310-conduit-migration.test.ts` |

---

## 10. Acceptance Criteria Summary

The implementation phase (T329 subtasks) is complete when ALL of the following are observably
true in behavior and automated tests:

1. **ADR-037 §1**: `cleo agent create` in any project writes identity to
   `$XDG_DATA_HOME/cleo/signaldock.db` AND creates a `conduit.db:project_agent_refs` row.

2. **ADR-037 §4 / Q1=B**: `cleo agent list` (no flags) is project-scoped by default.
   Agents from other projects are NOT visible unless explicitly attached.

3. **ADR-037 §8 / Q8=A**: Migration runs automatically on first post-upgrade invocation
   when `.cleo/signaldock.db` exists and `.cleo/conduit.db` does not.

4. **All 8 consensus decisions** (Q1–Q8 from `.cleo/consensus/T310-consensus.md`) are
   observably true in CLI behavior and covered by automated tests.

5. **Backup registry**: `vacuumIntoBackupAll()` snapshots `conduit.db`;
   `vacuumIntoGlobalBackup('signaldock')` snapshots the global `signaldock.db`;
   `backupGlobalSalt()` copies the salt file.

6. **global-salt**: File generated on first run, 32 bytes, `0o600` permissions,
   persists across invocations, validated on startup.

7. **API key reauth**: All agents migrated from pre-T310 signaldock.db have
   `requires_reauth=1` in global signaldock.db; the reauth prompt fires on next
   `cleo agent auth` for those agents.

8. **Zero regression**: All pre-existing tests (at the time T329 subtasks are executed)
   continue to pass. At least 50 new tests are added across unit and integration suites,
   covering the test scenarios enumerated in Section 7.

9. **ADR-037 §6 / Q4=C**: `cleo agent remove <id>` (no `--global`) does NOT delete
   from global `signaldock.db:agents`. `cleo agent remove --global <id>` warns when
   other project refs exist.

10. **LocalTransport**: `LocalTransport.connect()` opens `.cleo/conduit.db`, not
    `.cleo/signaldock.db`. Existing message I/O tests pass against conduit.db.
