# CLEO Database Architecture

> **Status**: CANONICAL
> **Author**: signaldock-dev
> **Date**: 2026-03-25
> **Scope**: All databases in the CLEO ecosystem (local + cloud)

---

## Overview

CLEO uses **6 databases** — 3 per-project, 1 project-tier messaging, 1 global, and 1 core-only telemetry. As of v2026.4.12 (ADR-037), the former single `signaldock.db` was split into a project-tier `conduit.db` (messaging + project_agent_refs) and a global-tier `signaldock.db` (canonical agent identity + cloud-sync). The sixth database, `telemetry.db`, is a global opt-in CLI telemetry store introduced by T624 and managed exclusively by `@cleocode/core`. TypeScript databases use `node:sqlite` directly or Drizzle ORM v1.0.0-beta.

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
| `agent_credentials` | Encrypted API keys + transport config — LOCAL CACHE of signaldock.db agent identity (see T234) |
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

### 3. `conduit.db` — Project-Tier Messaging (node:sqlite, TypeScript)

**Location**: `.cleo/conduit.db` (per-project)
**ORM**: `node:sqlite` `DatabaseSync` via `packages/core/src/store/conduit-sqlite.ts`
**Migration**: embedded DDL applied on first open (idempotent `CREATE TABLE IF NOT EXISTS`)
**ADR**: ADR-037 — conduit.db holds all project-local messaging state and the `project_agent_refs` override table

Tables: `conversations`, `messages`, `messages_fts` (FTS5), `delivery_jobs`, `dead_letters`, `message_pins`, `attachments`, `attachment_versions`, `attachment_approvals`, `attachment_contributors`, `project_agent_refs`.

`project_agent_refs` is a soft-FK reference table to `global signaldock.db:agents`. An agent must have an `enabled=1` row in this table to be visible to project-scoped queries (`cleo agent list`). See ADR-037 §3 for the full visibility contract.

### 4. `signaldock.db` — Global-Tier Agent Identity (node:sqlite, TypeScript)

**Location**: `$XDG_DATA_HOME/cleo/signaldock.db` (global — one per machine, NOT per-project)
**ORM**: `node:sqlite` `DatabaseSync` via `packages/core/src/store/signaldock-sqlite.ts`
**Migration**: embedded DDL applied on first open (idempotent)
**ADR**: ADR-037 — signaldock.db is the canonical cross-project agent identity registry

> **NOTE**: Prior to v2026.4.12, signaldock.db was a per-project file at `.cleo/signaldock.db`. The T310 migration moved agent identity to the global tier and created `conduit.db` for project-local messaging. See ADR-037 for the migration procedure.

Tables (canonical identity + cloud-sync): `agents`, `capabilities`, `skills`, `agent_capabilities`, `agent_skills`, `agent_connections`, `users`, `accounts`, `sessions`, `verifications`, `organization`, `claim_codes`, `org_agent_keys`.

#### Agent Visibility Model (ADR-037)

`cleo agent list` performs an INNER JOIN between `conduit.db:project_agent_refs` (enabled=1) and `global signaldock.db:agents`. An agent must be explicitly attached to a project to appear in project-scoped listing. Use `cleo agent list --global` to list all globally registered agents regardless of project attachment.

| CLI verb | Effect |
|---|---|
| `cleo agent attach <id>` | Creates `project_agent_refs` row (enabled=1) in current project's conduit.db |
| `cleo agent detach <id>` | Sets `project_agent_refs.enabled=0` (soft-delete; global identity preserved) |
| `cleo agent list` | INNER JOIN — shows only project-attached agents |
| `cleo agent list --global` | Full scan of global signaldock.db:agents |
| `cleo agent remove <id>` | Removes project ref only; does NOT touch global identity |
| `cleo agent remove --global <id>` | Deletes global identity row (warns if cross-project refs exist) |

> **Dual ORM note**: The server-side SignalDock platform (`crates/signaldock-storage/`) uses Diesel ORM
> with SQLite + PostgreSQL backends. The local CLEO-managed `signaldock.db` at
> `$XDG_DATA_HOME/cleo/signaldock.db` uses `node:sqlite` DatabaseSync via
> `packages/core/src/store/signaldock-sqlite.ts`.

#### API Key KDF (ADR-037 §5)

