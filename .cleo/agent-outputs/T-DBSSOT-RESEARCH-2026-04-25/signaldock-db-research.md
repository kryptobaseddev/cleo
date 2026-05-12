# Signaldock DB Research (2026-04-25)

## TL;DR

- **SSoT Authority**: TypeScript (TS) is now the canonical single source of truth as of T1166 (2026-04-21). The TS schema at `packages/core/src/store/signaldock-schema.ts` reverse-engineered the T897 Diesel migration and is the baseline for all subsequent signaldock.db mutations.
- **Divergence**: Rust Diesel migrations in `crates/signaldock-storage/` and their src/migrations variants (postgres/sqlite/) were authored for a different purpose (cloud PostgreSQL + cross-project messaging). They define a superset (26 tables including conversations, messages, delivery_jobs, attachments) vs. the TS global-only subset (13 tables: identity + cloud-sync only).
- **Action**: Signaldock.db has been formalized as global-tier identity SSoT via TS as of T310/T1166. Rust Diesel migrations should be sunset or repurposed for cloud deployment (out of scope for local SQLite baseline). Drizzle-kit unification in migration-runner is complete; signaldock.db is now included.

---

## Evidence

### 1. TypeScript Side (Current SSoT as of T1166)

**File**: `/mnt/projects/cleocode/packages/core/src/store/signaldock-schema.ts`
- **Lines**: 436 total (TSDoc + 13 `sqliteTable` definitions + type exports)
- **Defined Tables (13 total)**:
  1. `users` (line 52) — Cloud-sync user accounts
  2. `organization` (line 81) — Cloud-sync org/team records  
  3. `agents` (line 113) — **Canonical global identity registry** (27 columns with T897 v3 extensions)
  4. `claimCodes` (line 192) — One-time agent claim tokens
  5. `capabilities` (line 215) — Pre-seeded catalog (19 entries)
  6. `skills` (line 227) — Pre-seeded catalog (36 entries)
  7. `agentCapabilities` (line 243) — Junction table
  8. `agentSkills` (line 263) — Junction table (T897 v3: added `source` + `attached_at` columns)
  9. `agentConnections` (line 290) — Live heartbeat tracking
  10. `accounts` (line 317) — OAuth/provider accounts (better-auth)
  11. `sessions` (line 345) — Authenticated sessions (better-auth)
  12. `verifications` (line 368) — Email/2FA verification tokens (better-auth)
  13. `orgAgentKeys` (line 388) — Org-scoped API keys

**Key T897 v3 Columns on `agents` table (lines 150-165)**:
  - `tier`: 'project' | 'global' | 'packaged' | 'fallback' (default: 'global')
  - `canSpawn`: Boolean (can spawn sub-agents)
  - `orchLevel`: 0=worker | 1=lead | 2=orchestrator
  - `reportsTo`: Parent agent ID (hierarchy)
  - `cantPath`, `cantSha256`: CANT file provenance  
  - `installedFrom`: 'seed' | 'user' | 'manual'
  - `installedAt`: ISO 8601 timestamp

**Migration Folder**: `/mnt/projects/cleocode/packages/core/migrations/drizzle-signaldock/`
- **Drizzle Migration**: `20260412000000_initial-global-signaldock/migration.sql` (209 lines)
  - Timestamp: 2026-04-12 00:00:00 (consolidated, reverse-engineered from T897 SQL)
  - Snapshot: paired `snapshot.json` (2060 lines for Drizzle v1 introspection)

**Schema Version Constant**:
- **TS Location**: `packages/core/src/store/signaldock-sqlite.ts` line 52
- **Value**: `GLOBAL_SIGNALDOCK_SCHEMA_VERSION = '2026.4.12'` (date-based semantic versioning)
- **Last Bumped**: T1166 commit `f507fd76` (2026-04-21), "feat(T1166): signaldock-schema.ts + standard migration folder + drizzle runner"
- **Reason**: Formalized signaldock.db as global-tier SSoT with standard drizzle pipeline

**Migration Runner** (line 159-175 in signaldock-sqlite.ts):
- Uses `migrateSanitized()` + `reconcileJournal()` (migration-manager.ts)
- Reconciliation handles existing DBs that had schema applied via old bare-SQL runner (Scenario 1 bootstrap)
- Resolves via `resolveCorePackageMigrationsFolder('drizzle-signaldock')`

