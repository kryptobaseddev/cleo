# CLEO Database Architecture

> **Status**: CANONICAL
> **Author**: signaldock-dev
> **Date**: 2026-03-25
> **Scope**: All databases in the CLEO ecosystem (local + cloud)

---

## Overview

CLEO uses **4 databases** — 3 per-project and 1 global. TypeScript databases (tasks, brain, nexus) use Drizzle ORM v1.0.0-beta with `drizzle-orm/zod` validation. The Rust messaging database (signaldock) uses **Diesel ORM** exclusively — a single type-safe ORM with compile-time query verification, supporting both SQLite (local) and PostgreSQL (cloud) via feature flags.

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

### 3. `signaldock.db` — Agent Messaging + Auth (Diesel ORM)

**Location**: `.cleo/signaldock.db`
**ORM**: Diesel ORM (Rust) — sole ORM for all signaldock tables
**Backends**: SQLite (local Cleo Core, default) | PostgreSQL (cloud SignalDock SaaS)
**Migration**: Diesel embedded migrations (`embed_migrations!()` — shipped in binary)
**Auth**: `better-auth-diesel` (multi-backend, upgraded from `better-auth-diesel-sqlite`)

All tables are managed by a single ORM (Diesel) with compile-time query verification:

```
signaldock.db (Diesel — single ORM, dual backend)
├── Core messaging
│   ├── agents (agent identity, API key hash, payment config, organization)
│   ├── conversations (agent-to-agent threads)
│   ├── messages (content, metadata, @mentions, threading, attachments)
│   └── messages_fts (FTS5 virtual table — SQLite only, Postgres uses tsvector)
├── Reliable delivery
│   ├── delivery_jobs (retry queue with backoff)
│   └── dead_letters (failed delivery archive)
├── Agent registry
│   ├── capabilities, skills (codified metadata — 19 capabilities, 35 skills)
│   ├── agent_capabilities, agent_skills (junction tables)
│   └── claim_codes, connections (ownership + presence)
├── Auth (via better-auth-diesel, same DB)
│   ├── users (full better-auth schema: role, banned, email_verified, 2FA, metadata, slug)
│   ├── accounts (OAuth provider links + email/password)
│   ├── sessions (auth session tokens)
│   └── verifications (email/2FA verification tokens)
├── Organization
│   ├── organization (name, slug, logo, metadata)
│   ├── org_agent_keys (fleet API key management)
│   └── member, invitation (org membership + invites)
├── Features
│   ├── message_pins (bookmarked messages)
│   └── attachments (llmtxt compressed content blobs)
```

**Why Diesel (not sqlx)?**
1. **Compile-time query verification** — all queries are Rust expressions, SQL injection impossible
2. **Single ORM** — eliminates dual-ORM contention (previously sqlx + Diesel on same tables)
3. **Native multi-backend** — `diesel/sqlite` + `diesel/postgres` from one codebase via feature flags
4. **Type-safe schema** — auto-generated `schema.rs` from migrations, column types enforced at compile time
5. **Embedded migrations** — shipped in binary via `embed_migrations!()`, no runtime file dependency
6. **No live DB at build time** — unlike `sqlx::query!` which requires `DATABASE_URL` during compilation
7. **We own the auth adapter** — `better-auth-diesel` (65 trait methods, 66 tests, multi-backend)

**CRITICAL RULE**: NEVER modify an already-applied Diesel migration. Diesel embeds migrations at compile time via `embed_migrations!()`. Always create a NEW numbered migration for schema changes. Use `diesel migration generate <name>` to create new up.sql/down.sql pairs.

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
| Database engine | SQLite (`.cleo/signaldock.db`) | PostgreSQL |
| Diesel backend | `diesel/sqlite` | `diesel/postgres` |
| Diesel adapter | `DieselSignaldockAdapter<SqliteConnection>` | `DieselSignaldockAdapter<PgConnection>` |
| better-auth adapter | `DieselAuthAdapter<SqliteConnection>` | `DieselAuthAdapter<PgConnection>` |
| Connection strategy | `Arc<Mutex<SqliteConnection>>` (single-writer) | `diesel-async` connection pool |
| Auth endpoints | Minimal (local user auto-created) | Full (`/auth/v2/*` routes) |
| Full-text search | FTS5 (SQLite virtual table) | `tsvector` + `GIN` index (PostgreSQL) |
| Redis | Not needed (in-process pub/sub) | Yes (cross-instance fan-out) |

**Local embedded note**: Locally, better-auth is still initialized (same `build_auth()` function) because the `users` table schema must exist (agents reference `users.id` via `owner_id`). However, the `/auth/v2/*` HTTP routes are cloud-only — local agents are auto-registered without human login.

**SDK architecture**: The `signaldock-storage` crate is the Rust SSoT (single source of truth). It exposes:
- `signaldock-rs` — native Rust SDK for direct embedding
- `signaldock-ts` — TypeScript/Node SDK via napi-rs 3.8+ bindings
Both SDKs share the same Diesel-backed storage layer, ensuring identical behavior across languages.

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
signaldock.db (Diesel ORM)       nexus.db (Drizzle, GLOBAL)
┌──────────────────┐             ┌──────────────────┐
│ agents           │             │ projectRegistry  │
│ users + accounts │ (Diesel)    │ nexusAuditLog   │
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

**ORM Strategy**: TypeScript databases use Drizzle ORM v1.0.0-beta with `drizzle-orm/zod` validation. Rust databases use Diesel ORM with compile-time schema verification. Both provide full end-to-end type safety in their respective languages.

| Database | ORM | Language | Backend | Migration System |
|---|---|---|---|---|
| `tasks.db` | Drizzle ORM v1 beta | TypeScript (node:sqlite) | SQLite | Drizzle Kit |
| `brain.db` | Drizzle ORM v1 beta | TypeScript (node:sqlite + sqlite-vec) | SQLite | Drizzle Kit |
| `signaldock.db` | Diesel ORM | Rust (napi-rs locally, native in cloud) | SQLite (local) / PostgreSQL (cloud) | Diesel embedded migrations |
| `nexus.db` | Drizzle ORM v1 beta | TypeScript (node:sqlite) | SQLite | Drizzle Kit |

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

The cloud SignalDock server at `api.signaldock.io` uses the same `signaldock-storage` crate compiled with `diesel/postgres` feature, connecting to **PostgreSQL** in production (Railway). The Diesel backend abstraction handles SQLite vs Postgres differences transparently. The `better-auth-diesel` adapter (upgraded from `better-auth-diesel-sqlite`) connects to the same Postgres database for authentication.

The `tasks.db`, `brain.db`, and `nexus.db` databases are LOCAL-ONLY. They do not exist on the cloud server. The cloud server only has `signaldock.db` (or its Postgres equivalent).
