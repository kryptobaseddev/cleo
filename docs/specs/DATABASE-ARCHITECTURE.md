# CLEO Database Architecture

> **Status**: CANONICAL
> **Author**: signaldock-dev
> **Date**: 2026-03-25
> **Scope**: All databases in the CLEO ecosystem (local + cloud)

---

## Overview

CLEO uses **4 SQLite databases** — 3 per-project and 1 global. With embedded SignalDock, the messaging database uses a **dual-ORM, single-file** architecture: Rust sqlx owns the schema/migrations while Diesel (via `better-auth-diesel-sqlite`) operates on the same tables for authentication.

---

## Project-Level Databases

### 1. `tasks.db` — Task Management + Agent Identity

**Location**: `.cleo/tasks.db`
**ORM**: Drizzle ORM (TypeScript, node:sqlite `DatabaseSync`)
**Migration**: Drizzle Kit
**Purpose**: CLEO's core operational database — tasks, sessions, lifecycle pipelines, ADRs, agent identity, and encrypted credentials.

| Table | Purpose |
|---|---|
| `tasks` | Task tree with title, description, status, priority, size, assignee |
| `taskDependencies` | Task dependency edges |
| `taskRelations` | Cross-task relationships (blocks, relates-to, duplicates) |
| `sessions` | Agent work sessions (start/end timestamps, agent identity) |
| `taskWorkHistory` | Record of work performed on each task |
| `lifecyclePipelines` | RCASD-IVTR+C lifecycle pipeline definitions |
| `lifecycleStages` | Pipeline stage configurations |
| `lifecycleGateResults` | Gate pass/fail/warn results |
| `lifecycleEvidence` | Evidence attached to gate results |
| `lifecycleTransitions` | Stage transition audit trail |
| `manifestEntries` | Build manifest entries |
| `pipelineManifest` | Pipeline-level manifest metadata |
| `releaseManifests` | Release tracking |
| `auditLog` | Operation audit trail |
| `tokenUsage` | LLM token accounting (method, confidence, transport) |
| `architectureDecisions` | ADR records |
| `adrTaskLinks` | ADR ↔ task cross-references |
| `adrRelations` | ADR relationship graph |
| `externalTaskLinks` | Links to external systems (GitHub issues, etc.) |
| `statusRegistryTable` | Task status registry |
| `agentInstances` | Which agents work on which tasks in this project |
| `agent_credentials` | **NEW** — encrypted API keys + agent profiles (see Unified Agent Registry spec) |
| `schema_meta` | Schema version tracking |

### 2. `brain.db` — Knowledge & Memory

**Location**: `.cleo/brain.db`
**ORM**: Drizzle ORM (TypeScript, node:sqlite `DatabaseSync` + sqlite-vec extension)
**Migration**: Drizzle Kit
**Purpose**: CLEO's memory system — recorded decisions, detected patterns, lessons learned, raw observations from agent sessions.

| Table | Purpose |
|---|---|
| `brainDecisions` | Recorded decisions with context, rationale, outcomes |
| `brainPatterns` | Detected patterns (recurring, anti-pattern, improvement) |
| `brainLearnings` | Lessons learned with confidence levels |
| `brainObservations` | Raw observations from agent sessions |
| `brainStickyNotes` | Quick ephemeral capture before formal classification |
| `brainMemoryLinks` | Cross-references between brain entries and tasks |
| `brain_schema_meta` | Schema version tracking |

**sqlite-vec**: Vector extension loaded for semantic similarity search on observations.

### 3. `signaldock.db` — Agent Messaging (Dual-ORM)

**Location**: `.cleo/signaldock.db`
**Primary ORM**: Rust sqlx (via napi-rs locally, native Rust in cloud)
**Secondary ORM**: Diesel (via `better-auth-diesel-sqlite` for auth tables)
**Migration**: sqlx embedded migrations (17 files, checksummed — NEVER modify after apply)

This is a **single SQLite file managed by two ORMs**:

```
signaldock.db
├── sqlx-owned tables (schema via migrations 0001-0017)
│   ├── agents, conversations, messages (core messaging)
│   ├── delivery_jobs, dead_letters (reliable delivery)
│   ├── capabilities, skills, agent_capabilities, agent_skills (registry)
│   ├── claim_codes, connections, message_pins, attachments (features)
│   ├── organization, org_agent_keys (fleet management)
│   ├── users (base columns: id, email, password_hash, name, timestamps)
│   ├── accounts, sessions, verifications (created by migration 0015 for better-auth)
│   └── messages_fts (FTS5 virtual table for full-text search)
│
└── Diesel-operated tables (same tables, no separate creation)
    ├── users (reads/writes better-auth columns: role, banned, email_verified, etc.)
    ├── accounts (credential provider records)
    ├── sessions (auth session tokens)
    └── verifications (email/2FA verification tokens)
```

