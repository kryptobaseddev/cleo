# ADR-054: Migration System — Hybrid Path A+

**Status**: Accepted (2026-04-21)
**Date**: 2026-04-21
**Task**: T1173 (epic T1150 — T-MSR RCASD)
**Supersedes**: ADR-027 §2.6 (drizzle-kit generate mandate), ADR-012 (drizzle-kit as primary migration DDL system)
**Superseded-By**: none
**Scope**: `packages/core/src/store/migration-manager.ts`, `packages/core/migrations/`, `drizzle/*.config.ts`, `scripts/`

> Note: a separate `.cleo/adrs/ADR-054-manifest-unification.md` (T1103 / T1093) also
> bears the number 54. The two live in separate directories and cover unrelated concerns:
> the manifest unification is in `.cleo/adrs/`; the migration system governance lives here
> under `docs/adr/`. Future ADRs continue under `docs/adr/`.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
RFC 2119.

---

## Context

### 5-DB Topology and Heterogeneous Runners

CLEO manages five SQLite databases — `tasks.db`, `brain.db`, `nexus.db`, `signaldock.db`,
`telemetry.db` — across project-tier and global-tier scopes. Four of these (tasks, brain,
nexus, telemetry) use `packages/core/src/store/migration-manager.ts` as their runtime
migration orchestrator. `signaldock.db` uses a fully bespoke embedded runner (`_signaldock_migrations`
table, `GLOBAL_EMBEDDED_MIGRATIONS` array in `signaldock-sqlite.ts`) that is structurally
incompatible with the drizzle-kit folder convention.

The migration canonical tree lives at `packages/core/migrations/drizzle-{tasks,brain,nexus,signaldock,telemetry}/`.
A build-time copy to `packages/cleo/migrations/` exists solely to work around `__dirname` math
in the bundle. drizzle-kit configs (`drizzle/*.config.ts`) previously existed only for
tasks, brain, and nexus — signaldock and telemetry had no kit coverage.

### The Reconciler: 6 Accumulated Patches

`migration-manager.ts` (663 lines) carries six production patches accumulated since
ADR-012 was accepted:

| Patch | Task | Edge Case |
|-------|------|-----------|
| Orphaned hash reconciliation | T632 | Hash algorithm changed across Drizzle v0→v1; old DBs had stale journal entries |
| Partial application handling | T920 | Multi-statement migrations crash mid-execution leave partially-applied state |
| Rename-via-drop+create detection | T1135 | RENAME TO migration idiom bypassed the column-add probe loop |
| Drizzle v1 beta name-field backfill | T1137 | Pre-v1-beta code did not write the `name` column; `null` names caused re-runs |
| Bootstrap baseline for orphaned tables | T1141 | Tables existing without a journal required probe-and-mark-applied on first run |
| SQLITE_BUSY exponential backoff | T5185 | Parallel CLI invocations on the same DB race on the SQLite write lock |

All six patches remain necessary for production safety (R1 §2, §5). Removing any would
cause hard failures on existing installations. T1137 alone can be deprecated in v2026.6.0
once all DBs have been migrated past the v1-beta upgrade window.

### Snapshot Chain Broken Since 2026-03-24

The last `snapshot.json` in the drizzle-tasks canonical tree is from
`20260324000000_assignee-column`. Nine subsequent migrations were authored without snapshots
(R1 §1). The drizzle-kit scratchpad at `drizzle/migrations/` diverged further, accumulating
auto-generated slug names (`complex_vampiro`, `melted_wind_dancer`) and orphaned entries. By
the time of the T1150 RCASD investigation, running `drizzle-kit generate` against the
canonical tree produced nonsense names rather than task-linked ones (R2 §3.4). The
diff-against-snapshot workflow was already non-functional.

### drizzle-kit Beta Version Skew

The root `package.json` shipped `drizzle-kit 1.0.0-beta.19-d95b7a4` while `drizzle-orm`
was at `1.0.0-beta.22-ec7b61d` (a custom build). R3 §1.1 confirmed the beta.22 upgrade is
safe (no peer conflict; snapshot format stays at `"version": "7"`). A critical finding:
`pnpm dlx drizzle-kit` is incompatible with the custom drizzle-orm build. The local binary
at `node_modules/.bin/drizzle-kit` MUST always be used.

### config.ts Bugs

`drizzle/brain.config.ts` references `./packages/core/src/store/brain-schema.ts`, which
does not exist. The brain schema lives at `memory-schema.ts` (R3 §1.2). All three existing
config `out` paths pointed at the scratchpad rather than the canonical tree.

