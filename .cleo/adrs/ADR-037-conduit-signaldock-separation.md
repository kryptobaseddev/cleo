# ADR-037: Conduit + Signaldock Separation

**Date**: 2026-04-08
**Status**: accepted
**Accepted**: 2026-04-08
**Related Tasks**: T310, T326, T327, T328, T329
**Related ADRs**: ADR-036, ADR-013
**Keywords**: conduit, signaldock, database, topology, project_agent_refs, kdf, migration, global-salt
**Topics**: database-architecture, agent-identity, cross-project
**Summary**: Splits the single project-tier signaldock.db into a project-tier conduit.db (messages, conversations, project_agent_refs) and a global-tier signaldock.db (canonical agent identity and cloud-sync tables). Adds per-project agent reference overrides, machine-key + global-salt KDF, never-auto-delete semantics, and automatic first-run migration.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## Context

### What ADR-036 Deferred

ADR-036 (v2026.4.11) established the canonical 4-DB × 2-tier database topology for CleoOS and formally documented the signaldock dual-scope architecture as a first-class design target. That ADR explicitly deferred implementation to T310, stating:

> "v2026.4.11 does not ship the signaldock global/project split. This section documents the intended architecture as the target for T310 (deferred to v2026.4.12+)."

ADR-036 also added `signaldock.db` to the project-tier backup registry (T306) as a prerequisite for the split, giving every existing installation a recovery point before migration begins.

### Current State (v2026.4.11 Baseline)

A single `.cleo/signaldock.db` file at the project tier holds two categories of data with fundamentally different scoping requirements:

**Cross-project identity data** (belongs global):
- `agents` — 27 columns including `api_key_encrypted`, `transport_type`, `classification`, capabilities and skills caches
- `capabilities`, `skills`, `agent_capabilities`, `agent_skills` — pre-seeded catalog entries (19 capabilities, 36 skills)
- `agent_connections` — live transport connection tracking
- `users`, `accounts`, `sessions`, `verifications`, `organization`, `claim_codes` — cloud-sync tables (zero rows locally, preserved for api.signaldock.io sync)

**Per-project communication state** (belongs project-tier):
- `messages` — 4 rows from LocalTransport DM exchanges; inherently project-scoped
- `conversations` — project-scoped DM threads between agents
- `delivery_jobs`, `dead_letters` — project-scoped queue state
- `message_pins`, `attachments` and related tables — project-context message metadata

This conflation creates two concrete problems documented in the T310 research audit:

1. **Cross-project invisibility**: `AgentRegistryAccessor` takes `projectPath` in its constructor and opens `<projectPath>/.cleo/signaldock.db`. An agent registered in Project A is completely invisible to Project B. There is no canonical agent identity that survives a project switch.

2. **Credential encryption coupling**: API key encryption uses `HMAC-SHA256(machine-key, projectPath)` as the AES-256-GCM key derivation function (`packages/core/src/crypto/credentials.ts:138-141`). This coupling means the same encrypted credential stored in Project A's signaldock.db is undecryptable if moved to a global path, because there is no meaningful "global project path" to use as the key derivation input.

### Research Basis

The T310 research phase (`.cleo/research/T310-signaldock-conduit-audit.md`) inventoried the full schema (26 tables, Section 1), mapped all call sites (Section 2, blast radius for 5 direct importers + 16+ `agent.ts` call sites), documented the credential encryption constraint (Section 3), evaluated three migration strategies (Section 4), and assessed six data-loss risks (Section 5).

The T310 consensus phase (`.cleo/consensus/T310-consensus.md`) resolved all eight open questions identified in research Section 8.

---

## Decision

### 1. Project-Tier Rename: signaldock.db → conduit.db (Q5=A)

The project-tier database file MUST be renamed from `.cleo/signaldock.db` to `.cleo/conduit.db`. All project-tier source modules MUST be renamed in parallel:

