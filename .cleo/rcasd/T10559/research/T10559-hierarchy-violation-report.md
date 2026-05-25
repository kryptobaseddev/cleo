# T10559 Hierarchy Violation Detection Report

Task: T10559 — E2.W0 Detect hierarchy violations
Saga: T10538
Source: copied snapshot `.cleo/rcasd/T10559/research/tasks-readonly-snapshot.db` from `/mnt/projects/cleocode/.cleo/tasks.db`; analyzer opens it with `mode=ro` and `PRAGMA query_only=ON`.
Policy: ADR-073 parent ladder Epic -> Task -> Subtask; Sagas link to Epics using `task_relations.relation_type=groups` and must not consume `parent_id` depth.

## Exact counts

- Total task rows: 3570
- Cycle detector findings: 0
- Blank/null `type` rows: 174
- Tier matrix violations: 353
- Missing parent edges: 0
- Orphan roots: 31
- Type value counts: `{"NULL": 174, "epic": 528, "saga": 1, "subtask": 543, "task": 2324}`
- Normalized tier counts: `{"blank": 174, "epic": 478, "saga": 51, "subtask": 543, "task": 2324}`

## Cycle detector covered (AC1)

Result: 0 cycles found. The detector walks every non-null `parent_id` chain and records an origin when a node repeats; no repeats were present in this snapshot.

## Blank/null type report generated (AC2)

Result: 174 rows. Representative rows:

| id | status | parent_id | title |
|---|---|---|---|
| `/mnt/projects/cleocode` | `pending` | `None` | Task /mnt/projects/cleocode |
| `T-RECONCILE-FOLLOWUP-v2026.5.63-6` | `pending` | `None` | Reconcile T9260 for v2026.5.63 (verification absent) |
| `T-RECONCILE-FOLLOWUP-v2026.5.63-8` | `pending` | `None` | Reconcile T9232 for v2026.5.63 (verification absent) |
| `T000` | `archived` | `None` | Task 0 |
| `T001` | `archived` | `None` | Cancelled |
| `T002` | `archived` | `None` | New done |
| `T003` | `pending` | `T002` | Subtask |
| `T004` | `pending` | `T002` | Task T004 |
| `T005` | `archived` | `None` | Task 5 |
| `T006` | `archived` | `None` | Task 6 |
| `T007` | `archived` | `None` | Task 7 |
| `T008` | `archived` | `None` | Task 8 |
| `T009` | `archived` | `None` | Task 9 |
| `T010` | `archived` | `None` | Task 10 |
| `T011` | `archived` | `None` | Task 11 |

Full list: `.cleo/rcasd/T10559/research/hierarchy_violations.json` key `findings.blank_null_types`.

## Tier matrix violations listed (AC3)

Result: 353 invalid parent/child hierarchy edges. Breakdown by normalized parent_tier -> child_tier:

- `blank` -> `blank`: 17
- `blank` -> `subtask`: 2
- `blank` -> `task`: 22
- `epic` -> `blank`: 12
- `epic` -> `epic`: 65
- `epic` -> `saga`: 1
- `epic` -> `subtask`: 94
- `saga` -> `epic`: 33
- `saga` -> `task`: 63
- `subtask` -> `subtask`: 3
- `task` -> `task`: 41

Representative rows:

