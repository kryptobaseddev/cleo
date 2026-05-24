# ADR-068: CLEO Database Charter (12 DBs · ownership · lifecycle · concurrency)

**Date**: 2026-05-06
**Status**: accepted
**Accepted**: 2026-05-06
**Amended**: 2026-05-23 (T10306, Saga T10281 SG-BRAIN-DB-RESILIENCE / Epic T10282 E1-DB-INVENTORY); 2026-05-23 (T10324, Saga T10281 SG-BRAIN-DB-RESILIENCE / Epic T10285 E4-DB-CROSS-LINKS — Cross-DB Reference Columns subsection)
**Related Tasks**: T9048, T9047, T10305, T10306, T10324
**Related ADRs**: ADR-006, ADR-010, ADR-013, ADR-036, ADR-037, ADR-038, ADR-054
**Keywords**: database, charter, sqlite, ownership, lifecycle, concurrency, openCleoDb, chokepoint, schema-migration, retention, backup, privacy, ci-gate
**Topics**: database-architecture, governance, data-safety, concurrency-model
**Summary**: Authoritative inventory and governance document for ALL CLEO databases. Defines the canonical 12-database topology (originally 9 — amended 2026-05-23 to add `global-brain`, `global-tasks`, and `skills` per T10305 audit + flag nested-nexus duplicates as a structural bug), per-DB ownership / readers / writers / concurrency / schema versioning / retention / backup / privacy classification, and the lifecycle for adding a new database. Establishes `openCleoDb` as the single chokepoint for `node:sqlite` `DatabaseSync` construction (Decision D003) and a CI gate that any new `.db` path or `DatabaseSync()` outside the chokepoint must update this charter. The runtime SSoT is `packages/core/src/store/db-inventory.json` (re-exported as `DB_INVENTORY` from `@cleocode/contracts`); this ADR is the governance overlay.

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

### Canonical Inventory (12 Databases)

Every CLEO database MUST appear in the table below. Adding a new entry is a charter amendment (see "How to add a new database").

> **Runtime SSoT vs governance overlay**: this ADR's table is the **governance overlay** — narrative, alternatives, RFC-2119 obligations. The **machine-readable SSoT** is `packages/core/src/store/db-inventory.json`, re-exported as `DB_INVENTORY` (typed `readonly DbInventoryEntry[]`) from `@cleocode/contracts`. Tooling (T10307 fleet survey, T10310 pragma drift, T10311 migration coverage, T10312 doctor integrity, T10320 cross-DB invariants) reads the JSON; humans and reviewers consult this table. They MUST stay in lockstep — the forthcoming E1 CI drift gate compares the two and fails on divergence.
>
> **Blob + manifest unification**: the owner's mental model historically counted "blob store" and "manifest" as two databases. They are ONE unified file at `<projectRoot>/.cleo/blobs/manifest.db` — blob payloads and manifest index rows colocated under a single `DatabaseSync` handle owned by the `llmtxt/blob` `BlobFsAdapter` contract. Row 7 below is the only entry.