---

### 2. Rust Side (Diesel Migrations — Secondary Authority)

**Rust Crates Found**:
1. `/mnt/projects/cleocode/crates/signaldock-core`
2. `/mnt/projects/cleocode/crates/signaldock-payments`
3. `/mnt/projects/cleocode/crates/signaldock-protocol`
4. `/mnt/projects/cleocode/crates/signaldock-runtime`
5. `/mnt/projects/cleocode/crates/signaldock-sdk`
6. `/mnt/projects/cleocode/crates/signaldock-storage` — **Contains migrations**
7. `/mnt/projects/cleocode/crates/signaldock-transport`

**Diesel Migrations in signaldock-storage**:

**Location**: `/mnt/projects/cleocode/crates/signaldock-storage/migrations/`
- **Count**: 3 Diesel migrations (numbered by date-tag)
  1. `2026-03-28-000000_initial/` (up.sql, down.sql)
  2. `2026-03-30-000001_agent_connections/` 
  3. `2026-03-31-000001_agent_credentials/`

**Consolidated Initial Migration** (2026-03-28-000000_initial/up.sql):
- **Lines**: 648 (consolidated from 19 prior sqlx migrations 0001–0019)
- **Source migrations documented** (lines 2-24):
  - 0001_initial: users, agents, conversations, messages, claim_codes, connections
  - 0002_attachments: messages.attachments column
  - ... (0003–0019 listed, including 0018_attachment_versioning, 0019_better_auth_slug_columns)
- **Tables Created (26 total)**: 
  - **Global identity** (core, same as TS): users, agents, organization, claim_codes, capabilities, skills, agent_capabilities, agent_skills, agent_connections, accounts, sessions, verifications, org_agent_keys
  - **Project-tier messaging** (NOT in TS global schema): conversations, messages, delivery_jobs, dead_letters, message_pins, attachments, attachment_versions, attachment_approvals, attachment_contributors, connections (agent-to-agent connections)

**PostgreSQL Migrations** (cloud variant):
- **Location**: `/mnt/projects/cleocode/crates/signaldock-storage/src/migrations/postgres/`
- **Count**: 11 SQL files (variant schema for PostgreSQL backend)
  - Same numbering scheme as SQLite (0001, 0002, 0003, etc.)
  - Files: 0001_initial, 0002_attachments, 0003_payment_config, 0004_delivery_jobs, 0006_message_group_id, 0007_agent_api_key_hash, 0008_message_metadata, 0009_reply_to, 0011_message_pins, 0018_attachment_versioning, 0019_agent_and_user_columns
  - Note: 0005 and 0010 omitted (FTS5 virtual table is SQLite-only)

**SQLite Migrations** (Rust src variant):
- **Location**: `/mnt/projects/cleocode/crates/signaldock-storage/src/migrations/sqlite/`
- **Count**: 19+ SQL files (granular, pre-consolidation variant for development)
- Same progressive numbering as PostgreSQL variant

**Owner Crate**: `signaldock-storage` (purpose: Diesel repository trait + adapters for both SQLite and PostgreSQL backends per lib.rs lines 1-26)

---

### 3. Schema Agreement Check

