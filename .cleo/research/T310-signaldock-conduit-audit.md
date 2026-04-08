---
task: T312
epic: T310
type: research
pipeline_stage: research
created: 2026-04-08
feeds_into: [T310-consensus, ADR-037, T310-specification, T310-decomposition]
---

# T310 Research: Signaldock + Conduit Topology Audit

> Read-only investigation. Output feeds Consensus → ADR-037 → Spec → Decomposition.

---

## Section 1: Current Project-Tier `.cleo/signaldock.db` Schema

Live database inspected at `/mnt/projects/cleocode/.cleo/signaldock.db` using
`sqlite3 .schema` and per-table `count(*)` queries. Schema version: `2026.3.76`
(3 migrations applied).

### Tables and Row Counts

| Table | Purpose | Row Count | Notes |
|---|---|---|---|
| `users` | User accounts (better-auth compat) | 0 | Unused locally — cloud-only concept |
| `organization` | Org/team records | 0 | Unused locally |
| `agents` | Agent identity + credentials | **2** | Two agents registered: `cleo-prime-dev`, `cleo-prime` |
| `conversations` | Conversation threads | 2 | DM conversations between agents |
| `messages` | Agent-to-agent messages | 4 | Stored by LocalTransport |
| `claim_codes` | One-time agent claim tokens | 0 | Cloud concept, unused locally |
| `connections` | Agent friendship/follow graph | 0 | Social graph, unused locally |
| `delivery_jobs` | Async message delivery queue | 0 | Cloud-delivery queue |
| `dead_letters` | Failed delivery archive | 0 | Cloud-delivery dead-letter queue |
| `message_pins` | Pinned messages per conversation | 0 | Unused |
| `attachments` | File/blob attachments to messages | 0 | Unused locally |
| `capabilities` | Capability catalog (slugs) | 19 | Pre-seeded catalog entries |
| `skills` | Skills catalog (slugs) | 36 | Pre-seeded catalog entries |
| `agent_capabilities` | Junction: agents ↔ capabilities | 0 | Junction table |
| `agent_skills` | Junction: agents ↔ skills | 0 | Junction table |
| `accounts` | OAuth/provider accounts | 0 | better-auth compat, cloud-only |
| `sessions` | Auth sessions | 0 | Cloud-only |
| `verifications` | Email/2FA verification tokens | 0 | Cloud-only |
| `org_agent_keys` | Org-scoped agent API keys | 0 | Unused |
| `attachment_versions` | Version history for attachments | 0 | Unused |
| `attachment_approvals` | Attachment review records | 0 | Unused |
| `attachment_contributors` | Contributor stats per attachment | 0 | Unused |
| `agent_connections` | Live transport connection records | 0 | Connection heartbeat tracking |
| `_signaldock_meta` | Schema metadata (version key) | 1 | `schema_version = 2026.3.76` |
| `_signaldock_migrations` | Applied migration tracking | 3 | Three migrations applied |

**Total: 26 tables** (including FTS virtual tables for full-text search on `messages`).

### agents Table — Full Column Set

The `agents` table is the most important for T310. It was built over three migrations:

| Column | Type | Constraint | Migration | Purpose |
|---|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | initial | Internal SQLite UUID |
| `agent_id` | TEXT | NOT NULL UNIQUE | initial | Business-level agent identifier (e.g. `cleo-prime`) |
| `name` | TEXT | NOT NULL | initial | Display name |
| `description` | TEXT | nullable | initial | Optional description |
| `class` | TEXT | DEFAULT 'custom' | initial | Agent class |
| `privacy_tier` | TEXT | DEFAULT 'public' | initial | Visibility tier |
| `owner_id` | TEXT | FK → users(id) | initial | Unused locally (no users) |
| `endpoint` | TEXT | nullable | initial | Webhook endpoint |
| `webhook_secret` | TEXT | nullable | initial | Webhook HMAC secret |
| `capabilities` | TEXT | DEFAULT '[]' | initial | JSON array (denormalized cache) |
| `skills` | TEXT | DEFAULT '[]' | initial | JSON array (denormalized cache) |
| `avatar` | TEXT | nullable | initial | Avatar URL |
| `messages_sent` | INTEGER | DEFAULT 0 | initial | Counter (cloud use) |
| `messages_received` | INTEGER | DEFAULT 0 | initial | Counter |
| `conversation_count` | INTEGER | DEFAULT 0 | initial | Counter |
| `friend_count` | INTEGER | DEFAULT 0 | initial | Social graph counter |
| `status` | TEXT | DEFAULT 'online' | initial | Online presence |
| `last_seen` | INTEGER | nullable | initial | Unix timestamp |
| `payment_config` | TEXT | nullable | initial | Cloud billing — unused locally |
| `api_key_hash` | TEXT | nullable | initial | Legacy hash field — superseded by `api_key_encrypted` |
| `organization_id` | TEXT | FK → organization(id) | initial | Org membership — unused locally |
| `created_at` | INTEGER | NOT NULL | initial | Unix timestamp |
| `updated_at` | INTEGER | NOT NULL | initial | Unix timestamp |
| `transport_type` | TEXT | DEFAULT 'http' | agent_connections | Transport mode |
| `api_key_encrypted` | TEXT | nullable | agent_credentials | AES-256-GCM encrypted API key |
| `api_base_url` | TEXT | DEFAULT 'https://api.signaldock.io' | agent_credentials | Cloud endpoint |
| `classification` | TEXT | nullable | agent_credentials | Agent classification tag |
| `transport_config` | TEXT | DEFAULT '{}' | agent_credentials | JSON transport config |
| `is_active` | INTEGER | DEFAULT 1 | agent_credentials | Active flag |
| `last_used_at` | INTEGER | nullable | agent_credentials | Unix timestamp last use |