| # | Name | File Location | Tier | Owning Package | Allowed Readers | Allowed Writers | Concurrency | Schema Versioning | Retention / Deletion | Backup | Privacy |
|---|------|---------------|------|----------------|-----------------|-----------------|-------------|-------------------|----------------------|--------|---------|
| 1 | `tasks.db` | `<projectRoot>/.cleo/tasks.db` | project | `@cleocode/brain` | core, cleo CLI, sentient | core (task engine), cleo CLI | single-writer (WAL, in-process serialization via openCleoDb) | drizzle migrations under `packages/core/src/store/migrations/tasks/` | retained for project lifetime; `cleo task delete` is logical, hard-delete via cleanup commands | VACUUM INTO via `vacuumIntoBackupAll`; included in backup-pack | local-only; contains task titles which MAY include private project names — never cloud-exported without explicit `cleo backup export` |
| 2 | `brain.db` | `<projectRoot>/.cleo/brain.db` | project | `@cleocode/brain` | core (memory), sentient, cleo memory commands | core memory pipeline (observer/reflector), cleo memory write paths | single-writer (WAL); writes go through brain ingestion queue | drizzle migrations under `packages/core/src/store/migrations/brain/` | retention tiers (short/medium/long); soft-eviction by sentient consolidator; hard-delete via `cleo memory sweep --approve` | VACUUM INTO via `vacuumIntoBackupAll`; included in backup-pack | local-only; HIGH sensitivity — contains observations, learnings, decisions; PII-class; never cloud-exported |
| 3 | `conduit.db` | `<projectRoot>/.cleo/conduit.db` | project | `@cleocode/core` (`store/conduit-sqlite.ts`) | core conduit transport, cleo CLI agent commands | core conduit transport | single-writer (WAL); LocalTransport serializes writes | drizzle migrations under `packages/core/src/store/migrations/conduit/` | retained for project lifetime; conduit messages have a TTL field but no automatic purge yet | VACUUM INTO snapshots; included in backup-pack (T306-extended) | local-only; contains agent message payloads which MAY contain prompt content |
| 4 | `signaldock.db` (project tier) — **historical (post-ADR-037 → conduit.db)** | `<projectRoot>/.cleo/signaldock.db` (no longer created) | project | `@cleocode/core` (`store/signaldock-sqlite.ts`) | — (no live readers; legacy file MAY be detected on disk for migration provenance) | — (no live writers; project-tier signaldock writes were merged into `conduit.db` per ADR-037) | single-writer (WAL) — historical | drizzle migrations under `packages/core/src/store/migrations/signaldock/` — historical schema | row retained for legacy backup detection + migration provenance; new installs do NOT create this file | legacy VACUUM INTO snapshots MAY exist; backup-pack tolerates absence | local-only; project-scoped agent overrides referencing global agent UUIDs — superseded by `conduit.db` tables |
| 5 | `nexus.db` | `$XDG_DATA_HOME/cleo/nexus.db` | global | `@cleocode/core` (`store/nexus-*`) | core nexus, cleo nexus/dash commands | core nexus ingest pipeline | single-writer (WAL); cross-project ingestion serialized | drizzle migrations under `packages/core/src/store/migrations/nexus/` | retained for user lifetime; cross-project knowledge graph | global VACUUM INTO rotation under `$XDG_DATA_HOME/cleo/backups/sqlite/` | local-only; HIGH sensitivity — cross-project knowledge graph; PII-class |
| 6 | `telemetry.db` | `$XDG_DATA_HOME/cleo/telemetry.db` | global | `@cleocode/core` (`telemetry/sqlite.ts`) | core telemetry, `cleo diagnostics` | core telemetry middleware | single-writer (WAL); opt-in only — created lazily on first telemetry event when enabled | drizzle migrations under `packages/core/src/telemetry/migrations/` | rolling retention enforced by `cleo diagnostics` (per ADR retention rules); `cleo diagnostics disable` preserves data, `cleo diagnostics purge` deletes | covered by global VACUUM INTO when present | local-only; opt-in; designed to be cloud-exportable via `cleo diagnostics export` if user explicitly opts in |
| 7 | `manifest.db` | `<projectRoot>/.cleo/blobs/manifest.db` | derived (project) | `@cleocode/core` (`store/llmtxt-blob-adapter.ts`) | core llmtxt blob adapter, attachment-store-v2 | core llmtxt blob adapter | single-writer (WAL); blob writes serialized via adapter | derived index — schema owned by `llmtxt` package's BlobFsAdapter contract; rebuildable from blob contents | rebuildable from `<projectRoot>/.cleo/blobs/` content-addressable store; `cleo backup pack` MAY exclude and rebuild on restore | not separately backed up; rebuilt from blob store | local-only; index of content hashes — no PII unless blob contents include PII |
| 8 | `llmtxt.db` (reserved) | `<projectRoot>/.cleo/llmtxt.db` | project | `@cleocode/core` + `llmtxt` | core llmtxt session adapter | core llmtxt session adapter | single-writer (WAL) | reserved name for forthcoming AgentSession persistence per `llmtxt/sdk` contract; schema versioning will follow llmtxt package contract | retention follows llmtxt session policy; deleted on `cleo session prune` | included in backup-pack once active | local-only; MAY contain prompt/response content — PII-class |
| 9 | `signaldock.db` (global tier) | `$XDG_DATA_HOME/cleo/signaldock.db` | global | `@cleocode/core` (`store/signaldock-sqlite.ts`) | core signaldock, cleo CLI agent commands across projects | core signaldock global identity registration | single-writer (WAL); global identity writes serialized | drizzle migrations under `packages/core/src/store/migrations/signaldock-global/` | retained for user lifetime; agent identity removal is rare and logged | global VACUUM INTO rotation under `$XDG_DATA_HOME/cleo/backups/sqlite/` | local-only; canonical agent identity registry; treat credentials referenced here as secrets |
| 10 | `skills.db` (global tier) | `$XDG_DATA_HOME/cleo/skills.db` | global | `@cleocode/core` (`store/skills-schema.ts`) | core skills catalog, `cleo skill` commands across projects | core skill registration + curator | single-writer (WAL); global catalog writes serialized | drizzle migrations under `packages/core/migrations/drizzle-skills/` | retained for user lifetime; deprecated skills marked but rows retained for provenance | global VACUUM INTO rotation under `$XDG_DATA_HOME/cleo/backups/sqlite/` | local-only; skill metadata + frontmatter — no PII unless skill body contains it. **Added 2026-05-23 per T10306 / T9651 origin; verified live in T10305 audit (`sg-brain-db-resilience-deep-audit-2026-05-23` §1.2 row 4, 73 KB on disk).** |
| 11 | `global-brain` (`brain.db` global tier) | `$XDG_DATA_HOME/cleo/brain.db` | global | `@cleocode/brain` | UNREGISTERED — no live opener | UNREGISTERED — no live opener | single-writer (WAL) — provenance unclear | reuses project-tier `brain.db` drizzle schema (`packages/core/src/store/memory-schema.ts`) | retention undefined; treat as orphan until T10282/T10307 cleanup decision | global VACUUM INTO rotation MAY pick up if present | local-only PII (defensive classification — file MAY contain memory rows). **Added 2026-05-23 per T10306. Discovered live on disk (`sg-brain-db-resilience-deep-audit-2026-05-23` §1.2 row 3, ~684 KB) but bypasses `openCleoDb`. Likely orphan from a `getCleoHome()`-vs-project-resolution path bug; structural-bug followup tracked under T10282 / T10307.** |
| 12 | `global-tasks` (`tasks.db` global tier) | `$XDG_DATA_HOME/cleo/tasks.db` | global | `@cleocode/core` | UNREGISTERED — no live opener | UNREGISTERED — no live opener | single-writer (WAL) — provenance unclear | reuses project-tier `tasks.db` drizzle schema (`packages/core/src/store/tasks-schema.ts`) | retention undefined; treat as orphan until T10282/T10307 cleanup decision | global VACUUM INTO rotation MAY pick up if present | local-only — task titles MAY include private project names (defensive classification). **Added 2026-05-23 per T10306. Discovered live on disk (`sg-brain-db-resilience-deep-audit-2026-05-23` §1.2 row 5, ~4 KB) but bypasses `openCleoDb`. Likely orphan from a cwd-cascade bug (T9550 regression class). Structural-bug followup tracked under T10282 / T10307.** |