| Table | In TS (Global)? | In Rust Diesel (SQLite)? | In Cloud (PostgreSQL)? | TS Version | Rust Version | Divergence Notes |
|-------|-----------------|--------------------------|------------------------|----------|----------|------------------|
| users | YES (52) | YES (0001 lines 30-50) | YES | password_hash, better-auth cols | password_hash, better-auth cols | **MATCH** |
| organization | YES (81) | YES (0001 lines 58-69) | YES | Better-auth slug columns | Better-auth slug columns | **MATCH** |
| agents | YES (113) | YES (0001 lines 75-102) | YES | 27 cols incl. T897 v3 (tier, orch_level, cant_path, etc.) | No T897 v3 cols documented in Diesel 0001 | **DIVERGE**: TS has T897 v3, Rust initial does not |
| claim_codes | YES (192) | YES (0001 lines 163-175) | YES | Matching | Matching | **MATCH** |
| capabilities | YES (215) | YES (0001 lines 307-314) | YES | slug, name, description, category | slug, name, description, category | **MATCH** |
| skills | YES (227) | YES (0001 lines 316-323) | YES | slug, name, description, category | slug, name, description, category | **MATCH** |
| agent_capabilities | YES (243) | YES (0001 lines 325-329) | YES | PK(agent_id, capability_id) | PK(agent_id, capability_id) | **MATCH** |
| agent_skills | YES (263) | YES (0001 lines 331-335) | YES | source, attached_at (T897 v3) | No source/attached_at in Diesel 0001 | **DIVERGE**: TS v3, Rust missing v3 |
| agent_connections | YES (290) | YES (0001 lines 180-188 as `connections`) | Partial | heartbeat tracking; agent_id indexed | Different: agent_a/agent_b linking agents directly | **DIVERGE**: TS is heartbeat tracking; Rust is agent-to-agent connection state |
| accounts | YES (317) | YES (0001 lines 518-535) | YES | better-auth OAuth table | better-auth OAuth table | **MATCH** |
| sessions | YES (345) | YES (0001 lines 537-551) | YES | better-auth sessions | better-auth sessions | **MATCH** |
| verifications | YES (368) | YES (0001 lines 554-563) | YES | better-auth verification tokens | better-auth verification tokens | **MATCH** |
| org_agent_keys | YES (388) | YES (0001 lines 582-591) | YES | org-scoped API keys | org-scoped API keys | **MATCH** |
| conversations | NO | YES (0001 lines 117-125) | YES | Project-tier messaging (in conduit.db post-T310) | Project-tier messaging | **EXCLUDED**: TS intentionally omits (global-only mandate per ADR-037) |
| messages | NO | YES (0001 lines 131-150) | YES | Project-tier messaging | Project-tier messaging | **EXCLUDED**: TS intentionally omits |
| delivery_jobs | NO | YES (0001 lines 196-210) | YES | Project-tier queue | Project-tier queue | **EXCLUDED**: TS intentionally omits |
| dead_letters | NO | YES (0001 lines 216-225) | YES | Project-tier queue | Project-tier queue | **EXCLUDED**: TS intentionally omits |
| message_pins | NO | YES (0001 lines 263-274) | YES | Project-tier message metadata | Project-tier message metadata | **EXCLUDED**: TS intentionally omits |
| attachments | NO | YES (0001 lines 280-301) | YES | Project-tier attachments | Project-tier attachments | **EXCLUDED**: TS intentionally omits |
| attachment_versions | NO | YES (0001 lines 601-622) | YES | Project-tier versioning | Project-tier versioning | **EXCLUDED**: TS intentionally omits |
| attachment_approvals | NO | YES (0001 lines 624-634) | YES | Project-tier approvals | Project-tier approvals | **EXCLUDED**: TS intentionally omits |
| attachment_contributors | NO | YES (0001 lines 638-647) | YES | Project-tier contributor tracking | Project-tier contributor tracking | **EXCLUDED**: TS intentionally omits |
| connections | NO | YES (0001 lines 180-191) | Implied | Agent-to-agent connections; post-T310 this is in conduit.db | Agent-to-agent connections | **EXCLUDED**: TS global-only, connections moved to conduit.db (T344) |

**Key Findings**:
1. **Intentional Schema Split**: Rust Diesel schema includes 26 tables (global identity + project messaging). TS includes only 13 (global identity + cloud-sync). The 13 messaging tables (conversations, messages, etc.) are explicitly EXCLUDED per ADR-037 § Decision #2. Post-T310 (April 2026), project-tier messaging moved to `conduit.db`; global tier (`signaldock.db`) holds identity only.

2. **T897 v3 Asymmetry**: Rust Diesel migrations in `crates/signaldock-storage/migrations/2026-03-28-000000_initial/up.sql` do NOT include T897 v3 columns (`tier`, `orch_level`, `can_spawn`, `cant_path`, `cant_sha256`, `installed_from`, `installed_at`). TS `signaldock-schema.ts` (authored 2026-04-21 during T1166) includes them. Rust crate was authored 2026-03-28, before T897 v3 landed (2026-04-12).

3. **Runtime Write Authority**: Only TypeScript opens `signaldock.db` at runtime. Rust binaries in `crates/signaldock-storage` provide repository trait abstractions but do NOT directly open the file in the CLEO application runtime. The `DieselStore` adapter is designed for cloud PostgreSQL deployments, not local SQLite baseline.

---

### 4. Runtime Ownership

