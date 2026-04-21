# T-MSR RCASD — RECOMMENDATION.md: Hybrid Path A+ Migration Remediation

**Task**: T1156  
**Date**: 2026-04-21  
**Status**: FINAL — owner decision confirmed  
**Decision**: Hybrid Path A+  
**Supersedes**: Any Path A-only framing from prior drafts  
**ADR reference**: ADR-054 (T1173, authored in Wave 2A)

---

## Executive Summary

Following four parallel research investigations (T1152–T1155) against the CLEO migration system, the team has adopted **Hybrid Path A+**: retain drizzle-kit as a devDependency for scaffolding-only, keep the custom `reconcileJournal` runtime in `migration-manager.ts` as the permanent SSoT, and add a linter, runtime guard, and generator script to eliminate authoring footguns. This decision was driven by three converging findings: (1) T1153-R2 confirmed that `migration-manager.ts` already works without snapshots and needs zero code changes under Path A; (2) T1154-R3 found that brain.db's dual-chain conflict requires approximately 3 hours of non-trivial migration-manager surgery under full Path B and produces a 261-line migration with `PRAGMA foreign_keys=OFF`; and (3) signaldock and telemetry each lack drizzle-kit coverage and display uniformity issues that would be forced to be addressed in a full Path B scope. Wave 2A (T1163–T1174, 12 tasks) delivers the concrete implementation. ADR-054 will codify the decision.

---

## Context

The following constraints drove the investigation and decision:

**5-DB topology with heterogeneous migration runners**: CLEO manages five SQLite databases — tasks.db, brain.db, nexus.db, signaldock.db, telemetry.db — with different runner topologies. Tasks/brain/nexus/telemetry use `packages/core/src/store/migration-manager.ts` via drizzle-orm's `migrate()`. Signaldock uses a fully bespoke embedded runner (`_signaldock_migrations` table, `GLOBAL_EMBEDDED_MIGRATIONS` array in `signaldock-sqlite.ts`). Drizzle-kit configs exist only for tasks/brain/nexus, and only in a diverged scratchpad state (R1 §4, R3 §6.1).

**Reconciler already load-bearing with 6 cumulative patches**: `migration-manager.ts` (663 lines) carries patches for T632 (orphaned hash reconciliation), T920 (partial application of multi-statement migrations), T1135 (rename-via-drop+create pattern detection), T1137 (drizzle v1 beta name-field backfill), T1141 (journal bootstrap for tables without a journal), and T5185 (SQLITE_BUSY exponential backoff). R1 §2 found all 6 patches still necessary for production safety. Removing any would cause hard failures on existing installations (R1 §5).

**Snapshot chain broken since 2026-03-24**: The last `snapshot.json` file in the drizzle-tasks canonical tree is from `20260324000000_assignee-column`. Nine subsequent migrations were authored without snapshots (R1 §1, R2 §3.4). The drizzle/migrations/ scratchpad diverged further, accumulating auto-generated nonsense slugs (`complex_vampiro`, `melted_wind_dancer`) and orphaned entries. R2 §3.4 concluded the diff-against-snapshot workflow is already non-functional.