#### Known structural bugs (flagged for resolution under Saga T10281)

The T10305 deep audit (`sg-brain-db-resilience-deep-audit-2026-05-23` §1.2) surfaced two structural bugs that this charter REGISTERS without resolving. Resolution is owned by Saga T10281 SG-BRAIN-DB-RESILIENCE — specifically Epic T10285 (E4 cross-DB links), tracked task **T10321 (E4-T2 — BAN vs ADOPT ADR)**.

1. **Nested-nexus duplicates** — Two files exist under a nested `nexus/` subdirectory of the global CLEO home and shadow the canonical row-5 `nexus.db` and row-9 `signaldock.db`:
   - `$XDG_DATA_HOME/cleo/nexus/nexus.db` (~258 KB) — duplicates row 5
   - `$XDG_DATA_HOME/cleo/nexus/signaldock.db` (~245 KB) — duplicates row 9
   - Both carry their own `*-pre-cleo.db.bak` sidecars, evidence of a half-completed historical migration. Neither location has a live opener; both are orphans from divergent path resolution.
   - **Disposition** (pending T10321): authoritative decision between BAN (delete nested files, enforce flat layout) and ADOPT (canonicalize `nexus/<role>.db`, retire flat-layout rows). ADR-068 will be amended again after T10321 lands the chosen ADR. Until then, the duplicates are CHARTER-FLAGGED but not OPENCLEODB-REGISTERED.

