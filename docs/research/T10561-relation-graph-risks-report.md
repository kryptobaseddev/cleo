# T10561 Relation Graph Risks and Reason Gaps Report

Generated: 2026-05-25T19:56:15Z

Scope: read-only audit of the active CLEO task database for relation graph risks. The isolated worktree `.cleo/tasks.db` is 0 bytes, so the audit source was `/mnt/projects/cleocode/.cleo/tasks.db` opened with sqlite `mode=ro&immutable=1`; no database writes were made.

## Summary
- multi-saga membership conflicts found: passed (count=5)
- duplicate relation type needs found: passed (count=8; reciprocal duplicate edges=18)
- relations lacking reasons counted: passed (count=215)

## Metrics
- relations_total: 378
- relations_lacking_reasons: 215
- relation_types_with_lacking_reasons: 9
- multi_saga_membership_conflicts: 5
- duplicate_relation_type_needs: 8
- reciprocal_duplicate_edges: 18
- db_sha256: `3cfbfa9cbc1258badf5ea879450c4b6f0511d204b29adc4a9219a0686ed26f5e`

## Relation reason gaps by type
| relation_type | relation_count | lacking_reason_count |
|---|---:|---:|
| groups | 171 | 171 |
| related | 92 | 25 |
| blocks | 63 | 1 |
| supersedes | 23 | 9 |
| absorbs | 10 | 1 |
| extends | 9 | 1 |
| fixes | 4 | 1 |
| grouped-by | 4 | 4 |
| duplicates | 2 | 2 |

## Risk class 1: multi-saga membership conflicts
These member epics are linked by `groups` from more than one saga-labeled task. If saga membership is intended to be singular, these rows need owner reconciliation; if multi-saga membership is intended, the invariant should be documented and enforced explicitly.
Total reported: 5