**Production Write Path**: TypeScript only
- **Init/Setup**: `packages/cleo/src/cli/index.ts` line 414 calls `ensureGlobalSignaldockDb()` during `cleo init`
- **Agent Registry Writes**: `packages/cleo/src/cli/commands/agent.ts` lines 2163-2170 (global agent registration, destructive removal)
- **Backup Integration**: `packages/core/src/store/signaldock-sqlite.ts` line 390 exports `getGlobalSignaldockNativeDb()` for backup snapshots
- **Brain Adapter Read**: `packages/brain/src/adapters/signaldock.ts` queries signaldock.db for BrainNode/BrainEdge population

**Read Path**: TypeScript + CLI commands
- `packages/brain/src/db-connections.ts` line 103 caches a read-only global signaldock.db connection
- `packages/cleo/src/cli/commands/agent.ts` reads agents for validation/repair

**Rust Crates**: Design-time only (not runtime)
- `crates/signaldock-storage` provides trait abstractions + Diesel adapters
- Used by cloud backend services (out of process) and cloud migration utilities
- Does NOT touch the local `signaldock.db` file in production CLEO CLI usage

---

### 5. Schema Version

**TypeScript Constant**:
- **Location**: `packages/core/src/store/signaldock-sqlite.ts` line 52
- **Value**: `'2026.4.12'`
- **Format**: YYYY.MM.DD (date-based semantic versioning, introduced post-T310)
- **Last Bumped**: 2026-04-21, commit `f507fd76` (feat T1166)
- **Previous Variant** (deprecated): Line 58 exports `SIGNALDOCK_SCHEMA_VERSION` as alias for migration compatibility (retained during T310 window, T355 cleanup deferred)

**Rust Constants** (if any):
- No schema version constant found in Rust crates that corresponds to signaldock.db runtime
- Diesel migrations use ordered directory names (2026-03-28, 2026-03-30, 2026-03-31) for sequencing
- `src/migrations/` variants are pre-consolidated (used in development/testing, not production)

**Cloud Constant**: 
- No separate cloud PostgreSQL version constant; Diesel migrations in `src/migrations/postgres/` follow the same sequence as SQLite variants
- Cloud deployment uses the same schema evolution as local (via shared `signaldock-storage` crate adapters)

---

### 6. Cloud Mode

**PostgreSQL Schema Location**: 
- **File**: `/mnt/projects/cleocode/crates/signaldock-storage/src/migrations/postgres/` (11 variant SQL files)
- **Authority**: Diesel ORM (Rust, cloud-only deployment path)
- **Schema**: 26 tables (same as Rust Diesel SQLite variant, including project-tier messaging tables for cloud workloads)

**Sync Mechanism**:
- Not explicitly defined in signaldock-schema.ts or signaldock-sqlite.ts
- Cloud sync is intended via API (api.signaldock.io) + cloud-sync tables (`users`, `accounts`, `sessions`, `verifications`, `organization`, `claim_codes`) that hold zero rows in pure-local mode
- Push/pull sync logic not in scope of TS schema authority (schema is schema; sync is application logic)

**Divergence from Local**:
- Local signaldock.db (TS authority): 13 tables, global-only, identity + cloud-sync-ready
- Cloud PostgreSQL (Rust Diesel authority): 26 tables, includes project messaging tables for cloud multi-tenant workloads
- **Rationale**: Cloud backend handles full messaging history; local CLEO uses global identity only + conduit.db for project messaging

---

## Recommendation for SSoT Scope

### Which Authority is Canonical?

**Answer: TypeScript (TS) is now canonical for signaldock.db schema as of 2026-04-21 (T1166).**

**Rationale**:
1. **T1166 Formalization** (commit `f507fd76`): TS `signaldock-schema.ts` reverse-engineered the existing Diesel T897 migration into standardized drizzle-kit form. This was a deliberate act to bring signaldock.db into the same managed migration pipeline as tasks.db, brain.db, nexus.db, and telemetry.db.
2. **Runtime Authority**: Only TS code opens signaldock.db in production CLEO CLI. Rust Diesel adapters are design-time abstractions for cloud backends.
3. **Schema Governance**: ADR-054 (2026-04-21) established signaldock.db as "Hybrid Path A+" — using `migrateSanitized()` + `reconcileJournal()` from migration-manager.ts, the same reconciler used for all other databases.
4. **T310/ADR-037 Mandate**: Signaldock.db is global-tier identity SSoT. TS schema correctly excludes project-tier messaging tables (which post-T310 live in conduit.db). Rust Diesel migrations include those tables because Rust crate is designed for cloud multi-tenant workloads, not local CLI baseline.

