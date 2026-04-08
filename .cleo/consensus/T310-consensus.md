---
task: T326
epic: T310
type: consensus
pipeline_stage: consensus
feeds_into: [ADR-037, T310-specification, T310-decomposition]
research_source: .cleo/research/T310-signaldock-conduit-audit.md
decisions_recorded: 2026-04-08
---

# T310 Consensus Record: Conduit + Signaldock Separation

> This document records the 8 architectural decisions made by the HITL owner
> during the T310 Consensus phase. ADR-037 implements these decisions;
> T310 Specification formalizes the contracts; T310 Decomposition turns
> them into atomic implementation subtasks.

## Decision Summary

| # | Question | Decision | Impact |
|---|----------|----------|--------|
| Q1 | Cross-project agent visibility | Project-scoped default | `cleo agent list` shows only refs in current project |
| Q2 | Cloud tables in global signaldock | Keep at system level | Schema slimming deferred; cloud-sync future-proofed |
| Q3 | API key KDF strategy | machine-key + global-salt + agentId | New global-salt file; KDF signature changes |
| Q4 | Agent remove semantics | Never auto-delete global identity | `--global` flag required for global removal |
| Q5 | Project-tier DB name | `conduit.db` | Matches packages/core/src/conduit/ organization |
| Q6 | project_agent_refs override table | INCLUDE in scope | Per-project agent overrides supported |
| Q7 | LocalTransport routing | Project-scoped conduit.db | Global message bus deferred |
| Q8 | Migration trigger | Automatic on first invocation | No CLI verb, no prompt |

## Full Decision Records

### Q1: Cross-Project Agent Visibility — Decision B (Project-Scoped Default)

**Question**: After T310, should `cleo agent list` in Project B show agents registered only in Project A?

**Decision**: **B — Project-scoped by default.** The global signaldock.db holds canonical agent identity, but visibility is controlled by per-project references in `conduit.db:project_agent_refs`. Agents are visible in Project B ONLY if they have an entry in Project B's conduit.db:project_agent_refs.

**Why**:
- Avoids leaking project-specific agent configuration across project boundaries
- Preserves the mental model that `cleo agent` operates on the current project
- Enables intentional cross-project sharing via explicit "attach" operations

**How to apply**:
- `cleo agent list` joins conduit.db:project_agent_refs with signaldock.db:agents (INNER JOIN, project scope)
- `cleo agent list --global` shows all global identities (no project filter)
- Adding a global agent to a project requires an explicit `cleo agent attach <id>` operation

**Research link**: T310-signaldock-conduit-audit.md Section 3 (Cross-Project Agent Identity Requirements)

---

### Q2: Cloud Tables in Global Signaldock — Decision C (Keep at System Level)

**Question**: Should the global signaldock.db schema drop cloud-only tables that have zero local data?

**Decision**: **C — Keep cloud-only tables for cloud-sync future-proofing.** The tables `users`, `accounts`, `sessions`, `verifications`, `organization`, `claim_codes` carry forward from the existing schema into the new global signaldock.db. They remain empty in pure-local mode but the schema is ready when api.signaldock.io cloud mode syncs data locally.

**Owner rationale**: "keep for the cloud-sync needs but should be at system level"

**Why**:
- Schema migrations are cheaper than schema creation later
- Drizzle migrations handle empty-table forward-compat cleanly
- Moving the tables to the system (global) tier means a single schema, not per-project duplication

**How to apply**:
- Copy all existing signaldock-sqlite.ts table definitions into the new global signaldock schema
- Tables live in `$XDG_DATA_HOME/cleo/signaldock.db`, not in project-tier conduit.db
- Schema slimming (if ever wanted) is a separate future epic

**Research link**: T310-signaldock-conduit-audit.md Section 1 (Current Schema) and Section 3

---

### Q3: API Key KDF Strategy — Decision C (machine-key + global-salt)

**Question**: What KDF replaces `HMAC-SHA256(machine-key, projectPath)` for API keys stored in global signaldock.db, since projectPath loses meaning at global scope?

**Decision**: **C — machine-key + new "global salt" stored at global tier.**