**Surprising findings:**
- 11 columns (`users`, `organization`, `accounts`, `sessions`, `payment_config`, `api_key_hash`,
  `friend_count`, `connection_count`) are cloud-only concepts with zero local data. These columns
  were inherited wholesale from the cloud Rust Diesel schema (signaldock-storage crate) when the
  embedded migration SQL was consolidated for T223.
- `api_key_hash` (legacy) and `api_key_encrypted` (current) both exist; the codebase only writes
  to `api_key_encrypted`. The legacy column is cruft from the initial migration.
- The `users` table has 19 columns but 0 rows locally. Any T310 migration that splits agent
  identity into a global store can drop user/org/auth tables from the project-tier schema entirely.

### messages Table

`messages` contains 4 rows from LocalTransport DM exchanges between `cleo-prime-dev` and
`cleo-prime` within the project. This is genuine project-local data that should migrate to
`conduit.db` under T310.

### FTS Virtual Table

`messages_fts` is a FTS5 virtual table with triggers on `messages` for full-text search. It is
tightly coupled to the `messages` table. Any rename of the messages physical location must migrate
the FTS table with it.

### Indices

All indices are consistent with the initial migration. Notably:
- `agents_agent_id_idx` — unique index on `agent_id` (business key)
- `idx_agents_is_active`, `idx_agents_last_used` — added by agent_credentials migration
- `messages_*` indices — covering conversation, sender, recipient, timestamp for poll queries
- `idx_delivery_jobs_status` — composite on (status, next_attempt_at) for queue polling

---

## Section 2: Code Organization Inventory

### signaldock-sqlite.ts inventory

File: `packages/core/src/store/signaldock-sqlite.ts` (430 lines)

| Symbol | Signature | Responsibility | Read/Write |
|---|---|---|---|
| `DB_FILENAME` | `const string = 'signaldock.db'` | Filename constant for project-tier DB | — |
| `SIGNALDOCK_SCHEMA_VERSION` | `export const string = '2026.3.76'` | Schema version tag exported for health checks | — |
| `EMBEDDED_MIGRATIONS` | `const Array<{name, sql}>` | Inline migration SQL array (3 entries from Rust Diesel source) | — |
| `getSignaldockDbPath` | `(cwd?: string) => string` | Resolves `.cleo/signaldock.db` absolute path | — |
| `ensureSignaldockDb` | `async (cwd?) => {action, path}` | Idempotent: creates DB, runs migrations, records version | **Write** |
| `checkSignaldockDbHealth` | `async (cwd?) => health \| null` | Reads table count, WAL mode, schema version | **Read** |

Key observations:
- `getSignaldockDbPath` always resolves to `.cleo/signaldock.db` relative to a project dir. There
  is no concept of a global path in this file. The T310 global tier would require a new export like
  `getGlobalSignaldockDbPath()`.
- `ensureSignaldockDb` embeds the full migration SQL inline. This was done because the project-tier
  DB needs to work in ANY project clone, not just the monorepo where the Rust crate lives.
- The embedded SQL is a verbatim consolidation of 19+ Rust Diesel migrations. It includes cloud
  infrastructure tables (users, sessions, accounts, verifications, org_agent_keys) that have zero
  local use. This schema is substantially over-spec'd for a local project agent registry.
- `openDb` (private helper in agent-registry-accessor.ts) uses `DatabaseSync` directly. There is
  no connection pooling or singleton pattern. Each operation opens and closes the DB independently.

### agent-registry-accessor.ts inventory

File: `packages/core/src/store/agent-registry-accessor.ts` (376 lines)

| Symbol | Signature | Responsibility | Read/Write |
|---|---|---|---|
| `AgentDbRow` | `interface` | Shape of raw DB row from `agents` table | — |
| `rowToCredential` | `async (row, projectPath) => AgentCredential` | Decrypts `api_key_encrypted` via AES-256-GCM, maps to contract type | **Read** |
| `openDb` | `(projectPath) => DatabaseSync` | Opens signaldock.db at given project path | — |
| `syncJunctionTables` | `(db, agentUuid, caps, skills) => void` | Rebuilds agent_capabilities and agent_skills rows | **Write** |
| `AgentRegistryAccessor` | `class implements AgentRegistryAPI` | Full CRUD implementation backed by signaldock.db | — |
| `AgentRegistryAccessor.register` | `async (credential) => AgentCredential` | Upserts agent row, encrypts API key, syncs junction tables | **Write** |
| `AgentRegistryAccessor.get` | `async (agentId) => AgentCredential \| null` | Reads single agent by agent_id, decrypts key | **Read** |
| `AgentRegistryAccessor.list` | `async (filter?) => AgentCredential[]` | Lists all agents or filtered by is_active | **Read** |
| `AgentRegistryAccessor.update` | `async (agentId, updates) => AgentCredential` | Partial update, re-encrypts key if changed | **Read+Write** |
| `AgentRegistryAccessor.remove` | `async (agentId) => void` | Hard DELETE from agents table | **Write** |
| `AgentRegistryAccessor.rotateKey` | `async (agentId) => {agentId, newApiKey}` | POSTs to cloud `/agents/{id}/rotate-key`, then writes new key locally | **Read+Write+Network** |
| `AgentRegistryAccessor.getActive` | `async () => AgentCredential \| null` | Reads most-recently-used active agent | **Read** |
| `AgentRegistryAccessor.markUsed` | `async (agentId) => void` | Updates `last_used_at` timestamp | **Write** |