- `packages/core/src/store/signaldock-sqlite.ts` → `conduit-sqlite.ts`
- `DB_FILENAME` constant → `'conduit.db'`
- `getSignaldockDbPath()` → `getConduitDbPath()`
- `ensureSignaldockDb()` → `ensureConduitDb()`
- `SIGNALDOCK_SCHEMA_VERSION` → `CONDUIT_SCHEMA_VERSION`

The global tier retains the `signaldock.db` name at `$XDG_DATA_HOME/cleo/signaldock.db`. The naming split is intentional: `conduit` captures the message-passing and channel-routing purpose of the project-tier DB, and matches the existing `packages/core/src/conduit/` code organization. Choosing a different name would create a semantic disconnect between the conduit module and its backing store.

All project-tier callers MUST be updated. The `packages/core/src/internal.ts` re-export layer (line 431) provides a single-line change point that insulates the majority of consumers including `packages/cleo/src/cli/commands/agent.ts` (16+ call sites) and `packages/runtime/src/__tests__/`. The `packages/core/src/conduit/local-transport.ts` import at line 21 is a direct coupling that requires manual update.

### 2. Global-Tier signaldock.db Schema (Q2=C)

The global-tier `signaldock.db` at `$XDG_DATA_HOME/cleo/signaldock.db` MUST carry forward all existing table definitions from the current project-tier schema. Schema slimming is explicitly deferred.

Tables carried forward to global tier:

| Table | Category | Rationale |
|---|---|---|
| `agents` | Identity | Canonical cross-project agent registry |
| `capabilities` | Catalog | Pre-seeded, project-agnostic |
| `skills` | Catalog | Pre-seeded, project-agnostic |
| `agent_capabilities` | Junction | Binds agents to capability catalog |
| `agent_skills` | Junction | Binds agents to skills catalog |
| `agent_connections` | Tracking | Live transport connection state |
| `users` | Cloud-sync | Preserved for api.signaldock.io sync (zero rows locally) |
| `accounts` | Cloud-sync | OAuth provider accounts |
| `sessions` | Cloud-sync | Auth sessions |
| `verifications` | Cloud-sync | Email/2FA verification tokens |
| `organization` | Cloud-sync | Org/team records |
| `claim_codes` | Cloud-sync | One-time agent claim tokens |
| `_signaldock_meta` | Schema | Version tracking |
| `_signaldock_migrations` | Schema | Applied migration log |

The owner rationale (Q2=C): "keep for the cloud-sync needs but should be at system level." Carrying cloud-sync tables forward to the global tier means a single schema handles both pure-local mode (empty cloud tables) and cloud-connected mode (populated by api.signaldock.io sync). Schema slimming — removing the 6 cloud-only tables that carry zero local data — is out of scope for T310 and requires a separate future epic.

A new path helper MUST be added: `getGlobalSignaldockDbPath()` resolving to `$XDG_DATA_HOME/cleo/signaldock.db` using the same `env-paths`-backed `getPlatformPaths().data` pattern used by `getCleoHome()`.

### 3. project_agent_refs Override Table in conduit.db (Q6=A)

The project-tier `conduit.db` MUST include a `project_agent_refs` table. This is a hard owner requirement.

Owner rationale (verbatim, Q6): "MUST have clean project per-project refs allowing agents to know if global agent crossing projects."

The DDL MUST be:

```sql
CREATE TABLE project_agent_refs (
  agent_id TEXT PRIMARY KEY,
  attached_at TEXT NOT NULL,
  role TEXT,
  capabilities_override TEXT,
  last_used_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_project_agent_refs_enabled
  ON project_agent_refs(enabled) WHERE enabled = 1;
```

Column semantics:

| Column | Type | Semantics |
|---|---|---|
| `agent_id` | TEXT PK | Soft FK to `global signaldock.db:agents.agent_id`. Cross-DB FK is not enforceable in SQLite; the accessor layer validates on every cross-DB join. |
| `attached_at` | TEXT | ISO-8601 timestamp when the agent was explicitly attached to this project via `cleo agent attach`. |
| `role` | TEXT nullable | Project-specific role override. Overrides the global agent's default classification for this project context. |
| `capabilities_override` | TEXT nullable | JSON blob for per-project capability tweaks. Merged with global capabilities by the accessor layer. |
| `last_used_at` | TEXT nullable | Project-local activity tracking. Updated by `AgentRegistryAccessor.markUsed()` scoped to this project. |
| `enabled` | INTEGER | 0 = detached (row retained for audit); 1 = active in this project. Partial index covers the common query path. |

The accessor layer MUST enforce the following invariants:

- `getAgent(id)` performs an INNER JOIN of `conduit.db:project_agent_refs` with `global signaldock.db:agents` on `agent_id`. An agent with a global identity but no project_agent_refs row is invisible to project-scoped queries.
- Write operations are split by responsibility: identity data (name, credentials, capabilities) MUST go to global; project-specific state (role, capabilities_override, last_used_at) MUST go to project_agent_refs.
- `cleo agent attach <id>` creates a project_agent_refs row with `enabled=1`. If the row already exists with `enabled=0`, it re-enables rather than inserting a duplicate.
- `cleo agent detach <id>` sets `enabled=0` on the project_agent_refs row. It does not delete the row (audit trail) and does not touch the global identity (per Decision 6).

### 4. Agent Visibility: Project-Scoped by Default (Q1=B)

After T310, `cleo agent list` MUST show only agents that have an entry in the current project's `conduit.db:project_agent_refs` with `enabled=1`. This is an INNER JOIN behavior, not a LEFT JOIN.

The full visibility contract:

| Command | Behavior |
|---|---|
| `cleo agent list` | INNER JOIN conduit.db:project_agent_refs (enabled=1) with global signaldock.db:agents. Returns only agents visible in the current project. |
| `cleo agent list --global` | Full scan of global signaldock.db:agents. No project filter. Shows all registered identities regardless of project attachment. |
| `cleo agent attach <id>` | Creates project_agent_refs row. Agent becomes visible in current project on next `cleo agent list`. |
| `cleo agent detach <id>` | Sets enabled=0. Agent disappears from `cleo agent list` output but global identity is preserved. |

Rationale: project-scoped default avoids leaking agent configuration across project boundaries. A developer working in Project B should not see Project A's specialized agents unless they have been explicitly attached. The `--global` flag is the intentional escape hatch for cross-project discovery. This model is consistent with the "explicit attach required" principle: global identity is a registry; project visibility is a deliberate assignment.

### 5. API Key KDF: machine-key + global-salt + agent-id (Q3=C)

The current KDF `HMAC-SHA256(machine-key, projectPath)` MUST be replaced with a new scheme that is valid at global scope. The replacement KDF is:

```
globalSalt = readFile($XDG_DATA_HOME/cleo/global-salt)   // 32 bytes, 0o600
apiKey = HMAC-SHA256(machine-key || globalSalt, agentId)
```

**global-salt creation**: On first `cleo` invocation after upgrade, if `$XDG_DATA_HOME/cleo/global-salt` does not exist, generate 32 cryptographically random bytes using Node.js `crypto.randomBytes(32)` and write atomically to that path with permissions `0o600`. This is handled by a new helper `getGlobalSalt()` in `packages/core/src/store/` that creates on first call and memoizes for the session lifetime.

**Security properties of the new KDF**:

| Property | Old KDF | New KDF |
|---|---|---|
| Machine-bound | Yes (machine-key) | Yes (machine-key) |
| Project-bound | Yes (projectPath) — breaks at global scope | No — intentional |
| Agent-bound | No | Yes (agentId as HMAC message) |
| Salt isolation | No | Yes (global-salt per machine) |
| Cross-machine portability | Unintended (machine-key is local) | Explicit non-goal (global-salt NOT copied) |