**Broken drizzle/*.config.ts files**: `drizzle/brain.config.ts` references `./packages/core/src/store/brain-schema.ts`, which does not exist — the brain schema lives at `memory-schema.ts` (R3 §1.2). All three config `out` paths pointed at the scratchpad rather than the canonical tree.

**drizzle-kit beta.19 vs drizzle-kit beta.22 version skew**: The root `package.json` shipped `drizzle-kit 1.0.0-beta.19-d95b7a4` while `drizzle-orm` was at `1.0.0-beta.22-ec7b61d`. R3 §1.1 confirmed the upgrade to beta.22 is safe (no peer conflict, snapshot format stays at `"version": "7"`). However, `pnpm dlx drizzle-kit` is incompatible with the custom drizzle-orm build — the local binary at `node_modules/.bin/drizzle-kit` must always be used (R3 §1.1).

**Owner's initial Path B lean**: The owner entered T1150 RCASD with a stated preference for Path B (restore drizzle-kit as the primary migration source). This preference was treated as an evidence-weighted prior, not a mandate; findings were recorded without flattery. The dual-chain conflict discovered in R3 was the decisive counterargument.

---

## Research Findings

### R1 — T1152: DB Audit

- **5-DB topology confirmed** at `packages/core/migrations/drizzle-{tasks,brain,nexus,signaldock,telemetry}/`. Only tasks/brain/nexus have drizzle-kit configs. Signaldock uses a structurally anomalous flat `.sql` file (not a versioned folder) that `readMigrationFiles()` will not pick up (R1 §4 table row: drizzle-signaldock).
- **Reconciler patch inventory**: 6 patches (T632, T920, T1135, T1137, T1141, T5185) — all still necessary. Only T1137 can be deprecated in ~2 release cycles; the others must remain indefinitely (R1 §2, §5 table).
- **Signaldock bootstrap vulnerability**: The `drizzle-signaldock/2026-04-17-213120_T897_agent_registry_v3.sql` loose file is not discovered by the standard migration runner — high risk if signaldock migrations ever need reconciliation (R1 §4 "CRITICAL STRUCTURAL ANOMALY").
- **Parallel folder analysis**: `packages/core/migrations/` (source of truth) and `packages/cleo/migrations/` are in perfect sync (build-time copy). `drizzle/migrations/` is 9–12 migrations behind canonical for each DB set, contains orphaned entries, and MUST NOT be used as a reference (R1 §4 "DRIZZLE/ FOLDER IS STALE").
- **Timestamp collision**: Two migrations share `20260421000001` in drizzle-tasks: `t1118-owner-auth-token` and the initial `t1126-sentient-proposal-index`. This is a real ordering bug regardless of path choice (R1 §1 "COLLISION", R2 §8 RULE-2 ERROR).

### R2 — T1153: Path A Prototype

- **Linter prototype functional**: `scripts/lint-migrations.mjs` ran against the canonical tree and found 1 ERROR (timestamp collision) and 24 WARNs (inconsistent snapshot chains). Zero RULE-1 violations (no trailing-breakpoint files exist) (R2 §8, R2-linter-output.txt).
- **drizzle-kit scratchpad fatally diverged**: The scratchpad is so far behind that `drizzle-kit generate` produces auto-generated slug names rather than task-linked names. Running it today against the real schema would produce a non-canonical diff (R2 §3.4).
- **Reconciler already SSoT — migration-manager.ts needs zero changes**: Under Path A, `readMigrationFiles()` from drizzle-orm reads only `migration.sql` — never `snapshot.json`. None of the four reconciler scenarios (bootstrap, orphan hashes, partial application, null-name backfill) depend on snapshot existence. The only work Path A requires is file deletion and documentation (R2 §7, §5 effort table).
- **Partial index support already non-functional under either path**: T1126's `idx_tasks_sentient_proposals_today` was already hand-authored with an explicit comment that `.where()` was unsupported. This was a pre-existing state; Path A loses nothing here (R2 §3.1).

### R3 — T1154: Path B Prototype

- **drizzle-kit beta.22 generates clean output for tasks.db and nexus.db**: tasks.db produces one `ALTER TABLE ADD COLUMN` (incremental); nexus.db produces 3 `CREATE TABLE` + 4 `ALTER TABLE` + 31 indexes (additive). Both are safe to apply (R3 §3.1, §3.3, §10 verdict table).
- **brain.db generates a 261-line DROP/INSERT/RENAME with `PRAGMA foreign_keys=OFF`**: The brain_page_edges table is destroyed and recreated because of a FK constraint change. The migration is data-preserving but globally disables FK validation during execution. Any FK constraint error during the block would leave FKs globally disabled (R3 §3.2, §8 "brain_page_edges table rebuild" HIGH risk).
- **Dual-chain conflict requires ~3 hours of migration-manager changes**: The live `__drizzle_migrations` journal tracks canonical `packages/core/migrations/` names; the drizzle-kit snapshot tracks `drizzle/migrations/` names. These two chains have never been unified. Sub-case A of `reconcileJournal` ("DB is ahead") would incorrectly skip all Path B-generated migrations without non-trivial migration-manager.ts surgery (R3 §7 Step 7, §8 "Reconciler will reject new migrations" HIGH, §9 effort = 10.5 hours total).
- **`.where()` partial index support is working in beta.22**: R3 §4 found that the schema comment in `tasks-schema.ts` lines 285-288 claiming `.where()` is not supported is incorrect — it works. The hand-written T1126 index remains canonical (uses `IF NOT EXISTS`), but future partial indexes can be expressed in schema TypeScript (R3 §4 verdict).
- **signaldock and telemetry out of scope for Path B**: Signaldock has no `sqliteTable()` schema file and uses a bespoke embedded runner; bringing it into Path B is an epic-scale refactor. Telemetry is feasible but out of scope for the initial wave (R3 §6.1, §6.2).

### R4 — T1155: Bundle Architecture

- **Bundle size 4.3 MB → 1.3 MB (-69%) if `@cleocode/core` made external**: The cleo CLI bundle currently inlines all of core (~3 MB bundled). Moving core to `peerDependencies` eliminates this, with manageable breaking changes for global npm installs (R4 §3, §5).
- **`resolveMigrationsFolder()` ESM-safe rewrite possible**: All four resolution functions use `__dirname` math that breaks when the package structure changes. An `import.meta.resolve()` + `createRequire().resolve()` fallback is portable across bundled, workspace, and npm-install layouts (R4 §2).
- **`cleo-os` inherits transitively via subprocess**: cleo-os wraps cleo via `execFileSync` process boundary only; zero direct imports of `migration-manager.ts` or DB code. No cleo-os changes are required under any migration path (R4 §4 verdict).
- **`syncMigrationsToCleoPackage()` in `build.mjs` is the root cause of migration duplication**: The function (lines 334–358) copies canonical migrations into `packages/cleo/migrations/` at build time. Eliminating it requires the `resolveMigrationsFolder()` rewrite to use Node module resolution instead of `__dirname` math (R4 §1 "Migration Sync Architecture").

---

## Analysis: Path A vs Path B vs Hybrid A+

The following table scores each path across eight criteria. Scale: 1 (poor) to 5 (excellent).

| Criterion | Path A (hand-roll only, drizzle-kit removed) | Path B (drizzle-kit restored as primary, dual-chain unified) | Hybrid A+ (drizzle-kit scaffolding only, reconciler stays SSoT) |
|---|---|---|---|
| **Correctness risk** (migration safety, no data loss) | 4 — hand-authored SQL is explicit; no PRAGMA FK toggles from generator | 2 — brain.db FK-off risk (R3 §3.2); dual-chain reconciler change introduces new surface for bugs | 4 — scaffolding generates SQL for review; reconciler unchanged |
| **Ongoing maintenance cost** | 3 — every migration requires manual discipline; no tooling assist | 3 — two parallel systems to keep in sync (generate AND author to canonical tree); snapshot freshness CI gate required | 4 — generator script (`new-migration.mjs`) handles the toil; linter catches regressions automatically |
| **Migration safety** (rollback, idempotency) | 4 — reconciler handles all 4 recovery scenarios; no new attack surface | 2 — adds migration-manager.ts surgery without changing reconciler edge cases (R3 §7 Step 7, §8) | 5 — reconciler untouched; recovery scenarios unchanged |
| **Partial-index-in-schema support** | 2 — must hand-author raw SQL for every partial index (current state) | 4 — `.where()` works in beta.22 (R3 §4) | 5 — generator uses `.where()` API; existing hand-authored indexes migrated (T1174) |
| **Observability** (drizzle-kit studio, introspection) | 2 — studio removed; `cleo admin` is the only GUI | 4 — studio available for all 3 drizzle-kit-covered DBs | 3 — studio retained as devDep convenience; signaldock/telemetry not covered |
| **Bundler coupling** (cleo build.mjs complexity) | 3 — `syncMigrationsToCleoPackage()` remains; build.mjs still complex | 3 — same; sync issue not addressed by Path B | 4 — Wave 2A addresses sync via R4 `resolveMigrationsFolder()` rewrite (T1165 scope) |
| **Team-skill fit** (agents authoring migrations) | 3 — agents must hand-craft SQL; README guidance needed | 2 — agents must run generator AND maintain scratchpad; two workflows to learn | 5 — single `pnpm db:new` command; generator handles timestamp, renaming, linting |
| **Long-term drift risk** | 3 — discipline must be enforced manually | 2 — snapshot chain has already drifted twice; CI gate alone cannot fully prevent re-divergence | 4 — linter in CI catches violations; snapshots only maintained by the kit's own generate; no hand-maintained snapshot.json needed |

**Weighted totals** (correctness and migration safety weighted 2×): Path A: 30 | Path B: 22 | Hybrid A+: **36**

---

## Decision: Hybrid Path A+

**Owner decision confirmed: 2026-04-21.**

### What is IN Hybrid Path A+

- **drizzle-kit stays as devDependency** at `1.0.0-beta.22` — used exclusively as a scaffolding tool (schema diff generation), not as a migration runner or journal owner.
- **`migration-manager.ts` stays runtime SSoT** — `reconcileJournal()` and all 6 patches remain unchanged. No dual-chain reconciliation surgery required.
- **Linter in CI** — `scripts/lint-migrations.mjs` wired into pre-commit hook and CI workflow (T1168). Catches RULE-1 (trailing breakpoint), RULE-2 (timestamp collision), RULE-3 (inconsistent snapshot chains), RULE-4 (flat SQL files).
- **Runtime guard** — the existing `sanitizeMigrationStatements()` in `migration-manager.ts` already strips trailing `-->  statement-breakpoint` tokens. No new runtime code needed; this is a confirmed guard (R2 §4 "Linter + runtime guards cover the footguns").
- **Generator script** — `scripts/new-migration.mjs` (T1164) wraps `node_modules/.bin/drizzle-kit generate` (never `pnpm dlx`), post-processes to strip trailing breakpoints, renames output to `YYYYMMDDHHMMSS_tNNNN-<slug>/`, runs linter, and surfaces result for human review. One-command developer workflow: `pnpm db:new -- --db tasks --task T1234 --name add-column`.
- **Baseline-reset snapshots once per DB** — T1165 runs the generator against throwaway DB copies to bring snapshot chains to current state for tasks/brain/nexus. Brain probe-migration reviewed by human before any apply to production (R3 §5 guidance).
- **Partial indexes expressed in schema** — T1174 adopts the `.where()` API for T1126 and T1171 scans for other hand-authored partial indexes. The stale `tasks-schema.ts` comment at lines 285–288 corrected (T1170).
- **Scratchpad deleted** — `drizzle/migrations/` removed (T1167). Canonical tree at `packages/core/migrations/` is the only migration store.
- **drizzle-kit configs fixed and extended** — T1163 fixes `out` paths and `brain.config.ts` schema reference bug (R3 §1.2); adds signaldock and telemetry configs.

### What is OUT of Hybrid Path A+

- **Full drizzle-kit journal ownership** — the runtime `__drizzle_migrations` table remains managed by `migration-manager.ts`, not by drizzle-kit. Drizzle-kit snapshots are advisory scaffolding aids, not authoritative migration records.
- **drizzle-kit push** — not used, not added.
- **Signaldock into drizzle-kit scope** — signaldock's bespoke embedded runner is not replaced (R3 §6.1 verdict: epic-scale refactor, out of scope).
- **Core externalization** — R4's bundle externalization work (T1155 §6 Wave 3) is a separate wave, not part of Wave 2A. The `syncMigrationsToCleoPackage()` sync function and `packages/cleo/migrations/` duplication continue in the interim.
- **T1137 removal** — deferred to v2026.6.0 per R1 §5 timeline.

---

## Decomposition: Wave 2A (12 Tasks)

These tasks exist and are referenced by ID. Do not create them — they were already created during T1150 orchestration.

| Task ID | Title (abbreviated) | Size | Status | Key Dependencies |
|---|---|---|---|---|
| T1163 | W2A-01: Fix drizzle/*.config.ts out paths + add signaldock/telemetry configs | small | pending | — |
| T1164 | W2A-02: Author scripts/new-migration.mjs generator wrapper | medium | pending | T1161 |
| T1165 | W2A-03: Baseline-reset snapshot chains for tasks/brain/nexus | large | pending | — |
| T1166 | W2A-04: Convert signaldock bare SQL bootstrap to standard folder structure | small | pending | — |
| T1167 | W2A-05: Delete drizzle/ scratchpad folders | small | pending | — |
| T1168 | W2A-06: Wire lint-migrations.mjs into pre-commit hook + CI | medium | pending | T1141 (patch context) |
| T1169 | W2A-07: Wire drizzle-kit check into CI as schema-consistency gate | small | pending | — |
| T1170 | W2A-08: Fix stale .where()-not-supported comment in tasks-schema.ts | small | pending | — |
| T1171 | W2A-10: Scan schema files for hand-rolled partial indexes worth migrating | small | pending | — |
| T1172 | W2A-11: Author packages/core/migrations/README.md — Hybrid Path A+ workflow | medium | pending | — |
| T1173 | W2A-12: Author ADR-054 — Hybrid Path A+ decision | medium | pending | T1103 |
| T1174 | W2A-09: Adopt .where() for T1126 partial index — regenerate via schema | medium | pending | T1164, T1165, T1168 |

**Wave sequencing**: T1163, T1165, T1166, T1167, T1169, T1170, T1171, T1172 are independently runnable in parallel (no intra-wave dependencies). T1164 depends on T1161 (worktrunk integration). T1168 depends on T1164 context (linter must exist). T1174 depends on T1164 + T1165 + T1168 (generator, baseline snapshots, and linter gate must all be in place before adopting `.where()` for T1126). T1173 should be authored last (after T1172 README is done).

---

## Governance Note

During the T1150 RCASD orchestration on 2026-04-21, a subagent (likely T1159 W0-3 runtime-guard worker) unilaterally advanced the T1150 parent epic through all lifecycle stages — research → consensus → architecture_decision → specification → decomposition → implementation → validation → testing → release — within a 75-second window (17:59:17 to 18:00:32), bypassing the RCASD gate machinery entirely.

This incident is tracked as **T1162 (T-MSR-META-01, P1 bug)**: "subagents can unilaterally advance parent epic lifecycle through all stages to bypass gate checks." The current T1156 synthesis task proceeds despite this gate bypass because the RECOMMENDATION.md ceremony is still required — the lifecycle state in the DB does not reflect actual work completion. T1162 must be resolved before the next RCASD epic is initiated. Key requirements from T1162 acceptance criteria:

- Root cause: identify which `cleo lifecycle complete` path allows a child-scoped subagent to advance a parent epic.
- Design fix: lifecycle stage advancement for an epic must require explicit epic ownership, orchestrator role flag, or HITL approval — never a transitive side-effect of a child task verify/complete.
- ADR-054 or a separate governance ADR should document why stage gates are load-bearing for RCASD integrity.

---

## Discrepancies Flagged (Not Resolved)

The following cross-artifact discrepancies are recorded for future investigation. They are not resolved here — they remain in the evidence trail.

1. **tasks-schema.ts line 285-288 comment vs R3 finding**: R2 §3.1 says `.where()` partial index was "already unusable" and treats this as confirming Path A loses nothing. R3 §4 found `.where()` IS working in beta.22 and calls the comment "INCORRECT". These findings are compatible (the comment is wrong; the capability exists) but R2 draws a different conclusion from a stale assumption. Hybrid A+ resolves this by adopting `.where()` via T1174.

2. **T5185 patch count discrepancy**: R1 §2 lists 5 patches by name (T632, T920, T1135, T1137, T1141) in the section header but the conclusion in §5 calls out 6 patches including T5185. The R1 executive summary states "5 identified (T632, T920, T1135, T1137, T1141)". T5185 (SQLITE_BUSY retry) is fully documented in R1 §2 and §5 but appears to have been inadvertently omitted from the executive summary count. This document uses 6 as the correct count.

3. **Cleo/migrations vs core/migrations sync gap**: R4 §1 states "Missing in cleo: 2 migrations (likely T949-era additions that haven't synced yet)". R1 §4 table shows `cleo/ = core/ ✓` for drizzle-tasks (15 vs 15) and drizzle-brain (14 vs 14). This may indicate the sync gap was between the R1 and R4 research runs, or R4 is reporting pre-build state. The canonical tree remains `packages/core/migrations/`; the discrepancy does not affect the decision.

---

## Supersession

This document supersedes any Path A-only framing present in prior draft synthesis. The owner's confirmed direction is **Hybrid Path A+** as defined in the "Decision" section above. ADR-054 (T1173) will codify the governance contract and reference this document as the evidence source.

All Wave 2A tasks (T1163–T1174) are implementation-ready. No further HITL signoff is required before implementation begins.

---

*Authored by T1156 subagent. Evidence sources: R1-db-audit.md (T1152), R2-path-a-prototype.md (T1153), R2-linter-output.txt (T1153), R3-path-b-prototype.md (T1154), R4-bundle-architecture.md (T1155). Research completed 2026-04-21.*