| parent_id | parent_tier | child_id | child_tier | child_status | child_title |
|---|---|---|---|---|---|
| `T002` | `` | `T003` | `blank` | `pending` | Subtask |
| `T002` | `` | `T004` | `blank` | `pending` | Task T004 |
| `T10299` | `epic` | `T10077` | `subtask` | `pending` | Worktree cross-contamination: sibling worktree mods appear in unrelated worktree's git status (data-integrity risk) |
| `T10299` | `epic` | `T10078` | `subtask` | `pending` | cleo orchestrate spawn E_TIMEOUT leaves locked worktree + task branch behind — no rollback on partial provision |
| `T9760` | `epic` | `T10083` | `subtask` | `done` | Pre-commit ferrous-forge scans test fixtures (release-test-rust-crate edition=2021) and blocks unrelated commits |
| `T9761` | `epic` | `T10085` | `subtask` | `done` | Stale changesets accumulate in .changeset/ — release plan consumes only the in-scope task's entries; orphan entries from prior releases stay forever |
| `T9492` | `epic` | `T10089` | `subtask` | `done` | cleo add: --severity Px CHECK constraint silently rejects non-bug kinds, but skill docs claim severity is orthogonal |
| `T10195` | `epic` | `T10177` | `subtask` | `done` | release-prepare.yml workflow bumps external deps (regression from v5.100 hotfix #480/#481) |
| `T10195` | `epic` | `T10178` | `subtask` | `done` | @cleocode/worktree-napi-<triple> prebuilt binaries don't resolve under global npm install |
| `T10195` | `epic` | `T10179` | `subtask` | `done` | Executor probe (Council): npm-pack lafs+cant + clean tmpfs install + node-require smoke |
| `T10211` | `epic` | `T10181` | `subtask` | `done` | T10180-W0: Restructure /mnt/projects/signaldock/ as proper Cargo workspace (root Cargo.toml + crates/ dir) |
| `T10213` | `epic` | `T10182` | `subtask` | `done` | T10180-W1: Move signaldock-{core,protocol,storage,transport,sdk,payments} from cleocode/crates/ → signaldock/crates/ |
| `T10213` | `epic` | `T10183` | `subtask` | `done` | T10180-W2: Repoint signaldock/backend/Cargo.toml to path deps within new monorepo (drop git deps to cleocode) |
| `T10214` | `epic` | `T10184` | `subtask` | `done` | T10180-W3: Reconcile cleocode/crates/signaldock-runtime vs /mnt/projects/signaldock-runtime — fold cleocode drift into standalone, then DELETE cleocode copy |
| `T10216` | `epic` | `T10185` | `subtask` | `done` | T10180-W4: Publish signaldock-{core,protocol,storage,transport,sdk,payments} to crates.io with publish=true (v2026.5.0 CalVer) |
| `T10214` | `epic` | `T10186` | `subtask` | `done` | T10180-W5: Update /mnt/projects/signaldock-runtime/Cargo.toml to depend on signaldock SDK via crates.io (drop git deps) |
| `T10217` | `epic` | `T10187` | `subtask` | `done` | T10180-W6: DELETE cleocode/crates/signaldock-*/ entirely (all 7 directories) + clean Cargo.toml + Cargo.lock |
| `T10212` | `epic` | `T10188` | `subtask` | `done` | T10180-W7: ARCHIVE /mnt/projects/signaldock-core/ on GitHub (defunct) + DELETE /mnt/projects/signaldock-runtime-standalone/ on GitHub (byte-identical deprecated) |
| `T10215` | `epic` | `T10189` | `subtask` | `done` | T10180-W8: Update T10176 boundary registry to flip signaldock entries to 'migrated-out' + update cleocode AGENTS.md |
| `T10195` | `epic` | `T10190` | `subtask` | `cancelled` | cleo list --parent <sagaId> returns 0 children when parent edges set via re-parenting (T10176 reproduces) |

Full list: `.cleo/rcasd/T10559/research/hierarchy_violations.json` key `findings.tier_matrix_violations`.

## Orphan roots listed (AC4)

Result: 31 active non-saga/non-epic root rows (`parent_id IS NULL`, normalized tier not saga/epic, status not archived/cancelled). Representative rows:

| id | status | type | title |
|---|---|---|---|
| `/mnt/projects/cleocode` | `pending` | `None` | Task /mnt/projects/cleocode |
| `T-RECONCILE-FOLLOWUP-v2026.5.63-6` | `pending` | `None` | Reconcile T9260 for v2026.5.63 (verification absent) |
| `T-RECONCILE-FOLLOWUP-v2026.5.63-8` | `pending` | `None` | Reconcile T9232 for v2026.5.63 (verification absent) |
| `T10231` | `pending` | `task` | Fold 20 sub-2-min ci.yml lint jobs into single lint-batch job (Wave A — 10 zero-risk lint jobs) |
| `T10232` | `pending` | `task` | Fold remaining 10 ci.yml lint jobs into lint-batch-b (Wave B — active-baseline lints) |
| `T10233` | `pending` | `task` | Collapse arch-boundary-check.yml + boundary-registry-lint.yml + dual-implementation-lint.yml into ci.yml jobs |
| `T10234` | `pending` | `task` | Merge skills-council.yml + skills-grade.yml into single weekly skills-pipeline.yml |
| `T10235` | `pending` | `task` | Diagnose freshness-sentinel.yml — failing every daily run for 5+ days (since 2026-05-18) |
| `T10485` | `done` | `task` | spawn-prompt.ts calls buildChangesetLintGateBlock() but function definition was deleted in T10452 |
| `T10525` | `pending` | `task` | Release-prepare Preflight blocked by studio test failures |
| `T9399` | `pending` | `task` | E-CONFIG-AUTH-UNIFY-E1: Path SSoT enforcement |
| `T9400` | `done` | `task` | E-CONFIG-AUTH-UNIFY-E2a: Credential pool core + seeders |
| `T9401` | `pending` | `task` | E-CONFIG-AUTH-UNIFY-E2b: Pool management + migration + external seeders |
| `T9402` | `done` | `task` | E-CONFIG-AUTH-UNIFY-E3: Setup wizard + status + Studio Keys UI |
| `T9624` | `pending` | `task` | Task Hierarchy Charter consolidation — ADR-073 as SSoT, refit AGENTS.md + CLEO-INJECTION + 3 skills |

Full list: `.cleo/rcasd/T10559/research/hierarchy_violations.json` key `findings.orphan_roots`.

## SQL/query source

- SQL source: `.cleo/rcasd/T10559/research/hierarchy_violation_queries.sql`
- Executable analyzer: `.cleo/rcasd/T10559/test-run/analyze_hierarchy_violations.py`
- VitestJsonLike evidence: `.cleo/rcasd/T10559/test-run/t10559-vitest-jsonlike.json`

## Key Findings

- No parent hierarchy cycles were detected in the snapshot.
- Type hygiene is the largest root data issue: 174 rows have NULL/blank type.
- Parent edge policy violations are material: 353 edges do not match Epic->Task or Task->Subtask.
- 31 active root rows are neither saga nor epic and need triage before strict hierarchy enforcement.

## Needs Follow-up

- Decide whether legacy archived/cancelled blank-type rows should be migrated, quarantined, or exempted from strict checks.
- Split tier matrix violations into safe automatic repairs versus owner-reviewed hierarchy redesigns.
- Decide whether active orphan task roots should be promoted to epics, attached under an existing epic, or explicitly marked as standalone exceptions.
- Re-run this analyzer after E3/E4 migration work to compare counts against the T10558 telemetry baseline.

