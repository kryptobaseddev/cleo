# Orphan Disposition Report — Agent C

**Date**: 2026-05-11  
**Source**: `.cleo/agent-outputs/CLEANUP-2026-05-11/baseline-deps-validate.json`  
**Snapshot**: `.cleo/agent-outputs/CLEANUP-2026-05-11/active-tasks-snapshot.json`

## Summary

| Bucket | Count |
|--------|------:|
| TEST_FIXTURE_DELETE (orphan leaves) | 124 |
| TEST_FIXTURE_DELETE (extra epic-level fixtures) | 9 |
| REAL_REPARENT | 0 |
| UNCERTAIN | 0 |
| **TOTAL DELETIONS** | **133** |

## Findings

- **All 124 orphans are test fixtures.** Every orphan has either a generic stub title (
  "Task N", "Target N", "Default role task", "Spike task alpha"), an `(imported)` /
  `(imported-N)` suffix, or a state-name title ("Blocked", "Pending dep", "Ready").
- **Zero orphans reference real CLEO domain concepts** (NEXUS, BRAIN, sentient,
  harness, LAFS, CANT, CONDUIT, LOOM, etc.) in title or description.
- **All orphans appear in active-tasks-snapshot.json** with `status ∈ {pending, active}`
  (none archived).
- **T002 and T505** were noted in the brief as archived-but-referenced — they are NOT
  in the active snapshot, so no action is taken here (Agent A removes the dep refs).
- The brief's additional epic-level fixtures (E1, T603, T932EP, T1972, T800, T810,
  T1958, T1962, T1966) are NOT in the orphan validate list (they have no parent
  themselves but `E_ORPHAN` may have been suppressed for `type:epic` records) — included
  in Section 1b of the script with `--force --cascade` to clear them and any children.

## Disposition Table

