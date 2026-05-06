# ADR-068: CLEO Database Charter (9 DBs · ownership · lifecycle · concurrency)

**Date**: 2026-05-06
**Status**: accepted
**Accepted**: 2026-05-06
**Related Tasks**: T9048, T9047
**Related ADRs**: ADR-006, ADR-010, ADR-013, ADR-036, ADR-037, ADR-038, ADR-054
**Keywords**: database, charter, sqlite, ownership, lifecycle, concurrency, openCleoDb, chokepoint, schema-migration, retention, backup, privacy, ci-gate
**Topics**: database-architecture, governance, data-safety, concurrency-model
**Summary**: Authoritative inventory and governance document for ALL CLEO databases. Defines the canonical 9-database topology, per-DB ownership / readers / writers / concurrency / schema versioning / retention / backup / privacy classification, and the lifecycle for adding a new database. Establishes `openCleoDb` as the single chokepoint for `node:sqlite` `DatabaseSync` construction (Decision D003) and a CI gate that any new `.db` path or `DatabaseSync()` outside the chokepoint must update this charter.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## Context

ADR-036 (CleoOS Database Topology + Lifecycle) defined a 4-DB × 2-tier topology in v2026.4.11: `tasks.db`, `brain.db`, `signaldock.db`, `nexus.db`. Subsequent epics shipped substantial new database surface area — `conduit.db` (ADR-037 signaldock/conduit separation), `telemetry.db` (opt-in command telemetry), `manifest.db` (llmtxt blob index), and the global `signaldock.db` identity registry (T310 dual-scope) — without amending ADR-036.

The result is documentation drift: today the only canonical reference for the full database surface is a brief "Database Topology" memory note in CLEO Project Memory. New `.db` paths are introduced inside packages without registering them with a governance document, and there is no programmatic gate stopping a developer from adding a 10th database without updating any ADR. ADR-036 still describes the historical 4-DB world and is correct for what it covered, but it is no longer the authoritative charter.

This ADR replaces the brief memory note with a single canonical inventory of the **9 currently-known databases**, defines the governance attributes that every DB MUST publish (owner, readers, writers, concurrency, schema versioning, retention, backup, privacy), and codifies the lifecycle for introducing the 10th.

### Why a charter and not another topology amendment

ADR-036 is a topology document — it answers "where do databases live?". This charter is a governance document — it answers "who owns each one, who is allowed to read/write it, how does it version, when is it backed up, what privacy class does it carry?". The two questions are distinct and benefit from distinct documents. ADR-036 remains the authoritative source for path resolution, walk-up rules, and VACUUM INTO mechanics. ADR-068 layers governance attributes on top.

---

## Decision

### Canonical Inventory (9 Databases)

Every CLEO database MUST appear in the table below. Adding a new entry is a charter amendment (see "How to add a new database").