As of v2026.4.12, API keys use `HMAC-SHA256(machineKey || globalSalt, agentId)`. The `global-salt` file lives at `$XDG_DATA_HOME/cleo/global-salt` (32 bytes, 0o600). Loss of this file invalidates all stored API keys — agents must re-authenticate. See `packages/core/src/store/global-salt.ts` (T348) and `api-key-kdf.ts` (T349).

> **HISTORICAL NOTE**: Prior to v2026.4.12, signaldock.db was managed by Diesel ORM (Rust) and lived at `.cleo/signaldock.db` per-project. That architecture is superseded by ADR-037. The Diesel migration history above is retained for reference only.

---

## Global Databases

### 5. `nexus.db` — Cross-Project Routing

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

### 6. `telemetry.db` — CLI Telemetry (opt-in)

**Location**: `$XDG_DATA_HOME/cleo/telemetry.db` (global — one per machine, opt-in)
**ORM**: Drizzle ORM v1 beta (TypeScript, node:sqlite `DatabaseSync`)
**Migration**: `packages/core/migrations/drizzle-telemetry/` via `migration-manager.ts`
**Schema**: `packages/core/src/telemetry/schema.ts`
**Introduced by**: T624
**Baseline-reset**: T1176 (Wave 2A of T1150 T-MSR)

`telemetry.db` stores opt-in CLI telemetry events. It is managed exclusively by `@cleocode/core` — it is not tied to project init and is not created unless the user has opted in to telemetry. The database is not part of the per-project `.cleo/` directory.

| Table | Purpose |
|---|---|
| `telemetry_events` | Opt-in CLI command invocations and timing data |

> **Note**: This database does not participate in the project lifecycle (no `cleo init` interaction) and is not backed up by `cleo backup`. It is core-only: `cleo-os` and other harness layers interact with it only via the `cleo` CLI subprocess boundary (ADR-054 Appendix: Wave 4).

---

## Database Relationships

```
                    signaldock.db (node:sqlite, server: Diesel ORM) — AGENT SSoT
                    ┌──────────────────────────┐
                    │ agents (identity SSoT)    │
                    │ agent_connections         │
                    │ agent_capabilities/skills │
                    │ conversations, messages   │
                    │ delivery_jobs, dead_ltrs  │
                    │ users, accounts, sessions │
                    │ organization              │
                    │ attachments, message_pins │
                    │ messages_fts (FTS5)       │
                    └─────────┬────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │ soft FK       │ soft FK       │
              ▼               ▼               ▼
tasks.db (Drizzle)    brain.db (Drizzle)   nexus.db (GLOBAL)
┌─────────────────┐   ┌────────────────┐   ┌────────────────┐
│ tasks           │   │ observations   │   │ projectRegistry│
│ sessions        │   │ decisions      │   │ nexusAuditLog  │
│ agentInstances  │──▶│ patterns       │   │ warpChains     │
│ agent_credentials│  │ learnings      │   └────────────────┘
│ (encrypted keys │   │ memory_links   │
│  + transport —  │   └────────────────┘
│  CACHE of       │
│  signaldock.db) │
│ lifecycle       │
│ audit_log       │
└─────────────────┘

Data flow: signaldock.db → tasks.db (credential cache) → brain.db (soft refs)
Registration: cleo agent register → signaldock.db (SSoT) → tasks.db (cache)
Runtime: cleo agent start → TransportFactory → Local or HTTP Transport
```

**Cross-database relationships are soft FKs** (text IDs, no enforced foreign keys across database files). Application-layer write-guards (T185, T238) validate cross-DB references before insert. `reconcileOrphanedRefs()` cleans stale references during brain maintenance.

**SSoT Rule**: signaldock.db `agents` table is the single source of truth for agent identity. `tasks.db.agent_credentials` is a LOCAL CACHE of encrypted credentials — it MUST NOT be the primary registration target. `cleo agent register` writes to signaldock.db FIRST, then caches credentials locally.

---

## File System Layout

```
~/.local/share/cleo/             ← GLOBAL (env-paths / $XDG_DATA_HOME/cleo/)
├── nexus.db                     ← Cross-project NEXUS routing (global-tier)
├── signaldock.db                ← Agent identity SSoT (global-tier, moved from per-project in v2026.4.12)
├── telemetry.db                 ← Opt-in CLI telemetry (core-only, created only if opted in)
└── machine-key                  ← Encryption key for credentials

/path/to/project/.cleo/          ← PROJECT-LEVEL
├── tasks.db                     ← Tasks, sessions, lifecycle, ADRs, credentials
├── brain.db                     ← Knowledge: decisions, patterns, observations
├── conduit.db                   ← Project-tier agent messaging (ADR-037)
└── config.json                  ← Project configuration
```