| ID | Title | Bucket | Command | Reasoning |
|----|-------|--------|---------|-----------|
| T-RECONCILE-FOLLOWUP-v2026.5.38-2 | Reconcile T1889 for v2026.5.38 (verification absent) | TEST_FIXTURE_DELETE | `cleo delete T-RECONCILE-FOLLOWUP-v2026.5.38-2 --force` | auto-generated reconcile-followup placeholder; release already shipped |
| T-RECONCILE-FOLLOWUP-v2026.5.38-3 | Reconcile T9031 for v2026.5.38 (verification absent) | TEST_FIXTURE_DELETE | `cleo delete T-RECONCILE-FOLLOWUP-v2026.5.38-3 --force` | auto-generated reconcile-followup placeholder; release already shipped |
| T-cap-001 | Capacity test task | TEST_FIXTURE_DELETE | `cleo delete T-cap-001 --force` | explicit "Capacity test task" fixture |
| T000 | Task 0 | TEST_FIXTURE_DELETE | `cleo delete T000 --force` | generic numeric stub T0XX (T000-T080 series) |
| T005 | Task 5 | TEST_FIXTURE_DELETE | `cleo delete T005 --force` | generic numeric stub T0XX (T000-T080 series) |
| T006 | Task 6 | TEST_FIXTURE_DELETE | `cleo delete T006 --force` | generic numeric stub T0XX (T000-T080 series) |
| T007 | Task 7 | TEST_FIXTURE_DELETE | `cleo delete T007 --force` | generic numeric stub T0XX (T000-T080 series) |
| T008 | Task 8 | TEST_FIXTURE_DELETE | `cleo delete T008 --force` | generic numeric stub T0XX (T000-T080 series) |
| T009 | Task 9 | TEST_FIXTURE_DELETE | `cleo delete T009 --force` | generic numeric stub T0XX (T000-T080 series) |
| T010 | Task 10 | TEST_FIXTURE_DELETE | `cleo delete T010 --force` | generic numeric stub T0XX (T000-T080 series) |
| T011 | Task 11 | TEST_FIXTURE_DELETE | `cleo delete T011 --force` | generic numeric stub T0XX (T000-T080 series) |
| T012 | Task 12 | TEST_FIXTURE_DELETE | `cleo delete T012 --force` | generic numeric stub T0XX (T000-T080 series) |
| T013 | Task 13 | TEST_FIXTURE_DELETE | `cleo delete T013 --force` | generic numeric stub T0XX (T000-T080 series) |
| T014 | Task 14 | TEST_FIXTURE_DELETE | `cleo delete T014 --force` | generic numeric stub T0XX (T000-T080 series) |
| T015 | Task 15 | TEST_FIXTURE_DELETE | `cleo delete T015 --force` | generic numeric stub T0XX (T000-T080 series) |
| T016 | Task 16 | TEST_FIXTURE_DELETE | `cleo delete T016 --force` | generic numeric stub T0XX (T000-T080 series) |
| T017 | Task 17 | TEST_FIXTURE_DELETE | `cleo delete T017 --force` | generic numeric stub T0XX (T000-T080 series) |
| T018 | Task 18 | TEST_FIXTURE_DELETE | `cleo delete T018 --force` | generic numeric stub T0XX (T000-T080 series) |
| T019 | Task 19 | TEST_FIXTURE_DELETE | `cleo delete T019 --force` | generic numeric stub T0XX (T000-T080 series) |
| T020 | Task 20 | TEST_FIXTURE_DELETE | `cleo delete T020 --force` | generic numeric stub T0XX (T000-T080 series) |
| T021 | Task 21 | TEST_FIXTURE_DELETE | `cleo delete T021 --force` | generic numeric stub T0XX (T000-T080 series) |
| T022 | Task 22 | TEST_FIXTURE_DELETE | `cleo delete T022 --force` | generic numeric stub T0XX (T000-T080 series) |
| T023 | Task 23 | TEST_FIXTURE_DELETE | `cleo delete T023 --force` | generic numeric stub T0XX (T000-T080 series) |
| T024 | Task 24 | TEST_FIXTURE_DELETE | `cleo delete T024 --force` | generic numeric stub T0XX (T000-T080 series) |
| T025 | Task 25 | TEST_FIXTURE_DELETE | `cleo delete T025 --force` | generic numeric stub T0XX (T000-T080 series) |
| T026 | Task 26 | TEST_FIXTURE_DELETE | `cleo delete T026 --force` | generic numeric stub T0XX (T000-T080 series) |
| T027 | Task 27 | TEST_FIXTURE_DELETE | `cleo delete T027 --force` | generic numeric stub T0XX (T000-T080 series) |
| T028 | Task 28 | TEST_FIXTURE_DELETE | `cleo delete T028 --force` | generic numeric stub T0XX (T000-T080 series) |
| T029 | Task 29 | TEST_FIXTURE_DELETE | `cleo delete T029 --force` | generic numeric stub T0XX (T000-T080 series) |
| T030 | Task 30 | TEST_FIXTURE_DELETE | `cleo delete T030 --force` | generic numeric stub T0XX (T000-T080 series) |
| T031 | Task 31 | TEST_FIXTURE_DELETE | `cleo delete T031 --force` | generic numeric stub T0XX (T000-T080 series) |
| T032 | Task 32 | TEST_FIXTURE_DELETE | `cleo delete T032 --force` | generic numeric stub T0XX (T000-T080 series) |
| T033 | Task 33 | TEST_FIXTURE_DELETE | `cleo delete T033 --force` | generic numeric stub T0XX (T000-T080 series) |
| T034 | Task 34 | TEST_FIXTURE_DELETE | `cleo delete T034 --force` | generic numeric stub T0XX (T000-T080 series) |
| T035 | Task 35 | TEST_FIXTURE_DELETE | `cleo delete T035 --force` | generic numeric stub T0XX (T000-T080 series) |
| T036 | Task 36 | TEST_FIXTURE_DELETE | `cleo delete T036 --force` | generic numeric stub T0XX (T000-T080 series) |
| T037 | Task 37 | TEST_FIXTURE_DELETE | `cleo delete T037 --force` | generic numeric stub T0XX (T000-T080 series) |
| T038 | Task 38 | TEST_FIXTURE_DELETE | `cleo delete T038 --force` | generic numeric stub T0XX (T000-T080 series) |
| T039 | Task 39 | TEST_FIXTURE_DELETE | `cleo delete T039 --force` | generic numeric stub T0XX (T000-T080 series) |
| T040 | Task 40 | TEST_FIXTURE_DELETE | `cleo delete T040 --force` | generic numeric stub T0XX (T000-T080 series) |
| T041 | Task 41 | TEST_FIXTURE_DELETE | `cleo delete T041 --force` | generic numeric stub T0XX (T000-T080 series) |
| T042 | Task 42 | TEST_FIXTURE_DELETE | `cleo delete T042 --force` | generic numeric stub T0XX (T000-T080 series) |
| T043 | Task 43 | TEST_FIXTURE_DELETE | `cleo delete T043 --force` | generic numeric stub T0XX (T000-T080 series) |
| T044 | Task 44 | TEST_FIXTURE_DELETE | `cleo delete T044 --force` | generic numeric stub T0XX (T000-T080 series) |
| T045 | Task 45 | TEST_FIXTURE_DELETE | `cleo delete T045 --force` | generic numeric stub T0XX (T000-T080 series) |
| T046 | Task 46 | TEST_FIXTURE_DELETE | `cleo delete T046 --force` | generic numeric stub T0XX (T000-T080 series) |
| T047 | Task 47 | TEST_FIXTURE_DELETE | `cleo delete T047 --force` | generic numeric stub T0XX (T000-T080 series) |
| T048 | Task 48 | TEST_FIXTURE_DELETE | `cleo delete T048 --force` | generic numeric stub T0XX (T000-T080 series) |
| T049 | Task 49 | TEST_FIXTURE_DELETE | `cleo delete T049 --force` | generic numeric stub T0XX (T000-T080 series) |
| T050 | Task 50 | TEST_FIXTURE_DELETE | `cleo delete T050 --force` | generic numeric stub T0XX (T000-T080 series) |
| T051 | Task 51 | TEST_FIXTURE_DELETE | `cleo delete T051 --force` | generic numeric stub T0XX (T000-T080 series) |
| T052 | Task 52 | TEST_FIXTURE_DELETE | `cleo delete T052 --force` | generic numeric stub T0XX (T000-T080 series) |
| T053 | Task 53 | TEST_FIXTURE_DELETE | `cleo delete T053 --force` | generic numeric stub T0XX (T000-T080 series) |
| T054 | Task 54 | TEST_FIXTURE_DELETE | `cleo delete T054 --force` | generic numeric stub T0XX (T000-T080 series) |
| T055 | Task 55 | TEST_FIXTURE_DELETE | `cleo delete T055 --force` | generic numeric stub T0XX (T000-T080 series) |
| T056 | Task 56 | TEST_FIXTURE_DELETE | `cleo delete T056 --force` | generic numeric stub T0XX (T000-T080 series) |
| T057 | Task 57 | TEST_FIXTURE_DELETE | `cleo delete T057 --force` | generic numeric stub T0XX (T000-T080 series) |
| T058 | Task 58 | TEST_FIXTURE_DELETE | `cleo delete T058 --force` | generic numeric stub T0XX (T000-T080 series) |
| T059 | Task 59 | TEST_FIXTURE_DELETE | `cleo delete T059 --force` | generic numeric stub T0XX (T000-T080 series) |
| T060 | Task 60 | TEST_FIXTURE_DELETE | `cleo delete T060 --force` | generic numeric stub T0XX (T000-T080 series) |
| T061 | Task 61 | TEST_FIXTURE_DELETE | `cleo delete T061 --force` | generic numeric stub T0XX (T000-T080 series) |
| T062 | Task 62 | TEST_FIXTURE_DELETE | `cleo delete T062 --force` | generic numeric stub T0XX (T000-T080 series) |
| T063 | Task 63 | TEST_FIXTURE_DELETE | `cleo delete T063 --force` | generic numeric stub T0XX (T000-T080 series) |
| T064 | Task 64 | TEST_FIXTURE_DELETE | `cleo delete T064 --force` | generic numeric stub T0XX (T000-T080 series) |
| T065 | Task 65 | TEST_FIXTURE_DELETE | `cleo delete T065 --force` | generic numeric stub T0XX (T000-T080 series) |
| T066 | Task 66 | TEST_FIXTURE_DELETE | `cleo delete T066 --force` | generic numeric stub T0XX (T000-T080 series) |
| T067 | Task 67 | TEST_FIXTURE_DELETE | `cleo delete T067 --force` | generic numeric stub T0XX (T000-T080 series) |
| T068 | Task 68 | TEST_FIXTURE_DELETE | `cleo delete T068 --force` | generic numeric stub T0XX (T000-T080 series) |
| T069 | Task 69 | TEST_FIXTURE_DELETE | `cleo delete T069 --force` | generic numeric stub T0XX (T000-T080 series) |
| T070 | Task 70 | TEST_FIXTURE_DELETE | `cleo delete T070 --force` | generic numeric stub T0XX (T000-T080 series) |
| T071 | Task 71 | TEST_FIXTURE_DELETE | `cleo delete T071 --force` | generic numeric stub T0XX (T000-T080 series) |
| T072 | Task 72 | TEST_FIXTURE_DELETE | `cleo delete T072 --force` | generic numeric stub T0XX (T000-T080 series) |
| T073 | Task 73 | TEST_FIXTURE_DELETE | `cleo delete T073 --force` | generic numeric stub T0XX (T000-T080 series) |
| T074 | Task 74 | TEST_FIXTURE_DELETE | `cleo delete T074 --force` | generic numeric stub T0XX (T000-T080 series) |
| T075 | Task 75 | TEST_FIXTURE_DELETE | `cleo delete T075 --force` | generic numeric stub T0XX (T000-T080 series) |
| T076 | Task 76 | TEST_FIXTURE_DELETE | `cleo delete T076 --force` | generic numeric stub T0XX (T000-T080 series) |
| T077 | Task 77 | TEST_FIXTURE_DELETE | `cleo delete T077 --force` | generic numeric stub T0XX (T000-T080 series) |
| T078 | Task 78 | TEST_FIXTURE_DELETE | `cleo delete T078 --force` | generic numeric stub T0XX (T000-T080 series) |
| T079 | Task 79 | TEST_FIXTURE_DELETE | `cleo delete T079 --force` | generic numeric stub T0XX (T000-T080 series) |
| T080 | Task 80 | TEST_FIXTURE_DELETE | `cleo delete T080 --force` | generic numeric stub T0XX (T000-T080 series) |
| T100 | Task 100 | TEST_FIXTURE_DELETE | `cleo delete T100 --force` | generic numeric stub T1XX series (T100, T110-T119) |
| T101 | P0 bug | TEST_FIXTURE_DELETE | `cleo delete T101 --force` | "P0 bug" stub fixture |
| T106 | Target 6 | TEST_FIXTURE_DELETE | `cleo delete T106 --force` | "Target 6" stub fixture |
| T110 | Task 10 | TEST_FIXTURE_DELETE | `cleo delete T110 --force` | generic numeric stub T1XX series (T100, T110-T119) |
| T111 | Task 11 | TEST_FIXTURE_DELETE | `cleo delete T111 --force` | generic numeric stub T1XX series (T100, T110-T119) |
| T112 | Task 12 | TEST_FIXTURE_DELETE | `cleo delete T112 --force` | generic numeric stub T1XX series (T100, T110-T119) |
| T113 | Task 13 | TEST_FIXTURE_DELETE | `cleo delete T113 --force` | generic numeric stub T1XX series (T100, T110-T119) |
| T114 | Task 14 | TEST_FIXTURE_DELETE | `cleo delete T114 --force` | generic numeric stub T1XX series (T100, T110-T119) |
| T115 | Task 15 | TEST_FIXTURE_DELETE | `cleo delete T115 --force` | generic numeric stub T1XX series (T100, T110-T119) |
| T116 | Task 16 | TEST_FIXTURE_DELETE | `cleo delete T116 --force` | generic numeric stub T1XX series (T100, T110-T119) |
| T117 | Task 17 | TEST_FIXTURE_DELETE | `cleo delete T117 --force` | generic numeric stub T1XX series (T100, T110-T119) |
| T118 | Task 18 | TEST_FIXTURE_DELETE | `cleo delete T118 --force` | generic numeric stub T1XX series (T100, T110-T119) |
| T119 | Task 19 | TEST_FIXTURE_DELETE | `cleo delete T119 --force` | generic numeric stub T1XX series (T100, T110-T119) |
| T1335 | Task (imported) | TEST_FIXTURE_DELETE | `cleo delete T1335 --force` | auth/imported-N fixture (imported test data) |
| T1364 | Task (imported-2) | TEST_FIXTURE_DELETE | `cleo delete T1364 --force` | auth/imported-N fixture (imported test data) |
| T1367 | Test task (imported-2) | TEST_FIXTURE_DELETE | `cleo delete T1367 --force` | auth/imported-N fixture (imported test data) |
| T1957 | Auth API (imported-3) | TEST_FIXTURE_DELETE | `cleo delete T1957 --force` | auth/imported-N fixture (imported test data) |
| T1961 | Task (imported-3) | TEST_FIXTURE_DELETE | `cleo delete T1961 --force` | auth/imported-N fixture (imported test data) |
| T1965 | Task (imported-4) | TEST_FIXTURE_DELETE | `cleo delete T1965 --force` | auth/imported-N fixture (imported test data) |
| T1969 | Frontend auth (imported) | TEST_FIXTURE_DELETE | `cleo delete T1969 --force` | auth/imported-N fixture (imported test data) |
| T200 | Research task | TEST_FIXTURE_DELETE | `cleo delete T200 --force` | role/kind fixture (Research/Work stubs) |
| T201 | Work task | TEST_FIXTURE_DELETE | `cleo delete T201 --force` | role/kind fixture (Research/Work stubs) |
| T300 | Spike task alpha | TEST_FIXTURE_DELETE | `cleo delete T300 --force` | spike fixture (Spike alpha/beta) |
| T301 | Spike task beta | TEST_FIXTURE_DELETE | `cleo delete T301 --force` | spike fixture (Spike alpha/beta) |
| T302 | Documented | TEST_FIXTURE_DELETE | `cleo delete T302 --force` | "Documented" gates fixture |
| T400 | Default role task | TEST_FIXTURE_DELETE | `cleo delete T400 --force` | role/scope defaults fixture |
| T401 | Default scope task | TEST_FIXTURE_DELETE | `cleo delete T401 --force` | role/scope defaults fixture |
| T402 | Task T402 | TEST_FIXTURE_DELETE | `cleo delete T402 --force` | role/scope defaults fixture |
| T500 | Task T500 | TEST_FIXTURE_DELETE | `cleo delete T500 --force` | gates state fixture (T500-T506) |
| T501 | Partial gates | TEST_FIXTURE_DELETE | `cleo delete T501 --force` | gates state fixture (T500-T506) |
| T502 | Ready | TEST_FIXTURE_DELETE | `cleo delete T502 --force` | gates state fixture (T500-T506) |
| T503 | Dep task | TEST_FIXTURE_DELETE | `cleo delete T503 --force` | gates state fixture (T500-T506) |
| T504 | Blocked task | TEST_FIXTURE_DELETE | `cleo delete T504 --force` | gates state fixture (T500-T506) |
| T506 | Task with done dep | TEST_FIXTURE_DELETE | `cleo delete T506 --force` | gates state fixture (T500-T506) |
| T601 | Pending dep | TEST_FIXTURE_DELETE | `cleo delete T601 --force` | orchestrate-spawn state fixture (Pending/Blocked/Verify/Ready) |
| T602 | Blocked | TEST_FIXTURE_DELETE | `cleo delete T602 --force` | orchestrate-spawn state fixture (Pending/Blocked/Verify/Ready) |
| T605 | Needs verify | TEST_FIXTURE_DELETE | `cleo delete T605 --force` | orchestrate-spawn state fixture (Pending/Blocked/Verify/Ready) |
| T606 | Ready to spawn | TEST_FIXTURE_DELETE | `cleo delete T606 --force` | orchestrate-spawn state fixture (Pending/Blocked/Verify/Ready) |
| T701 | Task T701 | TEST_FIXTURE_DELETE | `cleo delete T701 --force` | ordering fixture |
| T702 | Third | TEST_FIXTURE_DELETE | `cleo delete T702 --force` | ordering fixture |
| T8001 | Verified work shipped in v0 | TEST_FIXTURE_DELETE | `cleo delete T8001 --force` | release-verification dry-run fixture |
| T8002 | Unverified work | TEST_FIXTURE_DELETE | `cleo delete T8002 --force` | release-verification dry-run fixture |
| T8003 | Verified work (dry-run case) | TEST_FIXTURE_DELETE | `cleo delete T8003 --force` | release-verification dry-run fixture |
| T932E | T932 integration epic | TEST_FIXTURE_DELETE | `cleo delete T932E --force` | composer integration test epic fixture |