| # | Name | File Location | Tier | Owning Package | Allowed Readers | Allowed Writers | Concurrency | Schema Versioning | Retention / Deletion | Backup | Privacy |
|---|------|---------------|------|----------------|-----------------|-----------------|-------------|-------------------|----------------------|--------|---------|
| 1 | `tasks.db` | `<projectRoot>/.cleo/tasks.db` | project | `@cleocode/brain` | core, cleo CLI, sentient | core (task engine), cleo CLI | single-writer (WAL, in-process serialization via openCleoDb) | drizzle migrations under `packages/core/src/store/migrations/tasks/` | retained for project lifetime; `cleo task delete` is logical, hard-delete via cleanup commands | VACUUM INTO via `vacuumIntoBackupAll`; included in backup-pack | local-only; contains task titles which MAY include private project names — never cloud-exported without explicit `cleo backup export` |
| 2 | `brain.db` | `<projectRoot>/.cleo/brain.db` | project | `@cleocode/brain` | core (memory), sentient, cleo memory commands | core memory pipeline (observer/reflector), cleo memory write paths | single-writer (WAL); writes go through brain ingestion queue | drizzle migrations under `packages/core/src/store/migrations/brain/` | retention tiers (short/medium/long); soft-eviction by sentient consolidator; hard-delete via `cleo memory sweep --approve` | VACUUM INTO via `vacuumIntoBackupAll`; included in backup-pack | local-only; HIGH sensitivity — contains observations, learnings, decisions; PII-class; never cloud-exported |
| 3 | `conduit.db` | `<projectRoot>/.cleo/conduit.db` | project | `@cleocode/core` (`store/conduit-sqlite.ts`) | core conduit transport, cleo CLI agent commands | core conduit transport | single-writer (WAL); LocalTransport serializes writes | drizzle migrations under `packages/core/src/store/migrations/conduit/` | retained for project lifetime; conduit messages have a TTL field but no automatic purge yet | VACUUM INTO snapshots; included in backup-pack (T306-extended) | local-only; contains agent message payloads which MAY contain prompt content |
| 4 | `signaldock.db` (project tier) | `<projectRoot>/.cleo/signaldock.db` | project | `@cleocode/core` (`store/signaldock-sqlite.ts`) | core signaldock, cleo CLI agent commands | core signaldock registration paths | single-writer (WAL) | drizzle migrations under `packages/core/src/store/migrations/signaldock/` | retained for project lifetime; agent removal hard-deletes rows | VACUUM INTO snapshots; included in backup-pack | local-only; contains project-scoped agent overrides referencing global agent UUIDs |
| 5 | `nexus.db` | `$XDG_DATA_HOME/cleo/nexus.db` | global | `@cleocode/core` (`store/nexus-*`) | core nexus, cleo nexus/dash commands | core nexus ingest pipeline | single-writer (WAL); cross-project ingestion serialized | drizzle migrations under `packages/core/src/store/migrations/nexus/` | retained for user lifetime; cross-project knowledge graph | global VACUUM INTO rotation under `$XDG_DATA_HOME/cleo/backups/sqlite/` | local-only; HIGH sensitivity — cross-project knowledge graph; PII-class |
| 6 | `telemetry.db` | `$XDG_DATA_HOME/cleo/telemetry.db` | global | `@cleocode/core` (`telemetry/sqlite.ts`) | core telemetry, `cleo diagnostics` | core telemetry middleware | single-writer (WAL); opt-in only — created lazily on first telemetry event when enabled | drizzle migrations under `packages/core/src/telemetry/migrations/` | rolling retention enforced by `cleo diagnostics` (per ADR retention rules); `cleo diagnostics disable` preserves data, `cleo diagnostics purge` deletes | covered by global VACUUM INTO when present | local-only; opt-in; designed to be cloud-exportable via `cleo diagnostics export` if user explicitly opts in |
| 7 | `manifest.db` | `<projectRoot>/.cleo/blobs/manifest.db` | derived (project) | `@cleocode/core` (`store/llmtxt-blob-adapter.ts`) | core llmtxt blob adapter, attachment-store-v2 | core llmtxt blob adapter | single-writer (WAL); blob writes serialized via adapter | derived index — schema owned by `llmtxt` package's BlobFsAdapter contract; rebuildable from blob contents | rebuildable from `<projectRoot>/.cleo/blobs/` content-addressable store; `cleo backup pack` MAY exclude and rebuild on restore | not separately backed up; rebuilt from blob store | local-only; index of content hashes — no PII unless blob contents include PII |
| 8 | `llmtxt.db` (reserved) | `<projectRoot>/.cleo/llmtxt.db` | project | `@cleocode/core` + `llmtxt` | core llmtxt session adapter | core llmtxt session adapter | single-writer (WAL) | reserved name for forthcoming AgentSession persistence per `llmtxt/sdk` contract; schema versioning will follow llmtxt package contract | retention follows llmtxt session policy; deleted on `cleo session prune` | included in backup-pack once active | local-only; MAY contain prompt/response content — PII-class |
| 9 | `signaldock.db` (global tier) | `$XDG_DATA_HOME/cleo/signaldock.db` | global | `@cleocode/core` (`store/signaldock-sqlite.ts`) | core signaldock, cleo CLI agent commands across projects | core signaldock global identity registration | single-writer (WAL); global identity writes serialized | drizzle migrations under `packages/core/src/store/migrations/signaldock-global/` | retained for user lifetime; agent identity removal is rare and logged | global VACUUM INTO rotation under `$XDG_DATA_HOME/cleo/backups/sqlite/` | local-only; canonical agent identity registry; treat credentials referenced here as secrets |

#### Tier definitions

- **project** — file lives under `<projectRoot>/.cleo/`. Lifecycle bound to a single CLEO project; created by `cleo init`; subject to project-tier VACUUM INTO rotation; never tracked in git (per ADR-013 §9 + `.cleo/.gitignore` template).
- **global** — file lives under `$XDG_DATA_HOME/cleo/` resolved via `env-paths` (`getCleoHome()`). Lifecycle bound to the OS user across all projects. Subject to global-tier VACUUM INTO rotation under `$XDG_DATA_HOME/cleo/backups/sqlite/`.
- **derived (project)** — file lives under the project tier and is **rebuildable** from a non-DB source-of-truth (e.g., `manifest.db` rebuildable from the content-addressable blob store). Derived DBs MAY be excluded from backup-pack and regenerated on restore.