**Why dual-ORM?** sqlx (Rust) handles all messaging/agent operations. Diesel (Rust, via `better-auth-diesel-sqlite`) handles authentication operations (login, session management, API key creation, 2FA, organization plugins). Both read/write the same `users` table — sqlx created it, Diesel's `CREATE TABLE IF NOT EXISTS` is a safe no-op.

**CRITICAL RULE**: NEVER modify an already-applied sqlx migration. sqlx embeds checksums at compile time. Modifying a migration file causes a checksum mismatch → application crash loop. Always create a NEW numbered migration for schema changes.

#### Full Table Inventory (17 migrations)

| Migration | Tables Created/Modified | Purpose |
|---|---|---|
| 0001 | `users`, `agents`, `conversations`, `messages`, `claim_codes`, `connections` | Initial schema |
| 0002 | messages.`attachments` column | Message attachments (JSON array) |
| 0003 | agents.`payment_config` column | x402 payment configuration |
| 0004 | `delivery_jobs`, `dead_letters` | Reliable delivery with retries |
| 0005 | users.`default_agent_id` column | Default sending identity |
| 0006 | messages.`group_id` column | Group message deduplication |
| 0007 | agents.`api_key_hash` column | API key authentication (SHA-256) |
| 0008 | messages.`metadata` column | @mentions, /directives, #tags (JSON) |
| 0009 | messages.`reply_to` column | Message threading |
| 0010 | `messages_fts` (FTS5 virtual table) | Full-text search + sync triggers |
| 0011 | `message_pins` | Bookmarked/pinned messages |
| 0012 | `attachments` | llmtxt compressed content blobs |
| 0013 | `capabilities`, `skills`, `agent_capabilities`, `agent_skills` | Codified agent metadata registry (19 capabilities, 35 skills seeded) |
| 0014 | (data migration) | Freetext → junction table mapping |
| 0015 | users.*(10 columns), `accounts`, `sessions`, `verifications` | better-auth compatibility (email_verified, role, banned, 2FA, etc.) |
| 0016 | agents.`organization_id`, `org_agent_keys` | Organization fleet management |
| 0017 | `organization` | Organization table (FK target for 0016) |

#### better-auth Plugins (operating on same DB)

| Plugin | Tables Used | Purpose |
|---|---|---|
| `EmailPasswordPlugin` | `users`, `accounts` | Email/password registration + login |
| `SessionManagementPlugin` | `sessions` | Token-based session auth |
| `ApiKeyPlugin` | `users` (via accounts) | `sk_live_` API key generation (prefix, 32-char) |
| `OrganizationPlugin` | `organization`, `org_agent_keys` | Agent fleet management |
| `AdminPlugin` | `users` (role column) | User ban/unban, role assignment |
| `TwoFactorPlugin` | `verifications` | TOTP + backup codes |

#### Local vs Cloud Differences

| Aspect | Local (embedded via napi-rs) | Cloud (Railway) |
|---|---|---|
| Database engine | SQLite (`.cleo/signaldock.db`) | PostgreSQL (or SQLite) |
| sqlx adapter | `SqliteStore` | `SqliteStore` or `PostgresStore` |
| better-auth adapter | `DieselSqliteAdapter` | `DieselSqliteAdapter` (same DB) |
| Auth endpoints | Minimal (local user auto-created) | Full (`/auth/v2/*` routes) |
| FTS5 | Yes (SQLite-only feature) | SQLite: yes, Postgres: separate approach |
| Redis | Not needed (in-process pub/sub) | Yes (cross-instance fan-out) |

**Local embedded note**: Locally, better-auth is still initialized (same `build_auth()` function) because the `users` table schema must exist (agents reference `users.id` via `owner_id`). However, the `/auth/v2/*` HTTP routes are cloud-only — local agents are auto-registered without human login.

---

## Global Database

### 4. `nexus.db` — Cross-Project Routing

**Location**: `~/.local/share/cleo/nexus.db` (Linux: `~/.local/share/cleo/`, macOS: `~/Library/Application Support/cleo/`, Windows: `%APPDATA%/cleo/`)
**ORM**: Drizzle ORM (TypeScript, node:sqlite `DatabaseSync`)
**Migration**: Drizzle Kit
**Purpose**: NEXUS cross-project task routing, project discovery, and multi-project workflow orchestration (warp chains).

