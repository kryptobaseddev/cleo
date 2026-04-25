# ADR-056: DB SSoT, naming convention, and the release-completion invariant (archiveReason enum + post-release gate)

**Status**: Accepted (2026-04-25)
**Date**: 2026-04-25
**Tasks**: T1407 (epic), T1408, T1409, T1410, T1411, T1412 (this ADR), T1413
**Council**: 2026-04-24 verdict at `.cleo/council-runs/20260425T033945Z-57a941ca/verdict.md`
**Supersedes**: none
**Supplements**: ADR-013 (runtime data safety), ADR-051 (evidence-based completion), ADR-054 (hybrid migration system)

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## Context

CLEO manages six SQLite databases across two scope tiers:

| DB | Tier | Purpose |
|----|------|---------|
| `tasks.db` | project | Task management, sessions, audit |
| `brain.db` | project | Cognitive memory + observations |
| `conduit.db` | project | Agent messaging |
| `nexus.db` | global | Cross-project registry |
| `signaldock.db` | global | Agent identity SSoT (local SQLite + cloud Postgres) |
| `telemetry.db` | global, opt-in | Diagnostic telemetry |

A 2026-04-24 Council convened by the project owner asked whether to **consolidate** the six DBs into one project-level + one system-level file (`cleo.db` + `cleo-nexus.db`), OR keep the per-domain split and finish in-flight cleanup. All five advisors (Contrarian, First Principles, Expansionist, Outsider, Executor) gated 4/4 PASS and converged via different routes on **keep the split**. The Chairman's verdict, accepted by the owner, mandated:

1. **No DB consolidation.** SQLite is single-writer per file; merging the 32 MB hot `tasks.db` with `brain.db` ingestion and `conduit.db` delivery would collapse three independent WAL queues, manifesting as `E_EVIDENCE_STALE` cascades on `cleo complete` during multi-agent waves.
2. **Migration runner unification at the runner layer**, not the DB layer — fold conduit.db into `migration-manager.ts` (the only outlier as of this ADR; signaldock.db was already unified in T1166).
3. **Naming convention** — formalize the canonical `<domain>-schema.ts` + `<domain>-sqlite.ts` pattern; rename the lone outlier `task-store.ts` → `tasks-sqlite.ts`; document the telemetry folder variant as an accepted exception for opt-in domains.
4. **Typed `archiveReason` enum** — promote the free-form TEXT column added in commit `3cad1e212` (Council 2026-04-24 truth-grade discrimination) to a SQLite CHECK-validated 6-value enum + Zod-validated contract type.
5. **Post-release reconciliation hook** — generic registry-driven invariants gate where archiveReason reconciliation is customer #1.

---

## Decision

### D1 — Database topology: keep per-domain split

CLEO MUST retain the six per-domain SQLite databases as documented in `docs/architecture/DATABASE-ERDS.md`. Consolidation is REJECTED for the following grounded reasons:

- **D1.1 Single-writer contention.** SQLite WAL serializes writers per database file. The current split lets `tasks.db` (32 MB, hot path), `brain.db` (BRAIN observe/promote), and `conduit.db` (delivery loop) progress in parallel under independent WAL locks. Consolidation would collapse them into a single writer queue with measurable p99 latency cliffs during multi-agent waves.
- **D1.2 No cross-DB transaction need.** No current CLEO operation requires a joint `tasks` + `brain` + `conduit` transaction. The split therefore preserves write throughput at zero correctness cost.
- **D1.3 Per-DB rollback granularity.** `cleo backup add` and `cleo restore backup --file <db>` operate per file. Consolidation would require partial-table surgery against a live writer to roll back any single domain.
- **D1.4 Migration tax is a runner concern.** `migration-manager.ts` carries six production patches (T632, T920, T1135, T1137, T1141, T5185); none are retire-able. They address SQLite semantics, not topology. Unifying the runner across N DBs solves the maintenance-tax argument without merging the DBs.

### D2 — Naming convention: `<domain>-schema.ts` + `<domain>-sqlite.ts`

The canonical store-layer naming convention is:

| Component | File | Purpose |
|-----------|------|---------|
| Schema | `packages/core/src/store/<domain>-schema.ts` | Drizzle table definitions, types, indexes |
| Open / init / CRUD | `packages/core/src/store/<domain>-sqlite.ts` | Database connection, migration wiring, accessors |