2. **Unregistered global-tier orphans (rows 11 + 12)** — `global-brain` and `global-tasks` exist on disk but no production code opens them via `openCleoDb`. The audit could not establish provenance — most likely candidate is a path-resolution bug (T9550 regression class). T10307 fleet survey + T10282 E1 inventory close-out will classify these for cleanup (delete vs. adopt vs. migrate-and-merge).

Any `cleo doctor` or `cleo backup verify` integration MUST surface these bugs as warnings until T10321 closes. The CI charter-drift gate MUST tolerate their presence on disk but flag if NEW files appear at the same nested location.

#### Tier definitions

- **project** — file lives under `<projectRoot>/.cleo/`. Lifecycle bound to a single CLEO project; created by `cleo init`; subject to project-tier VACUUM INTO rotation; never tracked in git (per ADR-013 §9 + `.cleo/.gitignore` template).
- **global** — file lives under `$XDG_DATA_HOME/cleo/` resolved via `env-paths` (`getCleoHome()`). Lifecycle bound to the OS user across all projects. Subject to global-tier VACUUM INTO rotation under `$XDG_DATA_HOME/cleo/backups/sqlite/`.
- **derived (project)** — file lives under the project tier and is **rebuildable** from a non-DB source-of-truth (e.g., `manifest.db` rebuildable from the content-addressable blob store). Derived DBs MAY be excluded from backup-pack and regenerated on restore.

### `openCleoDb` Chokepoint (Decision D003)

All `node:sqlite` `DatabaseSync` construction in CLEO production code MUST go through a single chokepoint named `openCleoDb`. The chokepoint:

1. Accepts a `role` parameter that names which charter row is being opened (one of: `tasks`, `brain`, `conduit`, `nexus`, `telemetry`, `manifest`, `llmtxt`, `signaldock-global`, `skills`). Notes on amendments (2026-05-23, T10306): `signaldock-project` (row 4) is HISTORICAL post-ADR-037 and is NOT a live role; `skills` is a registered live role; `global-brain` (row 11) and `global-tasks` (row 12) are UNREGISTERED orphans whose disposition is pending T10321 / T10282.
2. Resolves the canonical absolute path from the role via the SSoT path helpers (`getTasksDbPath`, `getBrainDbPath`, `getConduitDbPath`, `getSignaldockDbPath`, `getNexusDbPath`, `getCleoHome`/`getCleoProjectDir` for derived).
3. Applies WAL mode and the `busy_timeout` PRAGMA before returning the handle.
4. Emits a structured log (`subsystem: "openCleoDb"`) recording role + path + caller stack frame for diagnostics.

Direct `new DatabaseSync(...)` outside `openCleoDb` is permitted only in:

- The `openCleoDb` implementation itself.
- Test fixtures under `**/__tests__/**` that need to construct fixture DBs at temp paths.
- Migration tooling that explicitly constructs throw-away DB files.

Production code paths that bypass `openCleoDb` are a charter violation and MUST be flagged by the CI gate (see below).

> **Migration note**: today, `DatabaseSync` is constructed in multiple places (`packages/brain/src/db-connections.ts`, `packages/cleo/src/cli/commands/agent.ts`, `packages/cleo/src/cli/commands/migrate-agents-v2.ts`, `packages/core/src/store/sqlite-native.ts`, `packages/core/src/telemetry/sqlite.ts`, `packages/core/src/store/llmtxt-blob-adapter.ts`). Routing all production callers through `openCleoDb` is tracked as follow-on cleanup; this charter establishes the contract. Until the migration lands, each existing call site is grandfathered with a comment referencing this ADR.