Critical observation: `AgentRegistryAccessor` takes `projectPath` in its constructor. Every call
to `openDb` uses that path. This means the accessor is strictly per-project. When T310 splits the
schema, a global accessor would need a parallel class (or an overloaded constructor accepting a
scope enum) that uses `getGlobalSignaldockDbPath()`.

The `rotateKey` method mixes cloud network I/O with local DB writes. This is the only method in the
accessor that touches `api.signaldock.io`. After T310, rotation must update the **global** tier's
`api_key_encrypted` and the project tier's reference row should contain no credential data.

The credential encryption scheme (documented fully in Section 3 below) creates a hard coupling:
the encrypted API key is tied to BOTH `machine-key` (global) AND `projectPath` (per-project). This
coupling will need to change in T310 — if credentials live globally, they cannot be encrypted with
a project-path-derived key.

### conduit/*.ts inventory

Directory: `packages/core/src/conduit/`

| File | Purpose | Touches signaldock.db? |
|---|---|---|
| `index.ts` | Re-exports: ConduitClient, createConduit, HttpTransport, LocalTransport, SseTransport | No — just barrel |
| `conduit-client.ts` | High-level Conduit interface over a Transport adapter. Connect, send, poll, subscribe, heartbeat, disconnect. | No — receives credential from caller |
| `factory.ts` | `resolveTransport(credential)` selects transport by apiBaseUrl. `createConduit(registry, agentId?)` loads credential from registry and builds ConduitClient. | No — calls `LocalTransport.isAvailable()` which checks file existence |
| `local-transport.ts` | In-process SQLite transport. Reads/writes `messages`, `conversations` tables directly. Opens `.cleo/signaldock.db` via `getSignaldockDbPath()`. | **YES — directly reads and writes signaldock.db messages table** |
| `http-transport.ts` | HTTP polling to cloud API. Primary/fallback failover between `api.signaldock.io` and `api.clawmsgr.com`. No local DB access. | No |
| `sse-transport.ts` | Real-time SSE from cloud, HTTP POST for sends. Falls back to HTTP polling on SSE failure. No local DB access. | No |

Key finding: `LocalTransport` is the primary coupling point between the conduit module and
signaldock.db. It imports `getSignaldockDbPath` directly and hardcodes the assumption that messages
live in `.cleo/signaldock.db`. After T310, this import must change to
`getConduitDbPath()` (or equivalent) because messages are a project-scoped concern that belongs in
`conduit.db`.

### Caller Graph

The following non-test TypeScript files import from `signaldock-sqlite.ts` or
`agent-registry-accessor.ts`:

| Importer | What it imports | Distance from user |
|---|---|---|
| `packages/core/src/conduit/local-transport.ts` | `getSignaldockDbPath` | Library |
| `packages/core/src/init.ts` | `ensureSignaldockDb` | Called by `cleo init` |
| `packages/core/src/upgrade.ts` | `ensureSignaldockDb` | Called by `cleo upgrade` |
| `packages/core/src/store/agent-registry-accessor.ts` | `ensureSignaldockDb`, `getSignaldockDbPath` | Library |
| `packages/core/src/store/cross-db-cleanup.ts` | `getSignaldockDbPath` | Validation helper |
| `packages/core/src/internal.ts` | Re-exports `checkSignaldockDbHealth`, `getSignaldockDbPath`, `SIGNALDOCK_SCHEMA_VERSION`, `AgentRegistryAccessor` | Public API surface |
| `packages/cleo/src/cli/commands/agent.ts` | `AgentRegistryAccessor` (via `@cleocode/core/internal`) | CLI commands |
| `packages/cleo/src/dispatch/domains/conduit.ts` | `AgentRegistryAccessor` (via `@cleocode/core/internal`) | Dispatch handler |
| `packages/runtime/src/__tests__/lifecycle-e2e.test.ts` | `ensureSignaldockDb`, `checkSignaldockDbHealth` | Tests |

**Blast radius summary for a module rename (`signaldock-sqlite.ts` → `conduit-sqlite.ts`):**
- 5 source files import directly from `signaldock-sqlite.ts` (or re-export it via `internal.ts`)
- All 16+ call sites in `packages/cleo/src/cli/commands/agent.ts` are insulated by the
  `@cleocode/core/internal` re-export layer; changing the re-export reference would be a single
  line change at `packages/core/src/internal.ts:431`
- `packages/runtime/src/__tests__` tests import via `@cleocode/core/internal` so they are also
  insulated
- `LocalTransport` has a direct import that would need manual update

---