**Migration impact**: All existing `api_key_encrypted` values in the current project-tier signaldock.db were encrypted with the old per-project KDF. The migration script (Decision 8) MUST decrypt each existing key using `HMAC-SHA256(machine-key, projectPath)` and re-encrypt using the new KDF before writing to global signaldock.db. This is a one-time re-encryption pass; existing plaintext API keys are never written to disk.

**global-salt loss**: If `global-salt` is deleted or corrupted, all `api_key_encrypted` values in global signaldock.db become undecryptable. Agents must re-authenticate. This is an accepted risk: global-salt loss is a security event (intentional key rotation), not a casual data-loss scenario. The `cleo backup add` command MUST include `global-salt` in its snapshot payload for cross-machine export scenarios (T311 scope).

**Security event on migration**: The KDF change invalidates all existing stored API keys. The migration module MUST log a warning at `WARN` level explaining that existing agents have been re-keyed and any external systems holding the old API keys (e.g., CI environment variables) must be updated. This is not a silent migration; operator awareness is required.

### 6. Never-Auto-Delete Semantics (Q4=C)

`cleo agent remove <id>` MUST NOT delete the global identity row in `signaldock.db:agents`. It MUST remove only the `conduit.db:project_agent_refs` row in the current project.

The full removal contract:

| Command | Effect on conduit.db | Effect on global signaldock.db |
|---|---|---|
| `cleo agent remove <id>` | Deletes project_agent_refs row for `<id>` in current project | No effect |
| `cleo agent detach <id>` | Sets project_agent_refs.enabled=0 | No effect |
| `cleo agent remove --global <id>` | No effect | Deletes agents row. Requires explicit flag. Triggers cross-project scan warning. |
| `cleo agent remove --global --force <id>` | No effect | Deletes agents row. Bypasses scan warning if scan is infeasible. |

The `--global` removal path MUST scan known project roots (from a registry or filesystem walk) for conduit.db files that still reference the agent via project_agent_refs. If any references are found, the command MUST print a warning listing the affected projects before proceeding. If a scan is infeasible (e.g., projects spread across unmounted volumes), `--force` bypasses the scan but retains the warning.

Rationale: agents may be referenced by projects the current invocation cannot enumerate. Auto-deleting global identity on a per-project remove would silently break any other project that has the same agent attached. The "never auto-delete global" principle matches the cleanup-legacy mechanism shipped in v2026.4.11 and the ADR-013 §9 data-safety principle.

### 7. LocalTransport Routing: Project-Scoped conduit.db (Q7=A)

LocalTransport MUST continue to use the project-scoped database. After T310, it reads from and writes to `conduit.db` rather than `signaldock.db`. The schema for the relevant tables is unchanged; only the file path changes.

Tables that migrate verbatim from signaldock.db to conduit.db:

- `messages` — LocalTransport DM content, FTS5 virtual table and triggers included
- `conversations` — DM thread metadata
- `delivery_jobs` — async delivery queue
- `dead_letters` — failed delivery archive
- `message_pins`, `attachments`, `attachment_versions`, `attachment_approvals`, `attachment_contributors` — message metadata tables

The `local-transport.ts` import at line 21 MUST change from `getSignaldockDbPath` to `getConduitDbPath`. The `LocalTransport.isAvailable()` check at line 232 MUST check for `conduit.db` existence, not `signaldock.db`.

**FTS5 migration note**: The `messages_fts` FTS5 virtual table and its three triggers are tightly coupled to `messages`. The migration MUST use `VACUUM INTO` (not DDL-only copy) to preserve the virtual table and trigger definitions. A DDL-only approach risks omitting FTS5 triggers that are not visible in standard `sqlite_master` queries.

A global message bus — routing LocalTransport through a shared cross-project conduit — is explicitly out of scope for T310. It is a substantially larger design decision deferred to a later epic. Each project continues to have its own isolated `conduit.db` messaging namespace.