### Cross-DB Reference Columns (Amended 2026-05-23 · T10324 · Saga T10281 / Epic T10285)

SQLite cannot enforce foreign-key constraints across attached database files. Every cross-database reference (brain→tasks, conduit→signaldock, nexus→tasks, skills→tasks, etc.) is a SOFT foreign key whose integrity is the responsibility of the accessor layer and the `cleo doctor db-substrate` orphan-row report (T10323).

The catalogue of cross-DB invariants — the five load-bearing reference graphs and their validation + repair procedures — is owned by **ADR-085 Cross-DB Invariants Catalogue** (T10320). This subsection of ADR-068 codifies the SOURCE-side documentation contract: every Drizzle column that participates in a cross-DB reference MUST carry a `@cross-db` JSDoc tag so the catalogue, the accessor layer, and tooling (T10323 orphan-row report) can locate, walk, and validate references statically.

To make the contract explicit at the column declaration, every Drizzle column whose value points at a row that lives in a DIFFERENT database file MUST carry a JSDoc `@cross-db` tag immediately above the declaration.

#### Tag grammar

```
@cross-db <targetRole>.<table>.<column> — <direction-of-flow> <intra-DB or accessor note>
```

- `<targetRole>` MUST be one of the canonical role names registered with `openCleoDb` (`tasks`, `brain`, `conduit`, `nexus`, `telemetry`, `manifest`, `llmtxt`, `signaldock-global`, `skills`) OR the literal token `filesystem:` when the column is a filesystem path pointer (e.g. `project_registry.brain_db_path`).
- `<table>.<column>` are the canonical table + column names in the TARGET database.
- The trailing prose MUST identify which accessor or validator enforces the soft FK at runtime (e.g. "Resolved by the brain accessor; no DB-level FK").

Example:

```ts
/** @cross-db tasks.tasks.id — brain→tasks soft FK (every BRAIN entry can be linked to one or more tasks). Resolved by the brain accessor; no DB-level FK. */
taskId: text('task_id').notNull(),
```

#### Which columns are CROSS-DB

A column is cross-DB IFF the referenced row lives in a different `.db` file than the table declaring it. Concretely:

- Columns named `task_id`, `session_id`, `epic_id` in any non-`tasks.db` schema are cross-DB.
- Columns named `agent_id` / `from_agent_id` / `to_agent_id` / `author_agent_id` / `reviewer_agent_id` / `subscriber_agent_id` / `parent_agent_id` in any non-`signaldock.db` schema are cross-DB.
- Columns named `project_id` / `project_path` / `brain_db_path` / `tasks_db_path` in `nexus.db` are cross-DB (target = `project-context.json` or another DB file).
- Columns named `brain_anchor` (anywhere) referencing `brain.db` `brain_observations.id` are cross-DB.

A column is INTRA-DB (and therefore EXEMPT from the rule) when ANY of the following hold:

1. The column chains `.references(() => …)` to a sibling table in the same schema graph — Drizzle's `.references()` only works for tables declared in the same DB.
2. The declaring file is one of `tasks-schema.ts`, `chain-schema.ts`, `signaldock-schema.ts`, or lives under `packages/core/src/store/schema/` (these schemas model the SAME database as their referenced tables).
3. The declaration line carries a trailing `// cross-db-annotation-ok: <reason>` opt-out comment.

#### CI gate

`scripts/lint-cross-db-annotations.mjs` (CI job: **Cross-DB Annotation Lint**) walks every Drizzle schema file under `packages/core/src/store/` and `packages/core/src/agents/`, identifies cross-DB columns by the snake-case name patterns above, and fails the PR when ANY such column is missing a `@cross-db` tag. The gate runs in `--check` mode against `scripts/.lint-cross-db-annotations-baseline.json` — net-add of un-annotated columns fails CI; reductions are always accepted.

The baseline is intentionally seeded at zero — the initial pass landed under T10324 annotated every cross-DB column simultaneously.

#### Why not enforce at the type level

A Drizzle-typed cross-DB column wrapper would force every consumer to import a new helper, which would (a) explode the surface area touched by T10324 and (b) couple every schema module to a contract that we don't yet need to enforce at runtime. The lightweight `@cross-db` tag keeps the contract at the documentation layer where T10323's orphan-row report and the accessor layer can both consume it without a code-level coupling. The trade-off is acknowledged in §Alternatives Considered below.

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