## Section 3: Cross-Project Agent Identity Requirements

### Where does machine-key live today?

`machine-key` is a **global** resource. It lives at `$XDG_DATA_HOME/cleo/machine-key`
(Linux: `~/.local/share/cleo/machine-key`). Platform paths are computed in
`packages/core/src/crypto/credentials.ts:37-55` using `process.env.XDG_DATA_HOME` with
fallback to `~/.local/share`.

The key is 32 random bytes, auto-generated on first `encrypt()` call with permissions 0600.
It is shared across all projects on the same machine.

### The Credential Encryption Problem for T310

API key encryption uses HMAC-SHA256(machine-key, project-path) as the AES-256-GCM key
(`packages/core/src/crypto/credentials.ts:138-141`). This means the same encrypted blob
stored in Project A's signaldock.db is **undecryptable** if you copy that row to a global
signaldock.db without re-encrypting, because:

1. The AES key is derived from `machine-key + projectPath`
2. Moving to global tier means decryption would need a "global project path" or a different
   key derivation strategy

This is the single hardest constraint for T310. Options:
- Derive global-tier keys from just `machine-key` (no project-path component)
- Re-encrypt on migration using the old per-project key to decrypt, then the new global key to
  re-encrypt
- Drop encrypted-at-rest for global tier (poor security)
- Use a per-agent key derived from `machine-key + agentId` (project-agnostic)

### Cloud Mode (api.signaldock.io) Integration

Current behavior is pull-first from local signaldock.db — there is NO sync between local and cloud:

1. Agent credentials (api_key_encrypted, api_base_url) are stored locally in `.cleo/signaldock.db`
2. When `resolveTransport()` sees `apiBaseUrl.startsWith('http')` and not `'local'`, it routes to
   `HttpTransport` or `SseTransport` which make live network calls to `api.signaldock.io`
3. Messages and conversations stored in local signaldock.db (by `LocalTransport`) are **NOT**
   synced to cloud and vice versa
4. `rotateKey()` POSTs to `${credential.apiBaseUrl}/agents/${agentId}/rotate-key` then writes the
   returned new key locally — this is the only outbound identity operation

The cloud (`api.signaldock.io`) is the SSoT for cloud-hosted agent identity. The local
`.cleo/signaldock.db` is a **credential cache + local messaging bus** — not a replica.

**Data that must persist across projects (global tier after T310):**
- `agents` rows: agent_id, name, api_key_encrypted, api_base_url, transport_type, transport_config,
  classification, capabilities, skills, is_active
- `capabilities` and `skills` catalog rows (pre-seeded, project-agnostic)
- `agent_connections` (live connection tracking) — debatable; could be per-project

**Data that must stay per-project (conduit.db after T310):**
- `messages` — conversations are project-scoped exchanges
- `conversations` — project-scoped DM threads between agents
- Project-specific agent-to-project linkage (a new table needed: `project_agents` or override table)
- `delivery_jobs` and `dead_letters` — project-scoped queue state
- `message_pins`, `attachments`, `attachment_versions`, `attachment_approvals`,
  `attachment_contributors` — all project-context

**Cloud-only tables that can be omitted from local schemas entirely:**
- `users`, `accounts`, `sessions`, `verifications`, `organization`, `org_agent_keys`
- `claim_codes` (cloud provisioning concept)

### Concrete Cross-Project Scenario

Today: `cleo agent list` in Project B shows ZERO agents registered in Project A.
Evidence: `AgentRegistryAccessor` constructor takes `projectPath`, opens
`<projectPath>/.cleo/signaldock.db`, all queries are scoped to that file.

Desired (per T310 epic description): after T310, `cleo agent list` in Project B should show agents
registered in Project A (because they would be in the global tier). Per T310 acceptance criteria:
"Agent visibility test: agent created in project A via `cleo agent register` is visible in project
B via `cleo agent list`."

The key design question this creates: should project-level conduit.db have a reference/override
table that filters the global agent list per project, or should `cleo agent list` ALWAYS show the
full global list regardless of project?

---

## Section 4: Migration Strategies

### Strategy A: Full Rename + One-Shot Migration

**Description:** In a single release (v2026.4.12):
1. Create global `$XDG_DATA_HOME/cleo/signaldock.db` with a lean agent-identity schema (agents,
   capabilities, skills, agent_capabilities, agent_skills, agent_connections, _meta)
2. Rename project-tier `.cleo/signaldock.db` → `.cleo/conduit.db` in-place (or create new conduit
   schema and migrate data)
3. One-shot migration script on first run detects old `signaldock.db`, migrates agent identity rows
   to global, migrates messages/conversations to `conduit.db`, deletes old `signaldock.db`
4. Add `project_agent_refs` table to conduit.db for per-project linkage to global agent IDs
5. Re-derive credential encryption using a global-tier key scheme

| Attribute | Assessment |
|---|---|
| Implementation complexity | 4/5 — schema split, migration script, crypto re-keying, two new files to manage |
| User-visible impact | Minor — `cleo agent list` changes behavior (shows all agents), API keys re-encrypted |
| Data-loss risk | Low if migration is gated on backup verification; Medium if any step fails silently |
| Rollback path | **Dirty** — the rename is reversible if conduit.db is kept alongside a backup, but requires a rollback migration script |