### `openCleoDb` Chokepoint (Decision D003)

All `node:sqlite` `DatabaseSync` construction in CLEO production code MUST go through a single chokepoint named `openCleoDb`. The chokepoint:

1. Accepts a `role` parameter that names which charter row is being opened (one of: `tasks`, `brain`, `conduit`, `signaldock-project`, `nexus`, `telemetry`, `manifest`, `llmtxt`, `signaldock-global`).
2. Resolves the canonical absolute path from the role via the SSoT path helpers (`getTasksDbPath`, `getBrainDbPath`, `getConduitDbPath`, `getSignaldockDbPath`, `getNexusDbPath`, `getCleoHome`/`getCleoProjectDir` for derived).
3. Applies WAL mode and the `busy_timeout` PRAGMA before returning the handle.
4. Emits a structured log (`subsystem: "openCleoDb"`) recording role + path + caller stack frame for diagnostics.

Direct `new DatabaseSync(...)` outside `openCleoDb` is permitted only in:

- The `openCleoDb` implementation itself.
- Test fixtures under `**/__tests__/**` that need to construct fixture DBs at temp paths.
- Migration tooling that explicitly constructs throw-away DB files.

Production code paths that bypass `openCleoDb` are a charter violation and MUST be flagged by the CI gate (see below).

> **Migration note**: today, `DatabaseSync` is constructed in multiple places (`packages/brain/src/db-connections.ts`, `packages/cleo/src/cli/commands/agent.ts`, `packages/cleo/src/cli/commands/migrate-agents-v2.ts`, `packages/core/src/store/sqlite-native.ts`, `packages/core/src/telemetry/sqlite.ts`, `packages/core/src/store/llmtxt-blob-adapter.ts`). Routing all production callers through `openCleoDb` is tracked as follow-on cleanup; this charter establishes the contract. Until the migration lands, each existing call site is grandfathered with a comment referencing this ADR.

### CI Gate (charter integrity)

A repository-level pre-commit / CI check MUST reject any pull request that:

1. Introduces a new `.db` filename literal in `packages/*/src/**/*.ts` (excluding `__tests__/**`) AND
2. Does not modify `.cleo/adrs/ADR-068-cleo-database-charter.md` in the same commit/PR.

OR

3. Adds a new `new DatabaseSync(` call in `packages/*/src/**/*.ts` (excluding the `openCleoDb` implementation file and `__tests__/**`) AND
4. Does not modify this ADR in the same commit/PR.

The implementation lives in `packages/cleo/scripts/check-database-charter.ts` (RECOMMENDED location; OPTIONAL bash equivalent acceptable). Until the script ships, the charter relies on reviewer enforcement; this ADR's existence makes the rule defensible.

### How to Add a New Database (Lifecycle Checklist)

Every new database introduced into CLEO MUST satisfy ALL of the following before merging to `main`:

1. **Charter amendment** — Add a new row to the canonical inventory table in this ADR with all 12 columns populated. If the database supersedes an existing row, link the supersession in the row's notes.
2. **`openCleoDb` role registration** — Add a new entry to the `Role` union accepted by `openCleoDb`. Wire the path-resolution branch to a SSoT helper (`getXxxDbPath()`); never inline `join(..., 'foo.db')` at call sites.
3. **Schema migration setup** — Create a drizzle migration directory under `packages/core/src/store/migrations/<role>/` (or the owning package's equivalent). Land an initial `0000_init.sql` plus the drizzle schema TS file. The first run of the chokepoint MUST apply migrations idempotently.
4. **Backup-pack inclusion** — If the DB is **project tier**, register it in the project-tier `vacuumIntoBackupAll` snapshot list and `cleo backup pack` staging directory. If **global tier**, register it in the global VACUUM INTO rotation. If **derived**, document the rebuild path and explicitly exclude (with a justification comment).
5. **Test fixtures** — Add a `<role>-sqlite.test.ts` (or extend an existing peer test) that exercises: (a) chokepoint open + close, (b) migration apply on fresh file, (c) WAL checkpoint behavior, (d) VACUUM INTO snapshot when applicable. Place fixtures under `packages/<owner>/src/store/__tests__/`.
6. **Privacy classification** — Choose one of `local-only`, `local-only (PII)`, `cloud-exportable (opt-in)`. PII class requires explicit `cleo backup export --include-pii` flag at export time.
7. **CI gate update** — If the new `.db` filename does not match the chokepoint role registration, update the CI gate's role registry. Run the gate locally and confirm a green result.
8. **Memory note refresh** — Run `cleo memory observe` with a `Database Topology` title pointing back to this ADR; do not duplicate the inventory in observation text.

A pull request that fails any of steps 1–7 MUST be rejected by the CI gate. Step 8 is enforced by reviewer checklist.

---

## Consequences

### Positive

- **Single source of truth for database governance.** Every CLEO contributor and agent has one document to consult to learn who owns a database, who may read it, who may write it, how it versions, and how it is backed up. The 9-DB inventory eliminates the ambiguity that allowed `manifest.db`, `llmtxt.db`, and `telemetry.db` to ship without governance.
- **`openCleoDb` chokepoint creates a refactor target.** Establishing the chokepoint as the canonical contract turns scattered `new DatabaseSync(...)` calls into a finite, enumerable migration list. Each grandfathered call site can be retired one PR at a time.
- **CI gate prevents charter drift.** The most common failure mode for inventory documents is silent staleness as new code lands without amendments. The gate makes drift visible at PR time.
- **Privacy classification is now explicit.** PII-bearing databases (brain.db, nexus.db, llmtxt.db) are flagged in the same row as their backup behavior, making cloud-export decisions reviewable at a glance.

### Negative

- **Migration cost for existing call sites.** Routing every production `DatabaseSync` through `openCleoDb` is non-trivial — there are ~6 distinct call sites today across `brain/`, `cleo/`, and `core/`. The cost is bounded but real.
- **Charter amendments add a small ceremony tax.** New databases now require an ADR edit + CI gate update. This is intentional friction; the v2026.4.10 → v2026.5.x divergence is the failure mode it prevents.
- **Two ADRs touch database topology.** ADR-036 still owns path-resolution + walk-up + VACUUM INTO mechanics; ADR-068 owns governance + ownership + concurrency + privacy. Readers MUST consult both. The split is justified by the distinct questions each answers but is a real cognitive cost.

---

## Alternatives Considered

### Alternative 1: Amend ADR-036 instead of writing ADR-068

Extend ADR-036 with new sections covering the 5 additional databases and add a governance subsection.

**Why rejected**: ADR-036 is a topology/lifecycle document about path resolution, walk-up rules, and VACUUM INTO mechanics. Bolting governance onto it conflates two distinct concerns. ADR-068 as a standalone charter gives governance its own canonical home with frontmatter, related-tasks, and a stable anchor for the CI gate to reference.

### Alternative 2: One ADR per database

Write nine micro-ADRs, one per database.

**Why rejected**: The whole point of the charter is the **comparison table** — readers learn the 9-DB shape by scanning rows side-by-side. Splitting into nine ADRs hides the cross-cutting structure (which ones are project tier, which carry PII, which are derived) and increases drift surface ninefold.

### Alternative 3: Track the inventory in a generated `database-inventory.json`

Keep the source-of-truth inventory in JSON and generate the markdown rendering.

**Why rejected**: Architectural decisions live in ADRs because they need narrative context (alternatives considered, consequences) that JSON cannot carry. A JSON manifest for tooling (the CI gate) can derive from this ADR's table via a parser, but the prose ADR remains the authoritative source.

### Alternative 4: No CI gate — rely on reviewer enforcement

Document the charter but skip the programmatic check.

**Why rejected**: The pre-charter state already relied on reviewer enforcement and produced exactly the drift this ADR fixes. Reviewer-only enforcement for a quietly-violated invariant is the failure mode. Even a stub CI gate that only matches the simple `\.db'` literal regex is a meaningful improvement.

---

## References

- **ADR-006** — Canonical SQLite storage decision (foundational)
- **ADR-010** — Node-sqlite engine choice (`node:sqlite` `DatabaseSync`)
- **ADR-013 §9** — Project-tier untrack resolution (T5158 data-loss vector closed)
- **ADR-036** — CleoOS Database Topology + Lifecycle (4-DB × 2-tier — superseded by this charter for governance, retained for path/backup mechanics)
- **ADR-037** — Conduit/signaldock separation (introduced `conduit.db`)
- **ADR-038** — Backup portability
- **ADR-054** — Manifest unification (introduced `pipeline_manifest` table inside `tasks.db`)
- **T9047** — Parent epic
- **T9048** — This task
- **`packages/brain/src/cleo-home.ts`** — Path SSoT (`getNexusDbPath`, `getBrainDbPath`, `getTasksDbPath`, `getConduitDbPath`, `getSignaldockDbPath`)
- **`packages/core/src/store/llmtxt-blob-adapter.ts`** — `manifest.db` ownership
- **`packages/core/src/telemetry/sqlite.ts`** — `telemetry.db` ownership