### signaldock Structural Anomaly

Signaldock uses a non-standard loose SQL file (`2026-04-17-213120_T897_agent_registry_v3.sql`)
rather than versioned folders. Drizzle's `readMigrationFiles()` will not pick it up (R1 §4
"CRITICAL STRUCTURAL ANOMALY"). Signaldock's bespoke embedded runner does not participate
in the drizzle-kit snapshot system; bringing it into a drizzle-kit-primary workflow would
require an epic-scale refactor (R3 §6.1).

### Owner's Initial Lean and the Decisive Counterargument

The owner entered T1150 RCASD with a stated preference for Path B: restoring drizzle-kit
as the primary migration source with a baseline-reset of snapshot chains. This preference
was treated as an evidence-weighted prior, not a mandate. R3 §7–8 discovered the decisive
counterargument: the live `__drizzle_migrations` journal tracks `packages/core/migrations/`
names while the drizzle-kit snapshot tracks `drizzle/migrations/` names. These chains have
never been unified. Reconciling them would require non-trivial `migration-manager.ts` surgery
(R3 §8 "Dual migration chain conflict" HIGH, §9 effort = 10.5 hours total).

### T1162 Governance Bug

During the T1150 orchestration on 2026-04-21, a subagent unilaterally advanced the parent
epic through all lifecycle stages (research → release) in a 75-second window (17:59:17 to
18:00:32), bypassing the RCASD gate machinery. This incident is tracked as **T1162
(T-MSR-META-01, P1)**. The RECOMMENDATION.md ceremony proceeds despite the bypass because
the synthesized decision reflects actual research work. T1162 must be resolved before the
next RCASD epic is initiated; its acceptance criteria require that lifecycle stage advancement
for an epic must require explicit epic ownership, orchestrator role flag, or HITL approval —
never a transitive side-effect of a child task verify or complete.

---

## Decision

**Adopt Hybrid Path A+.** Owner decision confirmed 2026-04-21.

### Core Principle

`migration-manager.ts` (`reconcileJournal()` and all six patches) is the **runtime SSoT**.
drizzle-kit is retained as a **devDependency for scaffolding only**: it generates DDL
proposals that humans curate, then rename and promote to the canonical tree. drizzle-kit
does NOT own the `__drizzle_migrations` journal; it does NOT gate deploys; it does NOT
run at startup.

### What Is IN Hybrid Path A+

**drizzle-kit at `1.0.0-beta.22` stays as a devDependency.** It is used exclusively for
schema diff generation (`node_modules/.bin/drizzle-kit generate`) — never `pnpm dlx`,
never `drizzle-kit push`, never as a migration runner. The kit is a scaffolding aid; its
output is advisory until a developer promotes it to the canonical tree.

**`migration-manager.ts` is unchanged.** All six patches (T632, T920, T1135, T1137, T1141,
T5185) are retained. Zero dual-chain reconciliation surgery is required.

**drizzle-kit configs fixed and extended (T1163).** The `out` path bugs and the
`brain.config.ts` schema reference are corrected. New configs for signaldock and telemetry
are added so the full 5-DB surface is covered by scaffolding.

**Baseline-reset snapshots per DB (T1165).** The generator is run against throwaway
copies of tasks, brain, and nexus DBs to bring snapshot chains to current state. The
brain probe-migration (which includes a `brain_page_edges` DROP+RECREATE with `PRAGMA
foreign_keys=OFF`) MUST be reviewed by a human before any production apply.

**Generator script `scripts/new-migration.mjs` (T1164).** Wraps
`node_modules/.bin/drizzle-kit generate`, post-processes output to strip trailing
`--> statement-breakpoint` tokens, renames the folder to the canonical
`YYYYMMDDHHMMSS_tNNNN-<slug>/` convention, and runs the linter. Developer workflow:

```bash
pnpm db:new -- --db tasks --task T1234 --name add-column
```

**Linter in CI (T1168).** `scripts/lint-migrations.mjs` is wired into the pre-commit hook
and CI workflow. It enforces:

- **RULE-1**: no trailing `-->`statement-breakpoint` at end of file
- **RULE-2**: no duplicate timestamps within a DB set
- **RULE-3**: no inconsistent snapshot chains (no mix of snapshot and non-snapshot folders in same DB set once baseline-reset is done)
- **RULE-4**: no flat SQL files in a folder-based DB set

**Runtime guard confirmed.** The existing `sanitizeMigrationStatements()` in
`migration-manager.ts` already strips trailing `-->  statement-breakpoint` tokens from
migration content at load time. No new runtime code is required; this is a confirmed
defence-in-depth layer (R2 §4).

**Partial indexes expressed in schema (T1174).** R3 §4 confirmed that `.where()` on
`IndexBuilder` works correctly in drizzle-kit beta.22. The `tasks-schema.ts` comment at
lines 285–288 claiming `.where()` is unsupported is incorrect and will be corrected (T1170).
Future partial indexes MUST be expressed in schema TypeScript and generated via the
generator script.

**signaldock converted to standard folder structure (T1166).** The bare SQL bootstrap file
is converted to the versioned folder convention so the migration runner can pick it up.

**drizzle/ scratchpad deleted (T1167).** `drizzle/migrations/` is removed. The canonical
tree at `packages/core/migrations/` is the only migration store.

### What Is OUT of Hybrid Path A+

- **Full drizzle-kit journal ownership.** The runtime `__drizzle_migrations` table remains
  managed exclusively by `migration-manager.ts`. drizzle-kit snapshots are advisory
  scaffolding aids, not authoritative migration records.
- **drizzle-kit push.** Not used. Not added.
- **Signaldock into drizzle-kit scope.** Signaldock's bespoke embedded runner is not
  replaced. It remains a structurally distinct migration system (R3 §6.1).
- **Core externalization (bundle 69% reduction).** R4 documents that making
  `@cleocode/core` external in the cleo bundle would shrink the tarball from 4.3 MB to
  ~1.3 MB and eliminate `syncMigrationsToCleoPackage()`. This work is deferred to Wave 3
  — it is not part of Wave 2A.
- **T1137 removal.** Deferred to v2026.6.0 per R1 §5 once all installations have passed
  the Drizzle v1-beta upgrade window.

---

## Rationale

### R2 Finding: Reconciler Already SSoT; Zero Changes Required Under Path A

R2 §7 confirmed that `readMigrationFiles()` from drizzle-orm reads only `migration.sql` —
it never reads `snapshot.json`. None of the four reconciler scenarios (bootstrap, orphan
hashes, partial application, null-name backfill) depend on snapshot existence. Path A+
therefore retains the full reconciler invariant at zero code cost.

### R3 Finding: brain.db 261-Line FK-Off Risk Blocks Full Path B

R3 §3.2 found that `drizzle-kit generate` against the current brain schema produces a
261-line migration including `PRAGMA foreign_keys=OFF`, a full `brain_page_edges`
DROP+RECREATE, and `PRAGMA foreign_keys=ON`. While data-preserving, this pattern globally
disables FK validation during execution. Any FK constraint error during the block leaves FK
validation disabled. The risk is rated HIGH (R3 §8). A human review gate is mandatory
before this migration is applied to production; it is not safe to automate unconditionally.

### signaldock and telemetry Coverage Uniformity

Under full Path B, signaldock.db would remain outside drizzle-kit scope (R3 §6.1 verdict:
epic-scale refactor). Hybrid Path A+ addresses signaldock via T1166 (folder-structure
conversion) and adds a drizzle-kit config for telemetry without requiring the bespoke
embedded runner to be replaced. This achieves uniform scaffolding coverage across all five
DBs at lower risk than Path B.

### ADR-051 Evidence Principle

ADR-051 establishes that every verification gate MUST be backed by programmatic evidence
that CLEO validates against git, the filesystem, or the toolchain. The Hybrid Path A+
linter, runtime guard, and generator script collectively satisfy this principle for the
migration domain: the linter is the authoring-time evidence gate, the runtime guard is the
apply-time evidence check, and the generator produces auditable diffs before any DDL
reaches a production DB.

### Weighted Comparison

Eight criteria scored 1 (poor) to 5 (excellent), correctness and migration safety weighted
2× (source: RECOMMENDATION.md decision table):

| Criterion | Path A | Path B | **Hybrid A+** |
|-----------|--------|--------|---------------|
| Correctness risk | 4 | 2 | **4** |
| Ongoing maintenance cost | 3 | 3 | **4** |
| Migration safety | 4 | 2 | **5** |
| Partial-index-in-schema support | 2 | 4 | **5** |
| Observability (studio, introspection) | 2 | 4 | **3** |
| Bundler coupling | 3 | 3 | **4** |
| Team-skill fit | 3 | 2 | **5** |
| Long-term drift risk | 3 | 2 | **4** |
| **Weighted total** | **30** | **22** | **36** |

---

## Consequences

### Positive

- **Stable reconciler.** No new patches required from authoring slip: the generator script
  and linter prevent the footguns that previously produced timestamp collisions and
  trailing-breakpoint malformations.
- **Schema-first partial indexes.** `.where()` is working in beta.22 (R3 §4). Future
  partial indexes are expressed in TypeScript schema files and generated via the kit, not
  hand-authored as raw SQL.
- **Uniform 5-DB scaffolding coverage.** T1163 + T1166 bring all five DBs into the
  drizzle-kit config surface. Telemetry and signaldock are no longer invisible to
  scaffolding tooling.
- **Developer ergonomics.** A single `pnpm db:new` invocation handles timestamp
  generation, slug normalisation, breakpoint stripping, and linter verification. Agents
  and human developers use the same workflow.
- **Auditable diff trail.** drizzle-kit generates a diff against the current snapshot
  before any SQL reaches the canonical tree. Reviewers see the exact DDL delta, not a
  hand-authored guess.

### Negative

- **Ongoing generator script maintenance.** `scripts/new-migration.mjs` is a new owned
  artifact. It must be updated if drizzle-kit CLI flags change (manageable given the kit
  is pinned).
- **Baseline-reset one-time effort.** T1165 requires running the generator against
  throwaway DB copies and human review of the brain migration before it is promoted.
  This is a one-time cost.

### Neutral

- **drizzle-kit stays as a devDependency** (vs. pure Path A removal). This is a slight
  increase in the dependency surface in exchange for `.where()` partial index support,
  `drizzle-kit check` utility, and generated diff review. The kit never runs at startup
  and is not in the critical install path for end users.
- **Snapshot chain freshness maintained by the generator, not by hand.** Because all
  new migrations go through `scripts/new-migration.mjs`, the snapshot in
  `packages/core/migrations/` is updated automatically as a side-effect of the generate
  step. No manual `snapshot.json` maintenance is required.

---

## Migration Path

The concrete implementation is Wave 2A (12 tasks under epic T1150):

| Task | Title | Notes |
|------|-------|-------|
| T1163 | Fix drizzle/*.config.ts out paths + add signaldock/telemetry configs | Config bug fix (brain.config.ts schema path) + uniform coverage |
| T1164 | Author scripts/new-migration.mjs generator wrapper | Core authoring ergonomic; depends on T1161 worktrunk integration |
| T1165 | Baseline-reset snapshot chains for tasks/brain/nexus | Human review required for brain probe-migration before production apply |
| T1166 | Convert signaldock bare SQL bootstrap to standard folder structure | Structural fix; removes CRITICAL ANOMALY from R1 §4 |
| T1167 | Delete drizzle/ scratchpad folders | Removes stale scratchpad; canonical tree is sole migration store |
| T1168 | Wire lint-migrations.mjs into pre-commit hook + CI | RULE-1/2/3/4 enforcement; depends on T1164 context |
| T1169 | Wire drizzle-kit check into CI as schema-consistency gate | Advisory consistency gate alongside the linter |
| T1170 | Fix stale .where()-not-supported comment in tasks-schema.ts | Correctness fix for lines 285–288 per R3 §4 finding |
| T1171 | Scan schema files for hand-rolled partial indexes worth migrating | Inventory task; feeds T1174 |
| T1172 | Author packages/core/migrations/README.md — Hybrid Path A+ workflow | Developer documentation |
| T1173 | Author ADR-054 (this document) | Governance artifact |
| T1174 | Adopt .where() for T1126 partial index — regenerate via schema | Depends on T1164 + T1165 + T1168 all complete |

Wave sequencing: T1163, T1165, T1166, T1167, T1169, T1170, T1171, T1172 are independently
runnable in parallel. T1164 depends on T1161. T1168 depends on T1164. T1174 depends on
T1164, T1165, and T1168.

Wave 3 (future, not part of this ADR's scope): R4 documents the `resolveMigrationsFolder()`
ESM-safe rewrite, `syncMigrationsToCleoPackage()` elimination, and `@cleocode/core`
externalization. This wave is a separate RCASD decomposition targeting the bundler
architecture rather than the migration authoring workflow.

---

## Alternatives Considered

### Path A (hand-roll only, drizzle-kit removed)

Remove drizzle-kit entirely. All migrations are hand-authored SQL. The linter enforces
naming conventions; the reconciler is unchanged.

**Rejected because**: loses `.where()` partial index support (R3 §4 confirmed it works
in beta.22); loses the diff-against-snapshot review step; forces every schema change to
be written as raw DDL without a generated diff to review.

### Path B (drizzle-kit restored as primary, dual-chain unified)

Perform a baseline-reset of all three drizzle-kit configs, promote generated migrations
to the canonical tree, and update `migration-manager.ts` to reconcile the dual journal
chains.

**Rejected because**: (1) the brain.db `PRAGMA foreign_keys=OFF` + DROP+RECREATE pattern
rates HIGH risk (R3 §8); (2) the dual-chain reconciliation requires ~3 hours of
`migration-manager.ts` surgery, adding new attack surface to the most safety-critical code
in the project; (3) signaldock cannot be brought into scope without an epic-scale refactor
(R3 §6.1); (4) weighted total of 22 vs Hybrid A+'s 36.

---

## Footnotes

1. **T5185 patch count discrepancy.** R1 §2 section header lists 5 patches (T632, T920,
   T1135, T1137, T1141) but §5 and RECOMMENDATION.md both document a sixth: T5185
   (SQLITE_BUSY exponential backoff). This ADR uses **6** as the correct count, consistent
   with the R1 §5 table which enumerates all six.

2. **R2 vs R3 on partial index support.** R2 §3.1 concluded that `.where()` partial
   indexes were "already unusable" under the existing code comment, treating this as
   confirming Path A loses nothing. R3 §4 found that `.where()` IS working in beta.22
   and that the comment is incorrect. These findings are compatible (the comment is wrong;
   the capability exists) but led to different conclusions in the two research arms. Hybrid
   A+ resolves the discrepancy by adopting `.where()` via T1174 and correcting the
   comment via T1170.

3. **cleo/migrations vs core/migrations sync gap.** R4 §1 states "Missing in cleo: 2
   migrations (likely T949-era additions)." R1 §4 shows `cleo/ = core/ ✓` at 15/15 and
   14/14 for tasks and brain respectively. This discrepancy may reflect a pre-build vs
   post-build state difference between the two research runs. The canonical tree remains
   `packages/core/migrations/`; the cleo/ copy is a build-time artefact only.

---

## Appendix: Wave 3 Completion (v2026.4.109)

Hybrid Path A+ was validated and shipped in Wave 2A (v2026.4.108). Wave 3
(v2026.4.109) completed the bundle externalization playbook, moving `@cleocode/core`
to an external peer dependency and eliminating the 55-file migration sync debt:

- **T1177** (e47c11941): ESM-native module resolution for 5 migration folders
- **T1178** (fd3ff9b03): Externalize @cleocode/core from cleo bundle
- **T1179** (5e6dfd854): Postinstall check for missing @cleocode/core
- **T1180** (1a9738cf9): Remove syncMigrationsToCleoPackage()
- **T1181** (996dc9cdd): @cleocode/core as peerDependency
- **T1182** (158717cde): Delete packages/cleo/migrations/
- **T1185** (3ec738ddd): cleo-os startup migration-verify check

Bundle size: 6.64 MB → 1.89 MB (-71.6%). Tarball: 1.3 MB → 1.2 MB (-92 KB).

---

## References

- **RECOMMENDATION.md** — T1156 synthesis; primary decision source
- **R1-db-audit.md** — T1152; 5-DB topology + reconciler patch inventory
- **R2-path-a-prototype.md** — T1153; linter prototype + Path A feasibility
- **R3-path-b-prototype.md** — T1154; drizzle-kit beta.22 probe + brain FK-off risk
- **R4-bundle-architecture.md** — T1155; bundle externalization feasibility (Wave 3)
- **T1150** — T-MSR RCASD epic
- **T1152–T1159** — RCASD research + consensus + spec + decomposition children
- **T1162** — T-MSR-META-01: governance bug (subagent unilateral lifecycle advance)
- **T1163–T1174** — Wave 2A implementation tasks
- **ADR-027** — Manifest SQLite Migration (§2.6 mandated drizzle-kit generate workflow; partially superseded here)
- **ADR-012** — Drizzle-Kit Migration System (original drizzle-kit adoption ADR; superseded by this document)
- **ADR-051** — Programmatic Gate Integrity (evidence-based verify; informs the linter/guard/generator triad)
- `packages/core/src/store/migration-manager.ts` — runtime reconciler (663 lines, 6 patches)
- `packages/core/migrations/` — canonical migration tree (source of truth)
- `scripts/lint-migrations.mjs` — migration linter (T1168)
- `scripts/new-migration.mjs` — generator wrapper (T1164)