**Specification**:
- On first `cleo` invocation post-T310, generate a 32-byte random value and store it at `$XDG_DATA_HOME/cleo/global-salt` with 0o600 permissions
- New KDF: `HMAC-SHA256(machine-key || global-salt, agentId)` → 32-byte API key
- Global-salt is NOT copied across machines (security boundary)
- Global-salt regeneration invalidates all stored API keys — treated as a security event requiring re-registration

**Why**:
- Machine-key alone leaks per-machine secrets to every agent on the same machine
- Agent-id alone doesn't bind to the machine
- The combination + salt gives per-machine per-agent isolation

**How to apply**:
- New helper: `getGlobalSalt()` in packages/core/src/store/ (creates on first call, memoizes)
- KDF helper refactored to new signature
- Old project-tier API keys are invalidated on migration — existing agents must re-authenticate
- Migration writes a warning log explaining the one-time reauth requirement

**Research link**: T310-signaldock-conduit-audit.md Section 3 (cross-project identity), Section 5 (risk assessment)

---

### Q4: Agent Remove Semantics — Decision C (Never Auto-Delete Global)

**Question**: When `cleo agent remove` runs in Project A, should the global identity row be deleted?

**Decision**: **C — Never auto-delete global identity.**

**Specification**:
- `cleo agent remove <id>` in Project A removes ONLY the row from `conduit.db:project_agent_refs` in Project A
- Global identity in `signaldock.db:agents` is untouched
- Explicit global removal requires `cleo agent remove --global <id>` (a deliberate, destructive flag)
- `cleo agent remove --global` WARNS if any project-tier conduit.db still references the agent

**Why**:
- Agents may be referenced by projects the current invocation can't see
- Protects against accidental cross-project data loss
- Matches the "never auto-delete" principle from v2026.4.11's cleanup-legacy mechanism

**How to apply**:
- New CLI flag `--global` on `cleo agent remove`
- New safety check: scan all `.cleo/conduit.db` under known project roots (from a registry, or walk filesystem) before global removal
- If scan is infeasible, WARN and require `--force-global` double-confirmation

**Research link**: T310-signaldock-conduit-audit.md Section 3 (cross-project identity)

---

### Q5: Project-Tier Rename Target — Decision A (conduit.db)

**Question**: Is the project-tier rename target `conduit.db`, `comms.db`, `messaging.db`, or something else?

**Decision**: **A — `conduit.db`.** Final answer.

**Why**:
- Matches the existing `packages/core/src/conduit/` code organization
- "Conduit" semantically captures message-passing + channel + routing
- Alternative names would create rename churn in the conduit/ module

**How to apply**:
- File rename: `packages/core/src/store/signaldock-sqlite.ts` → `conduit-sqlite.ts`
- DB file rename at project tier: `.cleo/signaldock.db` → `.cleo/conduit.db`
- Global tier retains `signaldock.db` (canonical identity)
- All project-tier callers refactored to `conduit-sqlite.ts`
- Backup registry: project tier includes `conduit.db`; global tier includes `signaldock.db`

**Research link**: T310-signaldock-conduit-audit.md Section 2 (code organization)

---

### Q6: project_agent_refs Override Table — Decision A (INCLUDE in Scope)

**Question**: Does conduit.db need a `project_agent_refs` override table?

**Decision**: **A — INCLUDE in T310 scope.**

**Owner rationale** (VERBATIM, this is a hard requirement): "MUST have clean project per-project refs allowing agents to know if global agent crossing projects"

**Specification**:
```sql
CREATE TABLE project_agent_refs (
  agent_id TEXT PRIMARY KEY,               -- FK to global signaldock.db:agents
  attached_at TEXT NOT NULL,               -- ISO timestamp when added to project
  role TEXT,                               -- project-specific role override (nullable)
  capabilities_override TEXT,              -- JSON blob for per-project capability tweaks
  last_used_at TEXT,                       -- project-local activity tracking
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_project_agent_refs_enabled ON project_agent_refs(enabled) WHERE enabled = 1;
```