**Pros:**
- Clean state after migration: two well-named DBs with clear purposes
- No version-compat overhead in code: no dual-path reads
- Matches the ADR-036 target topology exactly

**Cons:**
- Requires re-encrypting all API keys during migration (decrypt with per-project key, re-encrypt
  with new global key scheme)
- If migration fails mid-way (e.g., disk full), user is left with partial state
- Any project cloned fresh from git and then upgraded will have an empty conduit.db + populated
  global signaldock.db — asymmetric state across team members until everyone re-registers

### Strategy B: Dual-Write with Deprecation Period

**Description:** Over two releases:
- v2026.4.12: Create global `signaldock.db`, write all new agent registrations to BOTH
  `signaldock.db` locations (project + global), read from global if present else fall back to
  project
- v2026.4.13: Drop project-tier agent tables from conduit.db, require all reads from global tier
- v2026.4.14+: Remove dual-write code

| Attribute | Assessment |
|---|---|
| Implementation complexity | 3/5 — dual-write logic is moderate, but deprecation period adds branch complexity |
| User-visible impact | None in v2026.4.12, Minor in v2026.4.13 |
| Data-loss risk | Low — agents always in at least one place during transition |
| Rollback path | Clean — in v2026.4.12 the system is fully backward compatible |

**Pros:**
- No forced migration script: gradual migration
- Any partial failure is non-catastrophic
- Easier to test: each phase is independently verifiable

**Cons:**
- Dual-write means complexity in `AgentRegistryAccessor` for 1-2 versions
- The conduit.db rename (project-tier) still needs to happen — this strategy defers the complexity
  but does not eliminate it
- Three-release span increases risk of the cleanup steps being skipped or delayed

### Strategy C: Hard Cutover with Re-Registration Required

**Description:** In v2026.4.12, introduce global signaldock.db and conduit.db simultaneously.
Existing `.cleo/signaldock.db` is abandoned (or backed up but not migrated). Users must run
`cleo agent register` to re-register all agents in the new global tier.

| Attribute | Assessment |
|---|---|
| Implementation complexity | 2/5 — no migration logic, just new schema creation |
| User-visible impact | **Major** — existing agent registrations are gone; stored API keys lost |
| Data-loss risk | High for users who lose their API keys (must rotate from signaldock.io) |
| Rollback path | Clean — old signaldock.db untouched if backed up, can be restored |

**Pros:**
- Simplest implementation: no migration code
- Clean slate: no schema cruft carried forward
- The two registered agents (`cleo-prime`, `cleo-prime-dev`) can be re-registered trivially in this
  project, but may not be re-registerable in all user projects

**Cons:**
- Unacceptable UX for any project with many registered agents or lost API keys
- API keys encrypted at rest mean they cannot be recovered from the old DB without the machine-key
  (which is fine for the original machine but not for migrations)
- Violates T310 acceptance criteria: "One-shot migration preserves existing project signaldock.db
  data"

### Strategy Comparison Matrix

| Criterion | Strategy A | Strategy B | Strategy C |
|---|---|---|---|
| Implementation complexity | 4/5 | 3/5 | 2/5 |
| User-visible impact | Minor | None → Minor | **Major** |
| Data-loss risk | Low | Low | High |
| Rollback path | Dirty | Clean | Clean |
| Matches T310 AC | Yes | Partial | No (violates migration AC) |
| Release count | 1 | 2-3 | 1 |
| Code complexity post-ship | Low | Medium (dual-write period) | Low |

---

## Section 5: Risk Assessment

### Data-Loss Scenarios

**Risk 1: API key loss during migration (Strategies A and B)**
The `api_key_encrypted` values are encrypted with `HMAC-SHA256(machine-key, projectPath)`.
During migration, the code must decrypt with the old scheme and re-encrypt with the new global
scheme before deleting old rows. If this step fails or is interrupted, API keys become
unrecoverable unless the user has the plaintext. Impact: High (user must re-provision API keys
from signaldock.io). Mitigation: mandatory backup snapshot before migration, integrity check
after migration before deletion of old signaldock.db.

**Risk 2: conduit.db rename leaves LocalTransport broken**
`LocalTransport` hardcodes `getSignaldockDbPath()` at
`packages/core/src/conduit/local-transport.ts:50`. If signaldock.db is renamed to conduit.db but
`getSignaldockDbPath()` still returns `signaldock.db`, LocalTransport throws "signaldock.db not
found at ... Run: cleo init". Any test or production path that uses LocalTransport will fail.
Mitigation: update all import sites simultaneously with the DB rename.

**Risk 3: Incomplete caller updates**
`agent.ts` CLI module has 16+ call sites to `AgentRegistryAccessor(process.cwd())`. If any site
is missed during refactor, it will open the old project signaldock.db path instead of the new
global path, silently returning an empty agent list. Mitigation: exhaustive grep + integration
test for `cleo agent list` cross-project behavior.

**Risk 4: FTS5 virtual table migration**
The `messages_fts` FTS5 virtual table has three triggers attached to `messages`. A schema copy
that creates `conduit.db` by dumping DDL from `signaldock.db` must include the FTS5 virtual table
and triggers. VACUUM INTO creates a full DB copy and is safe here; a DDL-only approach risks
missing the FTS triggers. Mitigation: use VACUUM INTO for the initial conduit.db creation from
existing signaldock.db.