### 8. Migration: Automatic on First Invocation (Q8=A)

A new migration module `packages/core/src/store/migrate-signaldock-to-conduit.ts` MUST run automatically on the first `cleo` invocation after upgrade. No explicit CLI verb is required; no prompt is shown.

**Detection heuristic**: `.cleo/signaldock.db` exists AND `.cleo/conduit.db` does NOT exist at the project root → migration is needed. This is idempotent: once conduit.db exists, the migration is skipped on every subsequent invocation.

**Migration sequence** (atomic intent: all steps complete or rollback):

1. Create `.cleo/conduit.db` with the new conduit schema (messages, conversations, delivery_jobs, dead_letters, message_pins, attachments, attachment_versions, attachment_approvals, attachment_contributors, project_agent_refs, FTS5 virtual table and triggers).
2. Copy project-specific data into conduit.db:
   - `messages`, `conversations`, and related tables: verbatim row copy.
   - `project_agent_refs`: derive initial rows from existing `agents` rows in signaldock.db — each existing agent becomes a project_agent_refs entry with `enabled=1`, `attached_at` set to the agent's `created_at` value.
3. Create global `$XDG_DATA_HOME/cleo/signaldock.db` if it does not already exist, initializing it with the global schema (Decision 2).
4. Copy global-identity rows into global signaldock.db:
   - `agents` rows: decrypt `api_key_encrypted` using old KDF `HMAC-SHA256(machine-key, projectPath)`, re-encrypt using new KDF `HMAC-SHA256(machine-key || globalSalt, agentId)`, write to global DB.
   - `capabilities`, `skills`, `agent_capabilities`, `agent_skills`: verbatim copy.
   - Cloud-sync tables (`users`, `accounts`, `sessions`, `verifications`, `organization`, `claim_codes`): verbatim copy (all empty locally).
5. Rename `.cleo/signaldock.db` → `.cleo/signaldock.db.pre-t310.bak`. The original file is NOT deleted. It is the recovery path if migration verification fails.
6. Log success at INFO level: `"T310 migration complete: signaldock.db → conduit.db + global signaldock.db"`. Log the KDF rekey warning at WARN level.

**Failure handling**: If any step fails, the migration module MUST:
- Delete the partially-created `conduit.db` if it exists (prevent the detection heuristic from treating a corrupt partial DB as "migration already done").
- Log `ERROR` with the failure message and full recovery instructions pointing to `.pre-t310.bak`.
- Allow `cleo` to continue starting (non-fatal). The user can diagnose without being locked out.

**Idempotency**: Re-running migration when conduit.db already exists is a no-op. The detection heuristic short-circuits immediately.

**Wire-up location**: The migration module MUST be invoked in `packages/cleo/src/cli/index.ts` in the startup sequence alongside `detectAndRemoveLegacyGlobalFiles`. It MUST run BEFORE any conduit or signaldock accessor is called to prevent accessors from failing on the old file layout.

---

## Consequences

### Positive

- **Clean separation of cross-project identity and per-project communication state.** After T310, it is unambiguous where any given row lives: identity belongs to global signaldock.db, messaging belongs to project conduit.db.

- **Global identity reusable across projects with explicit attach.** A developer can `cleo agent attach <id>` in a new project to make a globally registered agent immediately available, without re-registering. This closes the cross-project visibility gap documented in ADR-036 §Signaldock Dual-Scope.

- **Per-project agent overrides via project_agent_refs.** Each project can assign a project-specific role, capability overrides, and activity tracking for any globally registered agent. This meets the hard owner requirement from Q6.

- **Cloud-sync schema preserved at global tier.** The cloud-only tables (users, accounts, sessions, verifications, organization, claim_codes) are forward-compatible with api.signaldock.io sync when that feature is activated. No schema migration will be required to enable cloud mode.