| Table | Purpose |
|---|---|
| `projectRegistry` | Known projects with paths and metadata |
| `nexusAuditLog` | Cross-project operation audit trail |
| `warpChains` | Multi-project workflow chain definitions |
| `warpChainInstances` | Running workflow instances |
| `nexus_schema_meta` | Schema version tracking |

---

## Database Relationships

```
tasks.db (Drizzle)                brain.db (Drizzle + sqlite-vec)
┌──────────────────┐             ┌──────────────────┐
│ tasks            │ ←soft FK── │ brainObservations │
│ sessions         │             │ brainDecisions   │
│ agentInstances   │             │ brainPatterns    │
│ agent_credentials│             │ brainLearnings   │
│ (encrypted keys) │             └──────────────────┘
└──────┬───────────┘
       │ agent_credentials.agentId = agents.agent_id
       │
signaldock.db (sqlx + Diesel)    nexus.db (Drizzle, GLOBAL)
┌──────────────────┐             ┌──────────────────┐
│ agents           │             │ projectRegistry  │
│ users + accounts │ (dual-ORM)  │ nexusAuditLog   │
│ sessions (auth)  │             │ warpChains       │
│ messages         │             └──────────────────┘
│ conversations    │
│ delivery_jobs    │
│ capabilities     │
│ skills           │
│ message_pins     │
│ attachments      │
│ organization     │
│ messages_fts     │ (FTS5)
└──────────────────┘
```

**Cross-database relationships are soft FKs** (text IDs, no enforced foreign keys across database files). This is by design — each database can be backed up, restored, or migrated independently without breaking referential integrity in other databases.

---

## File System Layout

```
~/.local/share/cleo/             ← GLOBAL (env-paths)
├── nexus.db                     ← Cross-project NEXUS routing
└── machine-key                  ← Encryption key for credentials (NEW)

/path/to/project/.cleo/          ← PROJECT-LEVEL
├── tasks.db                     ← Tasks, sessions, lifecycle, ADRs, credentials
├── brain.db                     ← Knowledge: decisions, patterns, observations
├── signaldock.db                ← Agent messaging (sqlx + Diesel dual-ORM)
└── config.json                  ← Project configuration
```

---

## ORM Summary

**Important**: `signaldock.db` uses sqlx (Rust) with embedded checksummed migrations, while all other databases use Drizzle ORM (TypeScript) with Drizzle Kit migrations. The Rust migrations are compiled into the `signaldock-storage` crate binary and run at database initialization. They are NOT managed by Drizzle Kit and must NEVER be modified after being applied to a database.

| Database | Primary ORM | Secondary ORM | Language | Migration System |
|---|---|---|---|---|
| `tasks.db` | Drizzle ORM | — | TypeScript (node:sqlite) | Drizzle Kit |
| `brain.db` | Drizzle ORM | — | TypeScript (node:sqlite + sqlite-vec) | Drizzle Kit |
| `signaldock.db` | sqlx | Diesel (better-auth) | Rust (napi-rs locally, native in cloud) | sqlx embedded migrations (checksummed) |
| `nexus.db` | Drizzle ORM | — | TypeScript (node:sqlite) | Drizzle Kit |

---

## Cloud vs Local

| Database | Local | Cloud (SignalDock server) |
|---|---|---|
| `tasks.db` | Per-project `.cleo/tasks.db` | N/A (CLEO-only, not on cloud) |
| `brain.db` | Per-project `.cleo/brain.db` | N/A (CLEO-only, not on cloud) |
| `signaldock.db` | Per-project `.cleo/signaldock.db` (SQLite) | PostgreSQL (production) or SQLite |
| `nexus.db` | Global `~/.local/share/cleo/nexus.db` | N/A (local NEXUS only; cloud has its own routing) |

The cloud SignalDock server uses the SAME `signaldock-storage` crate but typically connects to **PostgreSQL** in production (Railway). The schema is compatible across SQLite and Postgres — the crate abstracts the difference.

---

## Cloud Deployment Note

The cloud SignalDock server at `api.signaldock.io` uses the same `signaldock-storage` crate but connects to **PostgreSQL** in production. The crate abstracts SQLite vs Postgres differences. The dual-ORM pattern works identically — `better-auth-diesel-sqlite` connects to the same Postgres database in production (despite its name, the adapter supports the same schema on Postgres when configured appropriately).

The `tasks.db`, `brain.db`, and `nexus.db` databases are LOCAL-ONLY. They do not exist on the cloud server. The cloud server only has `signaldock.db` (or its Postgres equivalent).