- **Single source of truth for database governance.** Every CLEO contributor and agent has one document to consult to learn who owns a database, who may read it, who may write it, how it versions, and how it is backed up. The 12-DB inventory (originally 9; amended 2026-05-23 via T10306 to add `skills`, `global-brain`, `global-tasks`) eliminates the ambiguity that allowed `manifest.db`, `llmtxt.db`, `telemetry.db`, and the global-tier orphans to ship without governance.
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
- **`packages/core/src/store/db-inventory.json`** — runtime SSoT (12 rows, machine-readable) — added T10305 / Saga T10281
- **`packages/contracts/src/db-inventory.ts`** — typed re-export (`DB_INVENTORY`, `DbInventoryEntry`) — added T10305 / Saga T10281
- **`sg-brain-db-resilience-deep-audit-2026-05-23`** (research doc) — verified inventory + structural-bug evidence powering the T10306 amendment
- **T10282 / E1-DB-INVENTORY** — owning epic for inventory close-out + orphan disposition
- **T10307 / T10321** — followups (fleet survey + nested-nexus BAN vs ADOPT ADR)

---

## Amendment History

- **2026-05-23 (T10306, Saga T10281 SG-BRAIN-DB-RESILIENCE / Epic T10282 E1-DB-INVENTORY)**: extended inventory to 12 rows (added `skills`, `global-brain`, `global-tasks`); flagged nested-nexus `~/.local/share/cleo/nexus/{nexus,signaldock}.db` duplicates as a structural bug pending T10321 (E4-T2 BAN vs ADOPT ADR); marked row 4 `signaldock-project` historical (post-ADR-037 → conduit.db); clarified blob+manifest unification as ONE file (row 7); cross-referenced the runtime SSoT (`packages/core/src/store/db-inventory.json` / `DB_INVENTORY` from `@cleocode/contracts`) as the machine-readable counterpart to this governance overlay. Status remains `accepted` (amendment, not supersession).

- **2026-05-23 (T10315, Saga T10281 SG-BRAIN-DB-RESILIENCE / Epic T10284 E3-BACKUP-RECOVERY)**: cross-referenced the canonical SQLite-backup-path ratification recorded in ADR-013 §10. Both `vacuumIntoBackupAll` (auto session-end) AND `createBackup` (manual `cleo backup add`) now write to `.cleo/backups/sqlite/` for the project tier; `.cleo/backups/snapshot/` is a deprecated read-only fallthrough that will be removed in the release following T10315. Global-tier rotation under `$XDG_DATA_HOME/cleo/backups/sqlite/` is unchanged. Backup column wording in §Canonical Inventory is unchanged — the rows already reference `VACUUM INTO via vacuumIntoBackupAll`; the path unification is now spelled out in ADR-013 §10 to keep the governance overlay (this ADR) and the integrity-mechanics ADR (ADR-013) aligned. Status remains `accepted` (cross-reference amendment, not supersession).

- **2026-05-23 (T10324, Saga T10281 SG-BRAIN-DB-RESILIENCE / Epic T10285 E4-DB-CROSS-LINKS)**: added the "Cross-DB Reference Columns" subsection between the `openCleoDb` chokepoint section and the CI Gate (charter integrity) section. Establishes the `@cross-db <targetRole>.<table>.<column>` JSDoc-tag contract that every Drizzle column referencing a row in a different `.db` file MUST carry. Shipped 33 annotations across `memory-schema.ts`, `conduit-schema.ts`, `nexus-schema.ts`, `skills-schema.ts`, and `agent-schema.ts`; CI gate `Cross-DB Annotation Lint` (`scripts/lint-cross-db-annotations.mjs`) runs in baseline mode against `scripts/.lint-cross-db-annotations-baseline.json` (seeded at 0) and fails on net-add of un-annotated cross-DB columns. The contract complements the future T10323 doctor orphan-row report and the accessor-layer soft-FK validators. Status remains `accepted` (amendment, not supersession).