- **Zero-friction upgrade via automatic migration.** No CLI verb, no manual step. Developers upgrade cleo and the migration runs transparently on next invocation. The `.pre-t310.bak` file guarantees a recovery path without requiring a manual backup step before upgrade.

- **Defense in depth: original data preserved.** The `.pre-t310.bak` file retains the complete pre-migration state. Global identity is never auto-deleted. LocalTransport messages are copied, not moved (the copy in conduit.db is the live copy; the source in .bak is the recovery copy).

### Negative

- **One-time re-authentication of all existing agents.** The KDF change (Decision 5) invalidates all existing `api_key_encrypted` values. External systems (CI pipelines, remote agents) holding the old API keys must be updated. This is a known and accepted consequence of moving credentials to global scope.

- **Cross-DB JOIN overhead on every agent lookup.** Every `getAgent(id)` call now requires an INNER JOIN between `conduit.db:project_agent_refs` and `global signaldock.db:agents` across two SQLite connections. For small agent registries (typical: 2-10 agents), this overhead is negligible. For large registries (100+), it may become measurable. Connection pooling and per-session memoization are mitigation options, deferred to a performance epic.

- **Accessor layer complexity grows.** The `AgentRegistryAccessor` class that previously handled a single DB now manages read-merges (project refs joined with global identity) and write-splits (identity writes go global, project state writes go local). This increases the surface area for bugs around write ordering and partial-failure states.

- **Soft FK across DBs surfaces errors only at runtime.** SQLite cannot enforce a foreign key from `conduit.db:project_agent_refs.agent_id` to `global signaldock.db:agents.agent_id`. The accessor layer validates on every cross-DB join, but a row with a dangling `agent_id` (e.g., after a `--global` removal without detaching from all projects) will produce a silent empty result rather than a constraint error.

- **Migration failure recovery requires user understanding of the .bak file.** If the automatic migration fails, users must recognize that `.cleo/signaldock.db.pre-t310.bak` contains their pre-migration data and know to rename it back to `signaldock.db` to restore pre-T310 behavior. The error log provides instructions, but this is a more complex recovery path than a simple file restore.

---

## Alternatives Considered

### Alternative: Dual-Write with Deprecation Period (Strategy B)

Keep the project-tier `signaldock.db`, dual-write all new agent registrations to both the project tier and a new global `signaldock.db`, then deprecate and remove the project-tier agent tables over two subsequent releases.

**Why rejected**: The owner chose a clean-cut migration (Strategy A) over a deprecation period (Strategy B). Dual-write doubles schema maintenance burden for 1-2 releases: the accessor layer must handle both the old and new write paths simultaneously, increasing the risk of split-state bugs (Section 5, Risk 6 of the research audit). The conduit.db rename also still needs to happen during a dual-write period; deferring it does not eliminate the complexity — it spreads it across more releases. Strategy B was assessed as 3/5 implementation complexity vs 4/5 for Strategy A, but the clean-cut migration's lower post-ship code complexity (no dual-write cleanup debt) was the deciding factor.

### Alternative: Hard Cutover with Re-Registration (Strategy C)

Introduce global `signaldock.db` and project-tier `conduit.db` simultaneously, abandon the existing `.cleo/signaldock.db` without migration, and require users to re-register all agents from scratch.

**Why rejected**: Strategy C violates T310 acceptance criteria ("one-shot migration preserves existing project signaldock.db data") and contradicts the ADR-013 §9 data-safety principle. The two agents currently registered in the project (`cleo-prime`, `cleo-prime-dev`) hold encrypted API keys that would be unrecoverable if the source DB is abandoned. Any user who has stored API keys only in signaldock.db and not in an external credential store would permanently lose access. Strategy C is the simplest implementation (2/5 complexity) but the highest data-loss risk (High per the research matrix).

### Alternative: Keep signaldock.db, Add project_agent_refs Inside It