---

## ORM Summary

**ORM Strategy**: TypeScript databases use Drizzle ORM v1.0.0-beta with `drizzle-orm/zod` validation. Rust databases use Diesel ORM with compile-time schema verification. Both provide full end-to-end type safety in their respective languages.

| Database | ORM | Language | Backend | Migration System |
|---|---|---|---|---|
| `tasks.db` | Drizzle ORM v1 beta | TypeScript (node:sqlite) | SQLite | `packages/core/migrations/drizzle-tasks/` via `migration-manager.ts` |
| `brain.db` | Drizzle ORM v1 beta | TypeScript (node:sqlite + sqlite-vec) | SQLite | `packages/core/migrations/drizzle-brain/` via `migration-manager.ts` |
| `conduit.db` | node:sqlite (embedded DDL) | TypeScript | SQLite | Embedded `CREATE TABLE IF NOT EXISTS` on first open |
| `nexus.db` | Drizzle ORM v1 beta | TypeScript (node:sqlite) | SQLite | `packages/core/migrations/drizzle-nexus/` via `migration-manager.ts` |
| `signaldock.db` | Diesel ORM (server) / node:sqlite (local) | Rust / TypeScript | SQLite (local) / PostgreSQL (cloud) | `packages/core/migrations/drizzle-signaldock/` (folder structure) + bespoke embedded runner |
| `telemetry.db` | Drizzle ORM v1 beta | TypeScript (node:sqlite) | SQLite | `packages/core/migrations/drizzle-telemetry/` via `migration-manager.ts` |

---

## Cloud vs Local

| Database | Local | Cloud (SignalDock server) |
|---|---|---|
| `tasks.db` | Per-project `.cleo/tasks.db` | N/A (CLEO-only, not on cloud) |
| `brain.db` | Per-project `.cleo/brain.db` | N/A (CLEO-only, not on cloud) |
| `conduit.db` | Per-project `.cleo/conduit.db` (SQLite) | N/A (local only — project messaging) |
| `signaldock.db` | Global `$XDG_DATA_HOME/cleo/signaldock.db` (SQLite) | PostgreSQL (production) or SQLite — cloud-sync tables preserved |
| `nexus.db` | Global `~/.local/share/cleo/nexus.db` | N/A (local NEXUS only; cloud has its own routing) |

The cloud SignalDock server uses the SAME `signaldock-storage` crate but typically connects to **PostgreSQL** in production (Railway). The schema is compatible across SQLite and Postgres — the crate abstracts the difference.

---

## Cloud Deployment Note

The cloud SignalDock server at `api.signaldock.io` uses the same `signaldock-storage` crate compiled with `diesel/postgres` feature, connecting to **PostgreSQL** in production (Railway). The Diesel backend abstraction handles SQLite vs Postgres differences transparently. The `better-auth-diesel` adapter (upgraded from `better-auth-diesel-sqlite`) connects to the same Postgres database for authentication.

The `tasks.db`, `brain.db`, and `nexus.db` databases are LOCAL-ONLY. They do not exist on the cloud server. The cloud server only has `signaldock.db` (or its Postgres equivalent).

<!-- merged from `cleo-data-integrity-spec` by cleo docs modernize -->

## From `cleo-data-integrity-spec`

---
version: 1.0.0
status: partially implemented
task: T4870
date: 2026-02-25
---

# CLEO Data Integrity Specification

*Note: `git-checkpoint.ts` exists and is partially implemented based on this specification.*

## 1. Git Checkpoint Isolation

CLEO checkpoints MUST be committed to a dedicated `.cleo/.git` repository, isolated from the project git repository.

The checkpoint system MUST NOT stage or commit files using the project's `.git` index.

The checkpoint git environment MUST be configured via `GIT_DIR=<cleoDir>/.git` and `GIT_WORK_TREE=<cleoDir>` environment variables passed to all git subprocesses.

State file paths in git commands MUST be relative to `<cleoDir>` (e.g., `config.json`, not `.cleo/config.json`).

The `initCleoGitRepo()` function MUST be idempotent -- it MUST check for the existence of `.cleo/.git/HEAD` before running `git init`.

The function `makeCleoGitEnv(cleoDir)` MUST return `{ GIT_DIR: join(cleoDir, '.git'), GIT_WORK_TREE: cleoDir }`.