| member | status | saga_count | sagas | title |
|---|---|---:|---|---|
| T10102 | done | 2 | T10099: SG-RELEASE-AUDIT-V2: Monorepo versioning + release + CI structure audit + optimization \|\| T9758: SG-CLEO-RELEASE-PRODUCT: cleo release becomes the canonical release-management product for any project type | E-WORKFLOW-AUDIT: Full inventory of all 13 .github/workflows/*.yml files + dedup + optimization plan |
| T10103 | done | 2 | T10099: SG-RELEASE-AUDIT-V2: Monorepo versioning + release + CI structure audit + optimization \|\| T9758: SG-CLEO-RELEASE-PRODUCT: cleo release becomes the canonical release-management product for any project type | E-CLEO-RELEASE-VERBS: Audit 6 cleo release verbs end-to-end, eliminate gaps surfaced by v5.100 ship, remove deprecated ship verb |
| T10104 | done | 2 | T10099: SG-RELEASE-AUDIT-V2: Monorepo versioning + release + CI structure audit + optimization \|\| T9758: SG-CLEO-RELEASE-PRODUCT: cleo release becomes the canonical release-management product for any project type | E-RELEASE-PREPARE-FIX [P0]: release-prepare.yml only bumps @cleocode/* deps + adds post-merge tag automation |
| T10105 | done | 2 | T10099: SG-RELEASE-AUDIT-V2: Monorepo versioning + release + CI structure audit + optimization \|\| T9758: SG-CLEO-RELEASE-PRODUCT: cleo release becomes the canonical release-management product for any project type | E-RELEASE-PLAN-CHANGELOG [P1]: cleo release plan must fail loud on changeset YAML parse error + always write CHANGELOG section |
| T10106 | done | 2 | T10099: SG-RELEASE-AUDIT-V2: Monorepo versioning + release + CI structure audit + optimization \|\| T9758: SG-CLEO-RELEASE-PRODUCT: cleo release becomes the canonical release-management product for any project type | E-CI-PARITY-AUDIT: Per-job inventory across all workflows + PR/main trigger parity verification |

## Risk class 2: duplicate relation type needs
These unordered task pairs carry more than one relation type across the same pair of endpoints. The current `task_relations` primary key is directional `(task_id, related_to)`, so reverse edges can encode additional semantics, but a canonical relation model may need a pair+type key or typed multi-edge support to represent this intentionally.
Total reported: 8

| endpoint_a | endpoint_b | edge_count | relation_type_count | edges |
|---|---|---:|---:|---|
| T10343 | T10400 | 2 | 2 | T10400->T10343:extends [Implementation of envelope-first doctrine] \|\| T10343->T10400:supersedes [Doctrine ratified; T10400 SG-CLEO-SDK-API supersedes the implementation portion] |
| T10377 | T10418 | 2 | 2 | T10418->T10377:related [Coordinate with IVTR 4-CORE-tools subset to avoid duplication] \|\| T10377->T10418:blocks [T10377 ships the narrow IVTR AC-binding and Validator tool subset that T10418 must consume rather than duplicate.] |
| T1910 | T9066 | 2 | 2 | T9066->T1910:fixes [T9066 fixes regression introduced by T9016 (under T1910): git-shim/src/__tests__/boundary-enforcement.test.ts had 5 tests fail because @cleocode/paths.getCleoHome caches env at module-init while tests inject XDG_DATA_HOME post-load. Blocks T1910 parent rollups (testsPassed gate).] \|\| T1910->T9066:related [T9066 is a regression-fix child task of T1910 — closes the testsPassed gate blocker.] |
| T9515 | T9977 | 2 | 2 | T9977->T9515:groups \|\| T9515->T9977:extends [T9515 spawn-hang epic moved into SG-WORKTRUNK-OWN per sg-alignment-2026-05-22 owner-decision: T9977 E3-E5 Rust napi addresses root cause; T9515 stays as regression-tracking] |
| T9585 | T9586 | 2 | 2 | T9585->T9586:groups \|\| T9586->T9585:grouped-by |
| T9585 | T9587 | 2 | 2 | T9585->T9587:groups \|\| T9587->T9585:grouped-by |
| T9585 | T9591 | 2 | 2 | T9585->T9591:groups \|\| T9591->T9585:grouped-by |
| T9585 | T9592 | 2 | 2 | T9585->T9592:groups \|\| T9592->T9585:grouped-by |

## Risk class 3: relations lacking reasons
These are relation rows with `reason IS NULL` or blank after trimming. Missing reasons reduce auditability for graph migrations and for PM-core relation UX.
Total lacking reasons: 215

First 25 examples:

| task | relation_type | related_to | task_title | related_title |
|---|---|---|---|---|
| T001 | absorbs | T103 | Cancelled | Task T103 |
| T001 | blocks | T101 | Cancelled | P0 bug |
| T001 | duplicates | T003 | Cancelled | Subtask |
| T001 | duplicates | T102 | Cancelled | Task T102 |
| T001 | extends | T105 | Cancelled | Task T105 |
| T001 | fixes | T104 | Cancelled | Task T104 |
| T9586 | grouped-by | T9585 | E-WORKTREE-IVTR: fix worktree-HEAD provenance + IVTR pipeline | SG-CLEO-CORE-V2: legacy Core V2 stabilization for worktree IVTR, setup, and CORE-first boundaries |
| T9587 | grouped-by | T9585 | E-AUDIT-V2-FIXES: fix 12 bugs from T9573 E-CONFIG-AUTH-UNIFY audit | SG-CLEO-CORE-V2: legacy Core V2 stabilization for worktree IVTR, setup, and CORE-first boundaries |
| T9591 | grouped-by | T9585 | E-CLEO-SETUP-V2: full progressive setup + config wizard beyond LLM auth | SG-CLEO-CORE-V2: legacy Core V2 stabilization for worktree IVTR, setup, and CORE-first boundaries |
| T9592 | grouped-by | T9585 | E-CORE-FIRST-ARCH: solidify @cleocode/core as central system with CLI + API exposure | SG-CLEO-CORE-V2: legacy Core V2 stabilization for worktree IVTR, setup, and CORE-first boundaries |
| T10099 | groups | T10102 | SG-RELEASE-AUDIT-V2: Monorepo versioning + release + CI structure audit + optimization | E-WORKFLOW-AUDIT: Full inventory of all 13 .github/workflows/*.yml files + dedup + optimization plan |
| T10099 | groups | T10103 | SG-RELEASE-AUDIT-V2: Monorepo versioning + release + CI structure audit + optimization | E-CLEO-RELEASE-VERBS: Audit 6 cleo release verbs end-to-end, eliminate gaps surfaced by v5.100 ship, remove deprecated ship verb |
| T10099 | groups | T10104 | SG-RELEASE-AUDIT-V2: Monorepo versioning + release + CI structure audit + optimization | E-RELEASE-PREPARE-FIX [P0]: release-prepare.yml only bumps @cleocode/* deps + adds post-merge tag automation |
| T10099 | groups | T10105 | SG-RELEASE-AUDIT-V2: Monorepo versioning + release + CI structure audit + optimization | E-RELEASE-PLAN-CHANGELOG [P1]: cleo release plan must fail loud on changeset YAML parse error + always write CHANGELOG section |
| T10099 | groups | T10106 | SG-RELEASE-AUDIT-V2: Monorepo versioning + release + CI structure audit + optimization | E-CI-PARITY-AUDIT: Per-job inventory across all workflows + PR/main trigger parity verification |
| T10113 | groups | T10208 | E10-SAGA-FIRST-CLASS: promote Saga from label-overlay to first-class tier with runtime-enforced ADR-073 invariants — fixes T10090 auto-close + T9831 nesting + 10-of-15 list bug | E-SAGAS-CORE-MODULE: extract packages/core/src/sagas/ + move saga ops out of dispatch (T10113 AC1+AC11) |
| T10113 | groups | T10209 | E10-SAGA-FIRST-CLASS: promote Saga from label-overlay to first-class tier with runtime-enforced ADR-073 invariants — fixes T10090 auto-close + T9831 nesting + 10-of-15 list bug | E-SAGAS-INVARIANT-GATES: runtime gates for ADR-073 I3/I5/I7 + doctor audit + sagaList repair (T10113 AC2-4+7-8) |
| T10113 | groups | T10210 | E10-SAGA-FIRST-CLASS: promote Saga from label-overlay to first-class tier with runtime-enforced ADR-073 invariants — fixes T10090 auto-close + T9831 nesting + 10-of-15 list bug | E-SAGAS-AUTOCLOSE-RECONCILE-CLOSEOUT: completeTask integration + idempotent reconcile + 5 violation cleanups + ADR (T10113 AC5-6+9-10) |
| T10176 | groups | T10192 | SG-BOUNDARY-REGISTRY: Boundary as data in @cleocode/contracts + complete worktrunk vendor + delete cleo-llm-native + publish signaldock SDK from its own home (parallel saga) | E1-WORKTREE-LIFECYCLE: spawn-hang fix + worktree CLI commands + auto-cleanup + lifecycle spec |
| T10176 | groups | T10193 | SG-BOUNDARY-REGISTRY: Boundary as data in @cleocode/contracts + complete worktrunk vendor + delete cleo-llm-native + publish signaldock SDK from its own home (parallel saga) | E2-BOUNDARY-REGISTRY-CORE: ship boundary.ts SSoT + CI gates per ADR-078 |
| T10176 | groups | T10194 | SG-BOUNDARY-REGISTRY: Boundary as data in @cleocode/contracts + complete worktrunk vendor + delete cleo-llm-native + publish signaldock SDK from its own home (parallel saga) | E3-WORKTRUNK-VENDOR-COMPLETE: vendor remaining ~2900 LOC from /mnt/projects/worktrunk + napi exports + TS rewire |
| T10176 | groups | T10195 | SG-BOUNDARY-REGISTRY: Boundary as data in @cleocode/contracts + complete worktrunk vendor + delete cleo-llm-native + publish signaldock SDK from its own home (parallel saga) | E4-COUNCIL-FOLLOWUPS: Council probe + release-prepare bug + worktree-napi global resolution + CLI bugs + command optimization |
| T10176 | groups | T10218 | SG-BOUNDARY-REGISTRY: Boundary as data in @cleocode/contracts + complete worktrunk vendor + delete cleo-llm-native + publish signaldock SDK from its own home (parallel saga) | E3-PREREQ-SDK-REFACTOR: extract worktrunk command handlers into SDK primitives (refactor + parity tests + separation of concerns) |
| T10180 | groups | T10211 | SG-SIGNALDOCK-EXTRACT: Extract signaldock-* crates from cleocode → self-sustained at /mnt/projects/signaldock/ monorepo + crates.io publish | E-SIGNALDOCK-WORKSPACE: Restructure signaldock as Cargo workspace |
| T10180 | groups | T10212 | SG-SIGNALDOCK-EXTRACT: Extract signaldock-* crates from cleocode → self-sustained at /mnt/projects/signaldock/ monorepo + crates.io publish | E-SIGNALDOCK-REPO-CLEANUP: Archive defunct + delete duplicate |

## Validation
Machine-readable evidence: `/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T10561/.cleo/rcasd/T10561/T10561-relation-graph-risks-evidence.json`

VitestJsonLike validation: success=True, total=3, passed=3, failed=0.

Acceptance criteria status: passed. All three query classes executed and produced reportable counts; non-zero risk counts are findings, not validation failures.