Retain the single project-tier `signaldock.db`, add the `project_agent_refs` table inside it (meeting the Q6 requirement), and defer the global/project split entirely.

**Why rejected**: This approach meets the letter of Q6 (project_agent_refs table exists) but fails Q1 (project-scoped visibility model requires a global tier to JOIN against), Q3 (global KDF requires a global DB), and the ADR-036 §Signaldock Dual-Scope target. Cross-project agent identity would still be absent. Adding project_agent_refs to a project-scoped DB that contains no global identity data produces a table with a FK pointing nowhere — it is architecturally incoherent.

### Alternative: Move All Tables to Global Tier (No Project-Tier Messaging DB)

Promote `messages`, `conversations`, and all LocalTransport tables to the global `signaldock.db`, eliminating the project-tier DB entirely.

**Why rejected**: Per Q7=A, LocalTransport messages are inherently per-project. A message between `cleo-prime` and `cleo-prime-dev` in Project A has no meaning in Project B's context. A global message bus (all projects sharing one messages table) would require namespace isolation (a `project_id` column on every message row), multi-project query scoping throughout LocalTransport, and a substantially larger design surface. The global message bus is a future-epic-scale decision explicitly deferred by Q7.

---

## Implementation Tasks

The T310 epic dispatches the following child tasks:

| Task | Type | Description |
|---|---|---|
| T326 | consensus | Owner decisions recorded — complete |
| T327 | adr | This ADR — current task |
| T328 | specification | Schema DDL, accessor API signatures, migration procedure, backup target updates |
| T329 | decomposition | Break specification into atomic implementation subtasks |
| (generated by T329) | implementation | Atomic code tasks: new path helpers, global signaldock schema + ensure, conduit schema + ensure, global-salt helper, KDF refactor, GlobalAgentRegistryAccessor, ProjectAgentRefAccessor, AgentRegistryAccessor refactor, LocalTransport path update, migration module, CLI attach/detach verbs, agent.ts call site audit, init/upgrade hooks, backup targets |
| (generated by T329) | release | v2026.4.12 CalVer bump, changelog generation, npm publish, GitHub Release |

Estimated implementation scope from research Section 6: 21 atomic tasks across schema, accessor, CLI, migration, test, and release work.

---

## References

- **ADR-036 §Signaldock Dual-Scope** — identified T310 as deferred follow-on and added signaldock.db to project-tier backup registry
- **ADR-013 §9** — data-safety principle; informs the `.pre-t310.bak` preservation requirement and the never-auto-delete semantics
- **T310-signaldock-conduit-audit.md** — research phase: schema inventory (Section 1), caller graph (Section 2), KDF constraint analysis (Section 3), strategy comparison (Section 4), risk assessment (Section 5)
- **T310-consensus.md** — 8 owner decisions (Q1–Q8) recorded verbatim; this ADR implements those decisions
- **`packages/core/src/store/signaldock-sqlite.ts`** — current implementation; renamed to conduit-sqlite.ts in T310
- **`packages/core/src/store/agent-registry-accessor.ts`** — current accessor; refactored to GlobalAgentRegistryAccessor + ProjectAgentRefAccessor split
- **`packages/core/src/conduit/local-transport.ts:21`** — direct import of `getSignaldockDbPath`; updated to `getConduitDbPath`
- **`packages/core/src/crypto/credentials.ts:138-141`** — `deriveProjectKey(projectPath)`; replaced by new global KDF
- **`packages/core/src/store/sqlite-backup.ts:311`** — `GLOBAL_SNAPSHOT_TARGETS` signaldock slot "reserved for T310"; activated by T329 implementation

---

## Schema Cross-Reference

### Before (v2026.4.11)