**Risk 5: Backup registry gap**
`sqlite-backup.ts:SNAPSHOT_TARGETS` currently contains only `tasks` and `brain`. The comment at
`sqlite-backup.ts:311` explicitly states `signaldock` is "reserved for T310". After T310, BOTH
`conduit.db` (project tier) AND `signaldock.db` (global tier) need backup coverage. The global-tier
backup path is pre-wired at `sqlite-backup.ts:347` (`dbName: 'nexus' | 'signaldock'`) but the
signaldock branch is unreachable until T310 wires it up. Mitigation: T310 must add `conduit` to
`SNAPSHOT_TARGETS` and activate the `signaldock` branch in `GLOBAL_SNAPSHOT_TARGETS`.

**Risk 6: Dual-write period integrity (Strategy B only)**
During the dual-write period, an agent update in one location that fails in the other creates
split state. If the global tier write succeeds but the project tier write fails (or vice versa),
reads will return inconsistent data depending on which DB is checked first. Mitigation: wrap
dual-writes in a try-catch with rollback; accept that split-state is detected on next read and
re-syncs.

### Test Coverage Needed

Before shipping T310, the following test scenarios must have coverage:

1. `cleo agent register` in Project A — agent appears in global signaldock.db
2. `cleo agent list` in Project B (different dir, same machine) — shows agents from Project A
3. `cleo agent list` after `remove` in Project A — per T310 AC: "project removal does not delete
   global identity"
4. `rotateKey()` — updates global signaldock.db only, not a local duplicate
5. `LocalTransport.connect()` — opens conduit.db, not signaldock.db
6. `LocalTransport.push()` — writes message to conduit.db messages table
7. Cross-project conduit message — agent registered in Project A sends message to agent in
   Project B via shared LocalTransport (both open same conduit.db? or separate project conduit.dbs?)
8. Migration script idempotency — run twice on same project, no data duplication
9. Migration with encrypted API keys — decrypt from old scheme, verify plaintext, re-encrypt with
   new global scheme
10. `cleo restore backup --file conduit.db` — restores conduit.db from project-tier backup

### Rollback Plan

If v2026.4.12 ships with T310 and regressions are discovered:
1. Ship v2026.4.12.1 with a revert migration that reads global signaldock.db agent rows and writes
   them back to a new project-tier signaldock.db, then renames conduit.db back to signaldock.db
2. The revert must handle the key re-encryption in reverse: decrypt with global key scheme,
   re-encrypt with per-project key scheme
3. For users who have already run `cleo upgrade`, the rollback path requires their global
   signaldock.db to still be intact (it would not be deleted by a well-behaved rollback)
4. Any messages written to conduit.db during the brief v2026.4.12 window can be copied back to
   the renamed signaldock.db since the schema is the same

### Unknowns for Consensus to Resolve

1. **Cross-project LocalTransport scope**: If two projects are open simultaneously and both use
   LocalTransport, do they share a single conduit.db (global) or each have their own? The current
   design stores messages per-project (they are project DMs). This is an open question.
2. **Schema slimming**: The global signaldock.db schema should probably drop 8+ cloud-only tables
   (users, sessions, accounts, etc.). Is this scope for T310 or deferred?
3. **Key derivation strategy**: The new global key scheme is not designed. Options: `machine-key`
   alone, `machine-key + agentId`, or a new global AES key stored at global tier. This choice
   affects migration complexity and security posture.
4. **project_agent_refs table**: Does conduit.db need a per-project override/filter table for
   global agents? Or does all project-specific agent config live in the global tier with a
   project_id foreign key?

---

## Section 6: RCASD Next-Step Recommendations

### What Consensus Phase Must Decide

The following are architectural decisions that require HITL approval before ADR-037 can be drafted:

1. **Migration strategy**: Strategy A (one-shot), B (dual-write), or a hybrid. This is the primary
   decision the Consensus phase exists to make.

2. **Global key derivation**: What replaces `HMAC-SHA256(machine-key, projectPath)` for credentials
   stored in global signaldock.db? Options: `machine-key` alone (simpler), `machine-key + agentId`
   (agent-bound), or a dedicated global-tier secret.

3. **Cross-project agent visibility default**: After T310, does `cleo agent list` in any project
   show ALL globally registered agents, or only agents explicitly "assigned" to the current project?
   (This is Q1 in Section 8.)

4. **conduit.db name**: Is `conduit.db` the correct target name for the project-tier rename, or
   does the owner prefer `comms.db`, `messaging.db`, or something else?

5. **Schema slimming scope**: Should T310 also trim the cloud-only tables (users, sessions, etc.)
   from both the project-tier conduit.db and global signaldock.db schemas, or is that deferred?

6. **Agent deletion cascade**: When an agent is removed in a project (`cleo agent remove`), should
   the global identity row be deleted? (This is Q5 in Section 8.)

### What ADR-037 Must Document

ADR-037 will be the "Conduit + Signaldock Separation" ADR. Based on this research, it must cover:

- New two-tier signaldock topology diagram (global + project tiers, file paths, schema division)
- Global signaldock.db schema DDL (lean: agents, capabilities, skills, agent_connections, _meta)
- Project conduit.db schema DDL (project-comms: messages, conversations, delivery_jobs,
  dead_letters, message_pins, attachments, attachment_versions, attachment_approvals,
  attachment_contributors, project_agent_refs)