The function `cleoGitCommand(args, cleoDir)` MUST pass the environment from `makeCleoGitEnv()` to all `execFileAsync('git', ...)` calls and MUST set `cwd` to `cleoDir`.

### Acceptance Criteria

- **AC1**: After `cleo init`, the file `.cleo/.git/HEAD` MUST exist.
- **AC2**: Running `git log --oneline` in the project root MUST show no `chore(cleo):` checkpoint commits.
- **AC3**: Pre-staging a project source file and triggering a checkpoint MUST NOT include that file in the `.cleo/.git` commit.

## 2. SQLite State Files in Git

SQLite state files MUST NOT appear in the `STATE_FILES` array in `packages/core/src/store/git-checkpoint.ts`.

These files MUST be listed in `.cleo/.gitignore` to prevent accidental tracking in the isolated `.cleo/.git` repository.

SQLite state files (MUST NOT be tracked in git per ADR-013 §9):
- `tasks.db`, `tasks.db-shm`, `tasks.db-wal`
- `brain.db`, `brain.db-shm`, `brain.db-wal`
- `conduit.db`, `conduit.db-shm`, `conduit.db-wal`
- `signaldock.db` (global tier — not in project `.cleo/` but at `$XDG_DATA_HOME/cleo/`)
- `nexus.db` (global tier — at `$XDG_DATA_HOME/cleo/`)

The `.cleo/.gitignore` MUST contain at minimum:

```
tasks.db
tasks.db-shm
tasks.db-wal
brain.db
brain.db-shm
brain.db-wal
conduit.db
conduit.db-shm
conduit.db-wal
.git/
```

> **Note**: `signaldock.db` and `nexus.db` are global-tier databases stored outside the project `.cleo/` directory (`$XDG_DATA_HOME/cleo/`). They are not subject to the project `.cleo/.gitignore` but MUST NOT be committed to any git repository.

### Acceptance Criteria

- **AC4**: The file `.cleo/.gitignore` MUST contain the entry `tasks.db`.
- **AC5**: The `STATE_FILES` array MUST contain no entries with a `.db` extension.

## 3. VACUUM INTO Backup System

When a SQLite backup is triggered, the system MUST first execute `PRAGMA wal_checkpoint(TRUNCATE)` to flush the WAL file before running `VACUUM INTO`.

The `vacuumIntoBackup()` function MUST obtain the native database handle via `getNativeDb()` from `packages/core/src/store/sqlite.ts`. If `getNativeDb()` returns `null`, the backup MUST be skipped silently (non-fatal).

The backup directory MUST be `.cleo/backups/sqlite/`.

Snapshot filenames MUST follow the pattern `tasks-YYYYMMDD-HHmmss.db`.

The system MUST retain at most 10 snapshots, deleting the oldest when the limit is exceeded.

Backup failures MUST be non-fatal -- the operation MUST log the error and continue without throwing.

The backup function MUST implement debouncing to avoid excessive I/O during high-write sessions. The debounce interval SHOULD match the git checkpoint debounce (configurable, default 5 minutes).

The `vacuumIntoBackup()` function MUST be called alongside `gitCheckpoint()` at all checkpoint trigger sites:
- `packages/core/src/store/data-safety.ts:206` via `triggerCheckpoint()`
- `packages/core/src/store/data-safety-central.ts:125` via `checkpoint()` helper
- `packages/core/src/store/data-safety-central.ts:393` via `forceSafetyCheckpoint()`
- `packages/core/src/store/data-safety.ts:396` via `forceCheckpointBeforeOperation()`

### Acceptance Criteria

- **AC6**: After a write operation, a `.db` file MUST exist in `.cleo/backups/sqlite/`.
- **AC7**: After 11 write operations, the number of files in `.cleo/backups/sqlite/` MUST be <=10.
- **AC8**: Any snapshot in `.cleo/backups/sqlite/` MUST be a valid, readable SQLite database.
- **AC9**: Copying a snapshot to `.cleo/tasks.db` and running `cleo dash` MUST succeed without errors.

## 4. Integration Requirements

`cleo init` MUST initialize the `.cleo/.git` repository via `initCleoGitRepo()` if it does not already exist. This step MUST execute after core files are created (step 1 in `initProject()` at `packages/core/src/init.ts:759`) and before all subsequent initialization steps.