### Section 1b — Extra epic-level test fixtures (not in orphan list)

These are referenced by the brief but were not in the orphan validate list
(they may have been epic-typed and excluded from the orphan check).
Deleted with `--cascade` to mop up any child stubs.

| ID | Title | Command | Reasoning |
|----|-------|---------|-----------|
| E1 | Test Epic | `cleo delete E1 --force --cascade` | orchestrate/lifecycle test epic |
| T603 | Epic | `cleo delete T603 --force --cascade` | minimal-title fixture epic |
| T932EP | T932 standalone epic with no files | `cleo delete T932EP --force --cascade` | role auto-promotion test epic |
| T1972 | Epic: Auth (imported-2) | `cleo delete T1972 --force --cascade` | imported auth-epic fixture |
| T800 | Task T800 | `cleo delete T800 --force --cascade` | epic-typed stub T800 |
| T810 | Task T810 | `cleo delete T810 --force --cascade` | epic-typed stub T810 |
| T1958 | JWT tokens (imported) | `cleo delete T1958 --force --cascade` | imported auth fixture |
| T1962 | JWT tokens (imported-2) | `cleo delete T1962 --force --cascade` | imported auth fixture |
| T1966 | JWT tokens (imported-3) | `cleo delete T1966 --force --cascade` | imported auth fixture |

