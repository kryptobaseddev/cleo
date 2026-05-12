# DB SSoT + T1407 Execution Plan (2026-04-25, autonomous)

> Authority: Council verdict at `.cleo/council-runs/20260425T033945Z-57a941ca/verdict.md` + 3 research reports at `.cleo/agent-outputs/T-DBSSOT-RESEARCH-2026-04-25/`. Owner mandate: ship + tag tonight.

## Scope

This plan executes:
1. **T1407 epic (T1408–T1413)** — typed archiveReason enum + reconciliation hook (CONFIRMED in verdict)
2. **T1411 promotion** — from single-purpose hook → registry-driven `cleo verify --release` gate (Council Expansionist; user confirmed)
3. **DB SSoT cleanup** — Rename `task-store.ts` → `tasks-sqlite.ts`; split `conduit-sqlite.ts` → `conduit-schema.ts` + drizzle-conduit migrations + wire to migration-manager.ts
4. **Migration runner unification** — conduit.db is the only DB still on raw inline DDL; fold into migration-manager.ts (5/6 DBs already unified per T1166)
5. **Release** — bump CalVer, CHANGELOG, tag, push, verify CI green

## Definitive answers (carry forward to ADR)

### Naming convention (Q2)
- **Standard**: `packages/core/src/store/<domain>-schema.ts` (Drizzle defs) + `packages/core/src/store/<domain>-sqlite.ts` (open/init/CRUD)
- **Folder variant** (acceptable for opt-in/isolated domains): `packages/core/src/<domain>/schema.ts` + `packages/core/src/<domain>/sqlite.ts` (e.g., telemetry — intentional design choice)
- **Outliers being fixed**:
  - `task-store.ts` (449 LOC) → rename to `tasks-sqlite.ts` (mechanical, but cross-file imports)
  - `conduit-sqlite.ts` (712 LOC) → split: extract DDL to new `conduit-schema.ts`, leave open/init/CRUD in `conduit-sqlite.ts`

### Migration runner SSoT (Q1)
- **All 6 DBs converge on `migration-manager.ts`** with `reconcileJournal()` + `migrateWithRetry()`
- **No DB consolidation** (Council unanimous on keep split)
- **6 production patches** (T632/T920/T1135/T1137/T1141/T5185) are non-retirable per research
- **Conduit migration cost**: ~380 LOC (180 schema + 120 baseline SQL + 30 sqlite.ts wiring + 50 tests)
- **Future enhancement**: `cleo db migrate-all` CLI (~100 LOC) — DEFER to follow-up epic, not blocking release

### T1411 promotion (Q3)
- Expand acceptance criteria: T1411 ships a generic `cleo verify --release <tag>` registry where archiveReason reconciliation is **customer #1**, not the only customer
- Registry location: `packages/core/src/release/invariants/` (new module), with archiveReason invariant registered as first entry
- ~50 LOC of registry plumbing + the original hook code

## Execution waves

### Wave 0 (parallel, independent)
- **W0-A**: T1408 — Drizzle migration archiveReason TEXT → enum (6 values + CHECK)
  - Files: `packages/core/migrations/drizzle-tasks/<timestamp>_t1408_archive_reason_enum/` (new), `packages/core/src/store/tasks-schema.ts` (modify field type)
  - Acceptance: forward + down round-trip on `/tmp/tasks.db` copy; pre/post `GROUP BY archive_reason` counts unchanged
- **W0-B**: Rename `task-store.ts` → `tasks-sqlite.ts`
  - Files: rename + update all import sites
  - Acceptance: `pnpm run build` green; biome green

### Wave 1 (depends on Wave 0)
- **W1-A**: T1409 — Promote `archiveReason` literal to typed `z.enum` in `packages/contracts/src/tasks/archive.ts`; update caller `packages/core/src/tasks/archive.ts:113`
- **W1-B**: Create `packages/core/src/store/conduit-schema.ts` (Drizzle defs for 17 tables) + generate baseline migration `packages/core/migrations/drizzle-conduit/<timestamp>_initial_conduit/migration.sql` (T1165 comment-only baseline pattern) + wire `conduit-sqlite.ts` to use `migrateSanitized()` + `reconcileJournal()`

### Wave 2 (depends on Wave 1)
- **W2-A**: T1410 — Commit-msg lint rule (`scripts/hooks/commit-msg-release-lint.mjs`); reject `chore(release):` / `feat(release):` commits without `T\d+` ID
- **W2-B**: T1411 PROMOTED — registry-driven post-release invariants gate
  - New module: `packages/core/src/release/invariants/registry.ts` — invariant registration API
  - First customer: `archive-reason-invariant.ts` — checks released tag commits + reconciles task DB
  - CLI: `cleo verify --release <tag>` (or new `cleo reconcile release --tag <tag>` subcommand)
  - Audit log: append to `.cleo/audit/reconcile.jsonl`

### Wave 3 (final)
- **W3-A**: T1412 — ADR documenting (a) the release-completion invariant + 6 enum values, (b) DB SSoT decisions from this session, (c) naming-convention rule with telemetry folder-variant exception
- **W3-B**: T1413 — Test suite (migration round-trip, hook integration, lint false-positive guards, conduit baseline reconciliation)

### Wave 4 (release)
- Run full quality gates: `pnpm biome ci .` + `pnpm run build` + `pnpm run test`
- Bump CalVer (current: v2026.4.143 → v2026.4.144)
- Add CHANGELOG section
- Cherry-pick + tag + push
- Verify CI green

## Out of scope for tonight
- `cleo db migrate-all` CLI (Phase 3 in research) — file as follow-up task
- Cross-DB integration test in test suite
- Rust Diesel sunset/cloud-only README in `crates/signaldock-storage/migrations/`
- T897 v3 columns in Rust Diesel (cloud workload concern, not local CLI)

## Risk register
- **Rename `task-store.ts`** has high cross-file impact — gitnexus_impact must be run; expect d=1 callers in cleo/dispatch and tests
- **Conduit baseline migration** must be comment-only marker so existing DBs detect tables and mark applied (T1165 pattern); failure mode is re-running CREATE TABLE on existing data
- **T1411 registry** introduces new module surface — keep API minimal, archiveReason as ONE customer, not over-engineered