- `agent_id` is a soft FK (cross-DB FK is not enforceable in SQLite; accessor layer validates)
- Reading an agent by ID joins `conduit.db:project_agent_refs` with `signaldock.db:agents`
- Writing agent identity data goes to global; writing project-specific state goes to project

**Why**:
- Owner requirement — non-negotiable
- Enables per-project agent configuration without fragmenting global identity
- Matches the "global identity + project override" pattern from other cross-scope systems

**How to apply**:
- New table DDL in conduit-sqlite.ts migration
- Accessor layer: `getAgent(id)` performs the cross-DB join
- `cleo agent attach <id>` creates a project_agent_refs row
- `cleo agent detach <id>` removes the row (but keeps global identity per Q4)

**Research link**: T310-signaldock-conduit-audit.md Section 3 + Section 4 Strategy A

---

### Q7: LocalTransport Routing — Decision A (Project-Scoped conduit.db)

**Question**: Should LocalTransport continue to use a project-scoped database, or route through a global message bus?

**Decision**: **A — Project-scoped conduit.db is correct.**

**Why**:
- Messages are naturally project-scoped (conversation context, task references, session binding)
- Global message bus is a much larger design decision deferred to a later epic
- Minimal migration surface: LocalTransport reads/writes shift from signaldock.db → conduit.db (same table layout, different file)

**How to apply**:
- LocalTransport tables (messages, conversations, channels, if any) move from signaldock-sqlite.ts to conduit-sqlite.ts verbatim
- No schema changes for this category
- Existing tests for LocalTransport just switch their file target

**Research link**: T310-signaldock-conduit-audit.md Section 2 (code organization)

---

### Q8: Migration Trigger — Decision A (Automatic on First Invocation)

**Question**: Automatic migration on first run, explicit command, or prompted?

**Decision**: **A — Automatic on first run.**

**Specification**:
- A new migration module `packages/core/src/store/migrate-signaldock-to-conduit.ts` runs once on first `cleo` invocation after upgrade
- Detection heuristic: `.cleo/signaldock.db` exists AND `.cleo/conduit.db` does NOT exist → migration needed
- Migration sequence (atomic via SQLite transaction + file rename):
  1. Create `.cleo/conduit.db` with the new schema
  2. Copy project-specific data (project_agent_refs derived from existing agent rows, messages, conversations) into conduit.db
  3. Create global `$XDG_DATA_HOME/cleo/signaldock.db` if missing
  4. Copy global-identity rows (agents, auth, cloud tables) into global signaldock.db
  5. Rename `.cleo/signaldock.db` → `.cleo/signaldock.db.pre-t310.bak` (NOT deleted — recovery path)
  6. Log success at INFO level; next run sees conduit.db and skips migration
- Failure: rollback by deleting partial conduit.db; log ERROR with recovery instructions
- Idempotent: re-running is a no-op if conduit.db already exists

**Why**:
- Zero-friction upgrade matches v2026.4.11's cleanup-legacy pattern
- Pre-t310.bak preservation gives a manual recovery path
- Automatic doesn't mean unsafe: the `.bak` file is the safety net

**How to apply**:
- Wire into `packages/cleo/src/cli/index.ts` startup sequence (alongside `detectAndRemoveLegacyGlobalFiles`)
- Must run BEFORE any conduit/signaldock accessor is called
- Non-blocking on error (logs + reports; cleo still starts so user can diagnose)

**Research link**: T310-signaldock-conduit-audit.md Section 4 Strategy A + Section 5 risk assessment

---

## Cross-Reference for Downstream Phases

- **ADR-037** (task T327): documents these decisions formally per the ADR-017 schema
- **T310 Specification** (task T328): formalizes schemas, API signatures, migration sequence
- **T310 Decomposition** (task T329): breaks spec into atomic implementation subtasks
- **Research source**: `.cleo/research/T310-signaldock-conduit-audit.md`

## Scope Boundary (What This Consensus DOES NOT Decide)

- Cross-machine agent identity portability → deferred to T311 (backup export/import)
- Global message bus → explicitly out of scope (Q7)
- Cloud-sync implementation → table schema is future-proofed (Q2) but sync protocol is separate work
- Schema slimming of cloud tables → separate future epic (Q2)