- New encryption key derivation scheme for global-tier API keys
- Migration algorithm (one-shot or dual-write) with error handling and rollback path
- Backup registry updates (conduit prefix in project tier, signaldock in global tier)
- Caller update mandate: all `AgentRegistryAccessor(process.cwd())` call sites must be audited
- Cross-project agent visibility contract: what does `cleo agent list` return?
- Agent lifecycle: register → visible globally; remove from project → global identity preserved

### What Specification Must Define

The Specification phase must produce formal contracts for implementation:

1. **Schema DDL**: Complete `CREATE TABLE` SQL for the new lean global signaldock.db and the
   trimmed project conduit.db. This replaces the current embedded migrations in
   `signaldock-sqlite.ts`.

2. **New path functions**: `getGlobalSignaldockDbPath()`, `getConduitDbPath(cwd?)` — must follow
   the XDG/env-paths pattern used by `getCleoHome()`.

3. **New module names**: `conduit-sqlite.ts` (project messaging store), `global-signaldock-sqlite.ts`
   (global identity store) — or a single `signaldock-sqlite.ts` that accepts a scope enum.

4. **Global key derivation function**: signature and algorithm for `deriveGlobalKey()`.

5. **Migration SQL**: The one-shot migration script that:
   a. Reads agents from `<project>/.cleo/signaldock.db`
   b. Decrypts API keys using old per-project scheme
   c. Re-encrypts using new global scheme
   d. Writes to `$XDG_DATA_HOME/cleo/signaldock.db`
   e. Writes conversation/message rows to `<project>/.cleo/conduit.db`
   f. Renames old signaldock.db to conduit.db (or archives it)

6. **`AgentRegistryAPI` split**: Define `GlobalAgentRegistryAPI` (CRUD for global tier) and
   `ProjectAgentRefAPI` (CRUD for project-tier override/filter). These map to the two new classes
   `GlobalAgentRegistryAccessor` and `ProjectAgentRefAccessor` (or combined with a scope param).

7. **Backup targets update**: The final `SNAPSHOT_TARGETS` array in `sqlite-backup.ts` and the
   activated `GLOBAL_SNAPSHOT_TARGETS` entry.

### What Decomposition Must Produce

Estimated atomic tasks for the implementation wave (12-18 tasks, mostly small-to-medium):

| Area | Estimated Tasks | Sizing |
|---|---|---|
| Global signaldock.db schema + ensure function | 2 | Small |
| conduit.db schema + ensure function | 2 | Small |
| New path functions in paths.ts | 1 | Small |
| Global key derivation in credentials.ts | 1 | Small |
| GlobalAgentRegistryAccessor class | 2 | Medium |
| ProjectAgentRefAccessor class | 1 | Medium |
| `AgentRegistryAccessor` refactor: read global, write global | 2 | Medium |
| LocalTransport: import conduit path instead of signaldock path | 1 | Small |
| One-shot migration script | 2 | Medium |
| Backup targets update (conduit + global signaldock) | 1 | Small |
| CLI agent.ts call site audit (16+ sites) | 1 | Small |
| Init and upgrade hooks update | 1 | Small |
| Test suite (≥15 unit + ≥5 integration) | 3 | Medium |
| Release mechanics | 1 | Small |

Estimated total: ~21 tasks. Decomposition phase should produce atomic tasks with clear
dependencies (schema before accessor, accessor before CLI, migration before tests).

---

## Section 7: File:Line Citations