**Conforming domains** (post-T1407): `tasks`, `memory` (brain), `nexus`, `signaldock`, `conduit` (post-this ADR).

**Accepted exception — folder variant**: `packages/core/src/<domain>/{schema,sqlite}.ts`. This variant is RESERVED for opt-in / isolated domains where the single-folder layout improves discoverability. Currently used by:

- `packages/core/src/telemetry/{schema,sqlite}.ts` — opt-in diagnostics; isolated from the core store directory deliberately so `packages/core/src/store/` stays focused on the always-on project + global tier DBs.

Adding new opt-in domains MAY use the folder variant. New always-on domains MUST use the kebab-case `<domain>-schema.ts` + `<domain>-sqlite.ts` pair.

**Cleanup performed by T1407**:

- T1407-followup commit `926f002c7` — renamed `packages/core/src/store/task-store.ts` → `packages/core/src/store/tasks-sqlite.ts`. All import sites updated across `packages/`, `scripts/`, tests.
- T1407-followup commit `7300e3eed` — split `packages/core/src/store/conduit-sqlite.ts` raw-DDL block into `packages/core/src/store/conduit-schema.ts` (Drizzle defs) + thinner `conduit-sqlite.ts` (open / init / CRUD). Created `packages/core/migrations/drizzle-conduit/<ts>_initial_conduit/` baseline. Wired conduit into `migration-manager.ts` via `reconcileJournal()` + `migrateSanitized()`.

### D3 — Migration runner: single SSoT under `migration-manager.ts`

All six SQLite databases MUST be initialized via `migration-manager.ts`'s `migrateWithRetry()` + `reconcileJournal()` pipeline. Per-DB bespoke runners are PROHIBITED for new domains.

**Status as of this ADR**:
- `tasks.db` ✅ unified
- `brain.db` ✅ unified
- `nexus.db` ✅ unified
- `telemetry.db` ✅ unified
- `signaldock.db` ✅ unified (T1166, 2026-04-21)
- `conduit.db` ✅ unified (T1407-followup commit `7300e3eed`, 2026-04-25)

**Rust Diesel migrations** in `crates/signaldock-storage/migrations/` are CLOUD-ONLY artifacts for PostgreSQL deployment. They MUST NOT touch the local SQLite `signaldock.db` at runtime. The TypeScript schema at `packages/core/src/store/signaldock-schema.ts` is the canonical SSoT for local mode.

**Future enhancement (out of scope, filed as follow-up)**: a `cleo db migrate-all` CLI subcommand that runs `reconcileJournal()` + `migrateWithRetry()` across all six DBs in sequence with a single status report. ~100 LOC, no data risk.

### D4 — `archiveReason` 6-value enum

The `tasks.archive_reason` column is constrained to exactly six values via SQLite CHECK constraint (T1408 migration `20260424000000_t1408-archive-reason-enum`) and Zod `z.enum` (T1409 contract):

| Value | Semantics | Who writes it |
|-------|-----------|---------------|
| `verified` | Task closed with passing verification gates and evidence | `cleo complete` after `cleo verify --all` green |
| `reconciled` | Task auto-closed by post-release hook from a tagged commit | T1411 `cleo verify --release` |
| `superseded` | Task replaced by a later canonical equivalent | Council / cleanup operations |
| `shadowed` | Task hidden by a parent epic absorbing its scope | Epic decomposition |
| `cancelled` | Task explicitly cancelled by owner / autonomous abandon | `cleo update --status cancelled` |
| `completed-unverified` | TOMBSTONE — historical close without evidence | Migration backfill ONLY |

**Tombstone semantics**: writing `completed-unverified` from non-migration code SHALL throw `E_ARCHIVE_REASON_TOMBSTONE`. Only the T1408 migration's row-normalization step may produce this value, to mark the historical-close cohort distinct from new closures.

### D5 — Post-release reconciliation: registry-driven `cleo verify --release`

T1411 SHALL ship a registry-driven post-release invariants gate, not a single-purpose archiveReason hook. The mechanism:

1. **Invariant registry** at `packages/core/src/release/invariants/registry.ts` — exports `registerInvariant(spec)` / `getInvariants()`.
2. **First customer**: `archive-reason-invariant.ts` — parses the tagged commit message and tag annotation for `T\d+` task IDs, then for each:
   - If task has `verification_json` populated and gates pass: stamp `status=done`, `archive_reason=verified`, `release=<tag>` in one transaction
   - If `verification_json=null`: create `T-RECONCILE-FOLLOWUP-<tag>` child task linked to the unreconciled task
3. **CLI**: `cleo verify --release <tag>` (or `cleo reconcile release --tag <tag>`)
4. **Audit log**: every mutation appends `release:<tag>;task:<id>;reason:<enum>` to `.cleo/audit/reconcile.jsonl`
5. **Hook**: invoked from `scripts/hooks/post-tag.sh` for automatic execution after every `git tag`
6. **Bypass**: `CLEO_OWNER_OVERRIDE=1` + `CLEO_OWNER_OVERRIDE_REASON` for emergencies, audited to `.cleo/audit/force-bypass.jsonl`

The registry is extensible: any future invariant (schema-vs-CHECK mismatch, drizzle-migration-vs-runtime divergence, contract-vs-dispatch shape drift) registers as a one-line addition. This is the asymmetric upside Council Expansionist surfaced — ~50 LOC of registration plumbing on top of T1411's already-scoped hook code retires the entire class of drift bugs that ADR-054's six patches paid for ad-hoc.

### D6 — Commit-message lint for release commits

Every commit whose subject matches `^(chore|feat)\(release\):` MUST contain at least one `T\d+` task reference in the commit body. Enforced by `scripts/hooks/commit-msg-release-lint.mjs` (T1410), installed via the project's husky/simple-git-hooks configuration. Bypass via `CLEO_OWNER_OVERRIDE=1` + `CLEO_OWNER_OVERRIDE_REASON`, audited.

---

## Consequences

**Positive**:
- Per-domain split preserves write throughput and rollback granularity.
- Single migration-manager SSoT across all six DBs unblocks future `cleo db migrate-all` and integration testing.
- Typed `archiveReason` enum + tombstone semantics make historical-close cohorts addressable in audits and prevent silent drift on future migrations.
- Registry-driven post-release gate retires an entire class of drift bugs.
- Naming convention is now uniform; the only exception (telemetry folder variant) is documented and bounded.

**Negative**:
- Six migration-manager configurations to maintain (vs one consolidated DB) — already paid cost.
- Cloud signaldock cross-source synchronization (TS + Rust Diesel) remains a known-future-tension, addressed when cloud workloads ship.

**Risks mitigated**:
- Multi-agent wave write contention (rejected consolidation).
- `E_EVIDENCE_STALE` cascades during release windows.
- Schema drift between Drizzle defs and runtime CHECK constraints (T1411 invariants gate).
- Release commits without task IDs blocking post-release reconciliation (T1410 lint).

---

## References

- Council verdict (2026-04-24): `.cleo/council-runs/20260425T033945Z-57a941ca/verdict.md`
- DB SSoT research reports: `.cleo/agent-outputs/T-DBSSOT-RESEARCH-2026-04-25/{telemetry-db,signaldock-db,migration-runner}-research.md`
- Execution plan: `.cleo/agent-outputs/T-DBSSOT-2026-04-25/PLAN.md`
- ADR-013 §9 (runtime data safety), ADR-051 (evidence-based completion), ADR-054 (hybrid migration system)
- T1408 migration: `packages/core/migrations/drizzle-tasks/20260424000000_t1408-archive-reason-enum/`
- Conduit unification: commit `7300e3eed` + `packages/core/migrations/drizzle-conduit/`
- Naming cleanup: commit `926f002c7` (task-store → tasks-sqlite rename)

---

## Compliance

This ADR is enforced by:
1. `cleo verify --release <tag>` (T1411) — runs the registered invariants automatically post-tag.
2. `scripts/hooks/commit-msg-release-lint.mjs` (T1410) — blocks release commits without task IDs.
3. `migration-manager.ts` `reconcileJournal()` — verifies each DB's journal is in sync at runtime.
4. CI gate (`pnpm biome ci .`) — enforces naming-convention lint rules where applicable.

Future ADRs that change the DB topology, naming convention, or release-invariant registry MUST cite this ADR and explicitly supersede the relevant decision.