## UNCERTAIN

_(none)_

Every orphan was decisively classified as a test fixture based on:
1. Title pattern (generic numeric, role/scope/state words, `(imported)` suffix)
2. Empty or near-empty description
3. Absence of any real CLEO domain keyword
4. ID range matching documented test-fixture series in the brief

## REAL_REPARENT

_(none)_

No orphan referenced a real concept in any candidate epic
(T942, T990, T1007, T1042, T1135, T1136, T1137, T1212, T1232, T1250, T1407, T1428,
T1434, T1461, T1465, T1466, T1467, T1555, T1563, T1586, T1685, T1737, T1768, T1840,
T1855, T1892, T9097, T9098, T9118, T9144, T9163, T9187, T9193, T9194).

## Notes

- Orphans are leaves (no children depend on them in the active set) — deleted with
  `--force` alone is sufficient. `--force` also covers the case where another stub
  in the same pass holds a `depends` reference.
- `--cascade` is applied to epic-level fixtures in Section 1b to clear any latent
  child stubs that may exist outside the orphan view.
- Section 1c re-issues `--cascade` for orphan IDs that the brief also flagged as
  epic-level fixtures (T932E, T1957, T1961, T1965, T1969, T1335, T1364, T1367).
  These commands are idempotent — they no-op if the leaf delete already succeeded.
- Some orphans may carry `relates` entries to non-orphan tasks; per the brief,
  `relates` are not hard deps and do not block deletion.

## Files

- `/mnt/projects/cleocode/.cleo/agent-outputs/CLEANUP-2026-05-11/orphan-disposition.sh`
- `/mnt/projects/cleocode/.cleo/agent-outputs/CLEANUP-2026-05-11/orphan-disposition.md`