`cleo doctor` MUST include a `cleo_git_repo` health check that reports `warn` status if `.cleo/.git/HEAD` does not exist, using the standard check shape: `{ check: string, status: 'ok' | 'warning' | 'error', message: string, details?: Record<string, unknown> }`.

The `shouldCheckpoint()` function MUST include an `isCleoGitInitialized()` guard that returns `false` when `.cleo/.git/HEAD` does not exist, preventing checkpoint attempts before the isolated repo is initialized.

The `vacuumIntoBackup()` function MUST be called alongside `gitCheckpoint()` at all checkpoint trigger sites in `packages/core/src/store/data-safety.ts` and `packages/core/src/store/data-safety-central.ts`.

### Acceptance Criteria

- **AC10**: Running `cleo init` on a fresh project MUST create `.cleo/.git/HEAD`.
- **AC11**: Running `cleo doctor` when `.cleo/.git` does not exist MUST produce a check with `status: 'warning'` and `check: 'cleo_git_repo'`.

<!-- merged from `schema-authority` by cleo docs modernize -->

## From `schema-authority`

# Schema Authority

This document defines how to interpret CLEO schema state and migration history.

## Canonical Sources

1. The schema files below are the single source of truth for current DB structure, constraints, and types:
   - `packages/core/src/store/tasks-schema.ts` — tasks.db (tasks, sessions, lifecycle, audit, agents, token usage, WarpChain, ADR)
   - `packages/core/src/store/brain-schema.ts` — brain.db (decisions, patterns, learnings, observations, graph)
   - `packages/core/src/store/chain-schema.ts` — WarpChain tables (re-exported from tasks-schema.ts)
   - `packages/core/src/agents/agent-schema.ts` — agent_instances, agent_error_log tables (re-exported from tasks-schema.ts)
   - `packages/core/src/store/nexus-schema.ts` — nexus.db (project_registry, nexus_audit_log)
   - `packages/core/src/store/conduit-sqlite.ts` — conduit.db DDL (project-tier messaging, project_agent_refs)
   - `packages/core/src/store/signaldock-sqlite.ts` — signaldock.db DDL (global-tier agent identity)
   - `packages/contracts/src/status-registry.ts` — canonical status enum constants (SSoT per ADR-018)
2. The latest effective migration state under `packages/core/migrations/` is the runtime DDL history:
   - `drizzle-tasks/` — tasks.db migrations
   - `drizzle-brain/` — brain.db migrations
3. `packages/core/src/store/tasks-schema.ts` also exports all lifecycle stage constant names via `LIFECYCLE_STAGE_NAMES`.

> **Note**: The legacy `packages/core/src/store/schema.ts` no longer exists. All references to it should point to `tasks-schema.ts` instead.

## Migration History Rules

- Historical migration files MAY contain superseded intermediate constraints.
- Do not treat an older migration file as the current schema by itself.
- Always compare current behavior against `packages/core/src/store/schema.ts` plus latest effective migration state.

## Validation Guardrails

- Lifecycle parity guardrail: `packages/core/src/store/__tests__/lifecycle-schema-parity.test.ts`
- Recovery DDL anti-hardcoding guardrail: `packages/core/src/store/__tests__/recover-tooling-guardrail.test.ts`
- AJV canonical path checks: `packages/core/src/__tests__/schema.test.ts`

## Contributor Checklist

1. Update schema definitions in the appropriate file under `packages/core/src/store/` (see Canonical Sources above).
   - Status enums go in `packages/contracts/src/status-registry.ts` only (ADR-018).
   - Do not duplicate status constants in schema files.
2. Generate/update migrations under `packages/core/migrations/drizzle-tasks/` or `drizzle-brain/`.
3. Run guardrails:
   - `pnpm vitest run packages/core/src/store/__tests__/lifecycle-schema-parity.test.ts`
   - `pnpm vitest run packages/core/src/store/__tests__/recover-tooling-guardrail.test.ts`
4. Run typecheck: `pnpm tsc --noEmit`.
5. Run biome: `pnpm biome check --write .`
6. Commit schema + migration + tests/docs together (single coherent change set).
7. Update `docs/architecture/DATABASE-ERDS.md` to reflect any table/column/index changes.

## Related ADRs

- `/docs/adr/adr-012-drizzle-kit-migration-system.md` (Section 8)
- `/docs/adr/adr-006-canonical-sqlite-storage.md`
- `/docs/adr/adr-008-cleo-canonical-architecture.md`