### What Does It Take to Make It a Single SSoT?

**Current Status**: Single TS authority is already established. Rust migrations are secondary (for cloud deployment).

**Work Items to Enforce**:
1. **Mark Rust Diesel migrations as "cloud-only"**: Add a README in `crates/signaldock-storage/migrations/` stating that Diesel migrations are for PostgreSQL cloud workloads only. Local SQLite baseline is governed by TS schema + drizzle migrations.
2. **Document T897 v3 in Rust**: Add T897 v3 columns (`tier`, `orch_level`, `can_spawn`, `cant_path`, `cant_sha256`, `installed_from`, `installed_at`) to Rust schema or mark them as "applied out-of-band by cloud migration utility" (deferred to future task).
3. **Lock signaldock-schema.ts**: Establish a policy that all future schema mutations to signaldock.db MUST be authored as drizzle migrations in `packages/core/migrations/drizzle-signaldock/` + reflected in `signaldock-schema.ts`. Ad-hoc SQL changes are prohibited.
4. **Link cloud sync docs**: Document (in ADR-054 or a follow-up) how cloud PostgreSQL stays in sync with local schema (e.g., cloud migration jobs consume the same TS schema authority or maintain their own, with explicit sync contract).

### Should signaldock.db be Included in Migration-Runner Unification?

**Answer: YES, it is already included as of T1166.**

**Evidence**:
- Drizzle migration folder: `packages/core/migrations/drizzle-signaldock/20260412000000_initial-global-signaldock/`
- Runtime runner: `signaldock-sqlite.ts` lines 159-175 calls `migrateSanitized()` and `reconcileJournal()`
- Config: `drizzle/signaldock.config.ts` (finalized in T1166, line 18 references canonical `packages/core/migrations/drizzle-signaldock`)
- Test coverage: `migration-smoke.test.ts` + `migration-v3-columns.test.ts` include signaldock DB tests

**Unification Complete**: Signaldock.db is now on equal footing with tasks/brain/nexus/telemetry in the drizzle pipeline.

---

## Technical Debt & Open Questions

1. **T897 v3 in Rust**: Rust Diesel initial migration (2026-03-28) predates T897 v3 (2026-04-12). Either (a) apply T897 v3 columns in a new Diesel migration, or (b) document that cloud workloads receive v3 columns via a separate migration utility.

2. **Cloud Sync Contract**: How does api.signaldock.io push schema mutations from cloud PostgreSQL back to local signaldock.db? Is there a separate sync migration job, or does the local CLI always lead?

3. **Conduit.db Messaging**: Post-T310, messaging tables (conversations, messages, delivery_jobs, etc.) moved to conduit.db. Are these still in cloud PostgreSQL schema? If yes, we have a permanent schema divergence between cloud and local.

4. **Diesel Deprecation**: Should `crates/signaldock-storage/migrations/` and `src/migrations/` be sunset in favor of a single cloud migration authority, or are they used by active services?

---

## Summary Table

| Aspect | TS (signaldock-schema.ts) | Rust Diesel (signaldock-storage) | Cloud PostgreSQL |
|--------|--------------------------|----------------------------------|------------------|
| **Authority Level** | PRIMARY (runtime, canonical) | Secondary (cloud, design-time) | Derived (via Diesel) |
| **Tables** | 13 (global identity + cloud-sync) | 26 (identity + project messaging) | 26 (identity + project messaging) |
| **Version** | `2026.4.12` (date-based) | `2026-03-28` (Diesel directory tag) | Same as Rust |
| **T897 v3** | YES (tier, orch_level, cant_path, etc.) | NO (awaiting future migration) | Likely NO (same source as Rust) |
| **Write Ownership** | TypeScript CLI (signaldock-sqlite.ts) | N/A (cloud-only) | Cloud service |
| **Migration Runner** | `migrateSanitized()` + `reconcileJournal()` | Diesel CLI (not CLEO CLI) | Diesel async (cloud runtime) |
| **Last Mutation** | T1166 (2026-04-21) reverse-engineered T897 into drizzle | T897 was authored before Diesel consolidated (2026-03-28 → 2026-04-12) | TBD |