```
.cleo/signaldock.db
├── agents                      ← cross-project identity (conflated to project tier — BAD)
├── capabilities                ← project-agnostic catalog (conflated — BAD)
├── skills                      ← project-agnostic catalog (conflated — BAD)
├── agent_capabilities          ← junction (conflated — BAD)
├── agent_skills                ← junction (conflated — BAD)
├── agent_connections           ← connection tracking (conflated — BAD)
├── messages                    ← project-specific LocalTransport (OK)
├── conversations               ← project-specific (OK)
├── delivery_jobs               ← project-specific queue (OK)
├── dead_letters                ← project-specific (OK)
├── message_pins                ← project-specific (OK)
├── attachments                 ← project-specific (OK)
├── users                       ← cloud-sync (OK if global, wrong tier)
├── accounts                    ← cloud-sync (wrong tier)
├── sessions                    ← cloud-sync (wrong tier)
├── verifications               ← cloud-sync (wrong tier)
├── organization                ← cloud-sync (wrong tier)
├── claim_codes                 ← cloud-sync (wrong tier)
└── [7 more tables]             ← attachment variants, FTS, meta
```

### After (v2026.4.12)

```
Project tier: .cleo/conduit.db
├── messages                    ← LocalTransport (moved from signaldock.db)
├── conversations               ← LocalTransport (moved)
├── delivery_jobs               ← queue state (moved)
├── dead_letters                ← queue state (moved)
├── message_pins                ← message metadata (moved)
├── attachments                 ← message metadata (moved)
├── attachment_versions         ← message metadata (moved)
├── attachment_approvals        ← message metadata (moved)
├── attachment_contributors     ← message metadata (moved)
├── messages_fts                ← FTS5 virtual table (moved with triggers)
└── project_agent_refs          ← NEW: per-project agent overrides

Global tier: $XDG_DATA_HOME/cleo/signaldock.db
├── agents                      ← canonical cross-project identity
├── capabilities                ← project-agnostic catalog
├── skills                      ← project-agnostic catalog
├── agent_capabilities          ← junction
├── agent_skills                ← junction
├── agent_connections           ← connection tracking
├── users                       ← cloud-sync (preserved)
├── accounts                    ← cloud-sync (preserved)
├── sessions                    ← cloud-sync (preserved)
├── verifications               ← cloud-sync (preserved)
├── organization                ← cloud-sync (preserved)
├── claim_codes                 ← cloud-sync (preserved)
└── [meta + migrations tables]

Global tier: $XDG_DATA_HOME/cleo/global-salt
└── 32 random bytes, 0o600     ← NEW: KDF salt, machine-local, not copied cross-machine
```

---

## KDF Cross-Reference

### Before (v2026.4.11)

```
// packages/core/src/crypto/credentials.ts:138-141
deriveProjectKey(projectPath: string): Buffer {
  return createHmac('sha256', machineKey).update(projectPath).digest();
}
apiKey = AES-256-GCM(encrypt, key=deriveProjectKey(projectPath), plaintext)
```

Broken at global scope: `projectPath` has no meaning when credentials live in a global DB. Moving an encrypted row to global without re-keying makes it undecryptable.

### After (v2026.4.12)

```
// packages/core/src/store/ — new helper
getGlobalSalt(): Buffer {
  // Creates $XDG_DATA_HOME/cleo/global-salt on first call (32 bytes, 0o600)
  // Memoizes for session lifetime
}

// packages/core/src/crypto/credentials.ts — refactored
deriveGlobalKey(agentId: string): Buffer {
  const combined = Buffer.concat([machineKey, getGlobalSalt()]);
  return createHmac('sha256', combined).update(agentId).digest();
}
apiKey = AES-256-GCM(encrypt, key=deriveGlobalKey(agentId), plaintext)
```

Binds to machine (machineKey) + machine-local salt (globalSalt) + agent identity (agentId). The three-factor binding ensures that:
- The same agentId on a different machine produces a different key (machineKey differs).
- Two different agents on the same machine produce different keys (agentId differs).
- A compromised agentId alone cannot reconstruct the key without both machineKey and globalSalt.
