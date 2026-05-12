# H3: Dependency Graph Integrity Audit

**Date**: 2026-05-01
**Scope**: All 435 tasks in the cleocode task database
**Auditor**: Read-only analysis (no mutations)

---

## Executive Summary

| Metric | Value |
|--------|-------|
| Total tasks in system | 435 |
| Tasks with at least one `depends` entry | 27 |
| Total unique dependency ID references | 29 |
| Tasks with deps — status=done | 26 |
| Tasks with deps — status=pending | 1 |
| Tasks with deps — status=active | 0 |
| Tasks with deps — status=cancelled | 0 |

### Defect Class Summary

| Class | Count | Severity |
|-------|-------|----------|
| D1: All deps satisfied, task still pending | 1 | Low — task IS in ready set |
| D2: Broken dep refs (task doesn't exist) | 0 | — |
| D3: Cancelled-dep blocking | 0 | — |
| D4: Dependency cycles | 0 | — |
| D5: Self-dependencies | 0 | — |
| D6: Cross-epic dependencies | 6 | Informational — all intentional |
| D7: Done task with pending/active dep | 0 | — |

**Overall health: CLEAN.** The dependency graph is structurally sound. No blocking defects found. One pending task (T1600) is in the ready set — its sole dep (T1593) is done and `cleo orchestrate ready --epic T1586` confirms it.

**Additional structural observation**: Two parent epics (T1563 and T1586) have status=pending despite having all direct children either done or in the ready set. This is a workflow gate issue (owner must trigger final acceptance steps / push / release), NOT a dep-graph defect. Noted below for completeness.

---

## D1: Already-Satisfied Deps (Ready-But-Pending)

Tasks whose `depends` entries are all `status=done` but the task itself is `status=pending`.

| Task | Dep(s) | Dep Status | In Ready Set? | Title |
|------|--------|------------|---------------|-------|
| T1600 | T1593 | done | YES (wave 1, T1586) | T-FOUND-7B: Expand cleo briefing to full handoff replacement |

**Detail**: `cleo orchestrate ready --epic T1586` returns T1600 as a ready task with `blockedBy=[]`. The task is correctly recognized as unblocked by the orchestrator. No action required on the dep graph.

---

## D2: Broken Dep References

No broken dependency references found. All 29 referenced dep IDs exist in the task database and return `success=true` from `cleo show`.

---

## D3: Cancelled-Dep Blocking

No pending or active tasks depend on any cancelled task. The 18 cancelled tasks in the system (T1139, T1626, T1047, T1474-T1481, T1104-T1106, T1130, T1132, T1262, T1468) do not appear in any `depends` list.

---

## D4: Dependency Cycles

No cycles detected. DFS traversal of the complete dependency graph (27 nodes, 32 edges) returned zero cycles.

---

## D5: Self-Dependencies

No self-dependencies found. No task references its own ID in its `depends` list.

---

## D6: Cross-Epic Dependencies

Six cross-epic dependencies exist. All are intentional architectural pre-conditions connecting migration work to foundation lockdown gates. All referenced tasks are `status=done`, so these deps are fully satisfied.

| Dependent Task | Dep's Epic | Dep Task | Dep Status | Assessment |
|----------------|------------|----------|------------|------------|
| T1566 (T1563/ENG-MIGRATION aggregate) | T1586 | T1603: T-FOUNDATION-LOCKDOWN-V2 | done | Intentional: migration can't begin until V2 guards are in place |
| T1566 (T1563/ENG-MIGRATION aggregate) | T1586 | T1611: T-KNOWLEDGE-FIRST-CITIZEN | done | Intentional: knowledge system must be in place before major migration |
| T1568 (T1566/ENG-MIG-1 — first migration) | T1563 | T1565: T-LAYERING-FIX | done | Intentional: layering cleanup is a precondition for engine migration |
| T1568 (T1566/ENG-MIG-1) | T1564 (subtask) | T1585: T-PRE-EXISTING-FAILURES | done | Intentional: existing test failures must be fixed before adding new migration |
| T1568 (T1566/ENG-MIG-1) | T1603 (subtask) | T1604: T-FOUND-V2-1 (LOC-reduction gate) | done | Intentional: quality gate for migration must exist before first migration task |
| T1568 (T1566/ENG-MIG-1) | T1603 (subtask) | T1605: T-FOUND-V2-2 (production-callsite gate) | done | Intentional: quality gate for migration must exist before first migration task |

**Note on architecture**: The cross-epic deps follow a clear pattern — the T1563 master epic required foundation guardrails (from T1586) and pre-condition fixes (T1564/T1585) to be in place before the engine migration chain (T1566, T1568-T1584) could begin. This is correct sequencing.

---

## D7: Order-Violation Cases

No violations found. No `status=done` task depends on a task that was not also `done` at the time of completion. The dep chain is consistently satisfied in order.

---

## Wave / Dep Mismatch Analysis

### T1566 (ENG-MIGRATION epic)

- `cleo orchestrate waves --epic T1566` returns 0 waves (LOOM not initialized for this epic)
- `cleo orchestrate analyze --epic T1566` returns correct dep graph: linear chain T1568→T1569→...→T1584 with T1568 having 4 pre-conditions from other epics
- All 17 children are `status=done`
- No mismatch to report — the linear chain executed correctly in order

### T1586 (FOUNDATION-LOCKDOWN epic)

| Wave | Tasks | Status | Dep Consistency |
|------|-------|--------|-----------------|
| Wave 1 | T1600 (T1593 dep satisfied), T1622 (no deps) | Both pending, both ready | Correct — deps satisfied, wave ordering matches |

- `cleo orchestrate analyze --epic T1586` reports: 0 circular deps, 0 missing deps
- The dep graph within T1586 is a partial DAG: T1587→T1588→T1595→T1597 and T1589→T1593→T1598/T1600, all other tasks independent
- Wave plan is consistent with dep ordering

### T1563 (Master Audit Epic)

- `cleo orchestrate waves --epic T1563` returns 0 waves (LOOM not initialized)
- `cleo orchestrate ready --epic T1563` returns `reason: "epic has no children"` — this appears to be a LOOM initialization gap
- The 4 children (T1564, T1565, T1566, T1567) are all `status=done`
- No dep mismatch — but the LOOM/orchestrate subsystem is not tracking this epic's children properly

---

## Additional Structural Observations (Not Dep-Graph Defects)

### Parent Epics Pending With All Children Done

Two epics are `status=pending` despite having their children complete:

**T1563** (Audit-driven execution master epic):
- 4 direct children: T1564 done, T1565 done, T1566 done, T1567 done
- Remaining acceptance criteria requires owner action: push to `origin/main` + `v2026.4.155` release tag
- This is a workflow gate, not a dep-graph issue

**T1586** (T-FOUNDATION-LOCKDOWN):
- 19 children: 17 done, 2 pending (T1600 and T1622 — both in wave 1 ready set)
- Epic not completable until T1600 and T1622 are done, then owner closes the epic

These are **not dep-graph defects** but are worth surfacing as the owner may want to action T1563's final acceptance criteria (build/push/release) soon.

### LOOM Not Initialized for T1563 and T1566

`cleo orchestrate ready --epic T1563` and `--epic T1566` both return `reason: "epic has no children"` even though both epics have children in the task DB. This suggests LOOM was not initialized for these epics (they were likely managed manually or via direct task creation, not via `cleo orchestrate start`). Since all their children are done, this is harmless but may prevent automated wave tracking if children are added in future.

---

## Recommended Dep Cleanup Pass

No dep graph mutations are required. The graph is clean:

- All broken-ref, cycle, self-dep, cancelled-dep, and order-violation classes have zero instances
- The 6 cross-epic deps are all intentional and all fully satisfied (deps are done)
- The 1 D1 case (T1600) is already in the ready set — the orchestrator correctly unblocks it

**Recommended owner actions** (workflow gates, not dep edits):

1. Action T1563 final acceptance: run `pnpm run build && pnpm run test`, push to `origin/main`, tag `v2026.4.155`
2. Spawn T1600 and T1622 (both ready per wave 1 of T1586) to close out the foundation lockdown epic

---

## Full Dependency Inventory

All 27 tasks with dependency entries, in ID order:

| Task ID | Status | Depends On | Cross-Epic? |
|---------|--------|-----------|-------------|
| T1565 | done | T1564 | No (both T1563) |
| T1566 | done | T1565, T1603, T1611 | Yes (T1603, T1611 are T1586 children) |
| T1568 | done | T1565, T1585, T1604, T1605 | Yes (T1565 is T1563; T1585 is T1564; T1604/T1605 are T1603) |
| T1569 | done | T1568 | No (both T1566) |
| T1570 | done | T1569 | No (both T1566) |
| T1571 | done | T1570 | No (both T1566) |
| T1572 | done | T1571 | No (both T1566) |
| T1573 | done | T1572 | No (both T1566) |
| T1574 | done | T1573 | No (both T1566) |
| T1575 | done | T1574 | No (both T1566) |
| T1576 | done | T1575 | No (both T1566) |
| T1577 | done | T1576 | No (both T1566) |
| T1578 | done | T1577 | No (both T1566) |
| T1579 | done | T1578 | No (both T1566) |
| T1580 | done | T1579 | No (both T1566) |
| T1581 | done | T1580 | No (both T1566) |
| T1582 | done | T1581 | No (both T1566) |
| T1583 | done | T1582 | No (both T1566) |
| T1584 | done | T1583 | No (both T1566) |
| T1588 | done | T1587 | No (both T1586) |
| T1591 | done | T1587 | No (both T1586) |
| T1593 | done | T1589 | No (both T1586) |
| T1594 | done | T1591 | No (both T1586) |
| T1595 | done | T1588 | No (both T1586) |
| T1597 | done | T1595 | No (both T1586) |
| T1598 | done | T1593 | No (both T1586) |
| T1600 | **pending** | T1593 | No (both T1586) |
