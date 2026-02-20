> **ARCHIVED DOCUMENT**
>
> **Archived**: 2025-12-30
> **Reason**: Historical T1028 epic planning document; implementation complete
> **Superseded by**: [TASK-HIERARCHY-SPEC.md](../../docs/specs/TASK-HIERARCHY-SPEC.md) Parts 5-8
> **Reference**: T1028-DEFINITIVE-WORK-MAP.md consensus decisions
>
> This document is preserved for historical reference only. Do NOT use for implementation guidance.

---

===============================================================================
T1028 EPIC: Enhanced Epic Analysis & Reporting
===============================================================================

SUMMARY
-------------------------------------------------------------------------------
Total: 14 tasks (1 epic + 13 tasks)
Goal: Single command for comprehensive epic analysis
Approach: Enhance existing `analyze` with --parent scoping

PHASE BREAKDOWN
-------------------------------------------------------------------------------
Phase 1 (setup):   4 tasks  | Research & Design
Phase 2 (core):    7 tasks  | Implementation
Phase 3 (testing): 1 task   | Test Suite
Phase 4 (polish):  1 task   | Documentation

DEPENDENCY CHAIN
-------------------------------------------------------------------------------

PHASE 1: SETUP (Research & Design)
+-----------------------------------------------------------------------------+
|                                                                             |
|  T1029: Audit analyze command       T1030: Audit tree/deps/blockers        |
|      |                                     |                                |
|      +--------------+----------------------+                                |
|                     v                                                       |
|              T1031: Design JSON output schema                               |
|                     |                                                       |
|                     v                                                       |
|              T1032: Design wave computation algorithm                       |
|                                                                             |
+-----------------------------------------------------------------------------+
                                     |
                                     v
PHASE 2: CORE (Implementation)
+-----------------------------------------------------------------------------+
|                                                                             |
|  T1029+T1030                                                                |
|      |                                                                      |
|      v                                                                      |
|  T1033: Implement --parent flag                                             |
|      |                                                                      |
|      +--------------------------------------+                               |
|      v                                      v                               |
|  T1034: Phase grouping              T1036: Chain detection                  |
|      |                                      |                               |
|      v                                      |                               |
|  T1037: Inventory (ready/blocked)           |                               |
|      |                                      |                               |
|      |    T1032+T1033                       |                               |
|      |        |                             |                               |
|      |        v                             |                               |
|      |    T1035: Wave computation           |                               |
|      |        |                             |                               |
|      |        +-------------+---------------+                               |
|      |                      v                                               |
|      |              T1038: Execution plan + critical path                   |
|      |                      |                                               |
|      +----------------------+                                               |
|                             v                                               |
|                     T1039: --human ASCII visualization                      |
|                                                                             |
+-----------------------------------------------------------------------------+
                                     |
                                     v
PHASE 3: TESTING
+-----------------------------------------------------------------------------+
|  T1040: Add tests for epic-scoped analyze                                   |
+-----------------------------------------------------------------------------+
                                     |
                                     v
PHASE 4: POLISH
+-----------------------------------------------------------------------------+
|  T1041: Update analyze command documentation                                |
+-----------------------------------------------------------------------------+

EXECUTION WAVES
-------------------------------------------------------------------------------
Wave 1: T1029, T1030 (parallel research)
Wave 2: T1031, T1033 (parallel - schema design + flag impl)
Wave 3: T1032, T1034, T1036 (parallel - algorithms + features)
Wave 4: T1035, T1037 (parallel - wave computation + inventory)
Wave 5: T1038 (execution plan)
Wave 6: T1039 (ASCII output)
Wave 7: T1040 (tests)
Wave 8: T1041 (docs)

KEY DESIGN DECISIONS
-------------------------------------------------------------------------------
* NO new commands - enhance existing `analyze`
* NO new schema fields - compute waves from `depends` + `phase`
* Follows existing patterns - `--parent` like tree/list
* Both JSON and --human output
* Reuses existing logic from deps/blockers where possible
===============================================================================