| Citation | Description |
|---|---|
| `packages/core/src/store/signaldock-sqlite.ts:28` | `DB_FILENAME = 'signaldock.db'` — the project-tier filename constant |
| `packages/core/src/store/signaldock-sqlite.ts:31` | `SIGNALDOCK_SCHEMA_VERSION = '2026.3.76'` — current schema version |
| `packages/core/src/store/signaldock-sqlite.ts:36-39` | `getSignaldockDbPath()` — always resolves to `.cleo/signaldock.db`; no global tier concept |
| `packages/core/src/store/signaldock-sqlite.ts:54-248` | `EMBEDDED_MIGRATIONS[0]` — consolidation of 19 Rust Diesel migrations into single SQL block |
| `packages/core/src/store/signaldock-sqlite.ts:251-266` | Migration `2026-03-30-000001_agent_connections` — adds `transport_type` column and `agent_connections` table |
| `packages/core/src/store/signaldock-sqlite.ts:268-278` | Migration `2026-03-31-000001_agent_credentials` — adds `api_key_encrypted`, `api_base_url`, `classification`, `transport_config`, `is_active`, `last_used_at` |
| `packages/core/src/store/signaldock-sqlite.ts:289-368` | `ensureSignaldockDb()` — idempotent DB creation and migration runner |
| `packages/core/src/store/agent-registry-accessor.ts:22` | Imports `ensureSignaldockDb, getSignaldockDbPath` — primary consumer of signaldock-sqlite module |
| `packages/core/src/store/agent-registry-accessor.ts:51-69` | `rowToCredential()` — calls `decrypt(row.api_key_encrypted, projectPath)`, showing the key derivation coupling |
| `packages/core/src/store/agent-registry-accessor.ts:72-78` | `openDb(projectPath)` — opens `getSignaldockDbPath(projectPath)` directly; always project-scoped |
| `packages/core/src/store/agent-registry-accessor.ts:116-118` | `AgentRegistryAccessor` constructor — takes `private projectPath: string`; project-bound |
| `packages/core/src/store/agent-registry-accessor.ts:321-342` | `rotateKey()` — the only method that calls `api.signaldock.io`; hybrid network + local write |
| `packages/core/src/conduit/local-transport.ts:21` | `import { getSignaldockDbPath } from '../store/signaldock-sqlite.js'` — direct coupling to signaldock path |
| `packages/core/src/conduit/local-transport.ts:50-53` | `connect()` opens `getSignaldockDbPath()` (no cwd arg — uses default project root); throws if missing |
| `packages/core/src/conduit/local-transport.ts:95-134` | `push()` — inserts into `messages` and `conversations` tables in signaldock.db |
| `packages/core/src/conduit/local-transport.ts:232-239` | `LocalTransport.isAvailable()` — checks existence of `getSignaldockDbPath(cwd)` |
| `packages/core/src/conduit/factory.ts:40` | Comment: "Local-only agents use LocalTransport when signaldock.db is available" |
| `packages/core/src/crypto/credentials.ts:7-10` | Documents encryption scheme: `HMAC-SHA256(machine-key, project-path)` → AES key |
| `packages/core/src/crypto/credentials.ts:33-55` | `getMachineKeyPath()` — resolves to global XDG data dir, NOT project dir |
| `packages/core/src/crypto/credentials.ts:138-141` | `deriveProjectKey(projectPath)` — the project-path coupling that T310 must redesign |
| `packages/core/src/store/sqlite-backup.ts:51-54` | `SNAPSHOT_TARGETS` — only `tasks` and `brain`; signaldock.db absent |
| `packages/core/src/store/sqlite-backup.ts:311-314` | `GLOBAL_SNAPSHOT_TARGETS` — `signaldock` slot explicitly "reserved for T310" |
| `packages/core/src/store/sqlite-backup.ts:347` | `snapshotGlobalDb` accepts `dbName: 'nexus' | 'signaldock'` — pre-wired for T310 |
| `packages/core/src/index.ts:66` | Comment: "signaldock/ removed — use conduit/ instead (T170 unification)" — confirms the naming history |
| `packages/cleo/src/cli/commands/agent.ts:63-65` | First of 16+ `new AgentRegistryAccessor(process.cwd())` call sites — all will need updating |
| `packages/cleo/src/dispatch/domains/conduit.ts:109-111` | `resolveCredential()` creates `new AgentRegistryAccessor(process.cwd())` — dispatch layer also affected |
| `packages/core/src/internal.ts:431` | Re-exports `checkSignaldockDbHealth, getSignaldockDbPath, SIGNALDOCK_SCHEMA_VERSION` — public API surface to update |
| `packages/core/src/internal.ts:858` | Re-exports `AgentRegistryAccessor` — the main consumer-facing class name to potentially rename |
| `packages/core/src/init.ts:590-599` | `ensureSignaldockDb` called during `cleo init`; non-fatal on failure |

---

## Section 8: Open Questions for Consensus Phase

- **Q1**: After T310, should `cleo agent list` in Project B show agents registered only in
  Project A (global registry)? [Yes, all global agents visible everywhere / No, project-scoped
  by default / Opt-in: only agents explicitly assigned to the project]

- **Q2**: Should the global signaldock.db schema drop the cloud-only tables (users, accounts,
  sessions, verifications, organization, claim_codes) that have zero local data, or carry them
  forward from the existing schema? [Drop them in T310 / Defer schema slimming to a separate task /
  Keep them for cloud-sync future-proofing]

- **Q3**: What key derivation strategy should replace `HMAC-SHA256(machine-key, projectPath)` for
  API keys stored in global signaldock.db? [machine-key alone / machine-key + agentId /
  machine-key + a new "global salt" stored at global tier / a dedicated global AES key]

- **Q4**: When an agent is removed in Project A (`cleo agent remove`), should the global identity
  row in `$XDG_DATA_HOME/cleo/signaldock.db` be deleted? [Yes always / Only if no other project
  has a reference to this agent / Never auto-delete global identity]

- **Q5**: Should the project-tier rename be `conduit.db` (as specified in T310 title) or is there
  a preferred alternative name (e.g., `comms.db`, `messaging.db`)? [conduit.db / comms.db /
  messaging.db / other]

- **Q6**: Does the conduit.db (project tier) need a `project_agent_refs` override table, or is
  per-project configuration of agents out of scope for T310? [Yes, include project_agent_refs in
  T310 scope / No, defer to a follow-on / Agents in global tier only, no per-project config]

- **Q7**: Should LocalTransport continue to use a project-scoped conduit.db, or should messages
  eventually route through a global message bus? [Project-scoped conduit.db is correct / Global
  message bus is the direction, but defer to a later epic]

- **Q8**: Should T310 include a CLI migration command (`cleo migrate signaldock`) that users must
  run explicitly, or should migration be automatic on the first `cleo` invocation after upgrade?
  [Automatic on first run / Explicit user command required / Prompted on first run]
