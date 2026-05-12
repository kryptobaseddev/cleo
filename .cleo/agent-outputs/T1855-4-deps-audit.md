# T1859 — Dep-Graph Validation Audit Report

**Date**: 2026-05-05
**Worker**: T1859 (RETRY)
**CLI version**: 2026.5.25 (local build — dist rebuilt before run; stale dist was root cause of prior E_INVALID_OPERATION)
**Epics audited**: T1737, T1768, T1824, T1840, T1844, T1042

---

## Execution Note: Stale Dist

Prior attempt (T1857) and this task's initial run both returned `E_INVALID_OPERATION` for `tasks.deps.validate`. Root cause: `packages/cleo/dist/dispatch/registry.js` was stale — the compiled bundle did not include `deps.validate` / `deps.tree` entries added in T1923 to `packages/cleo/src/dispatch/registry.ts`.

Resolution: ran `node build.mjs` from repo root. The esbuild bundle at `packages/cleo/dist/cli/index.js` was rebuilt and now includes the registry entries. All 6 epics ran successfully with exit 0.

---

## Per-Epic Summary

| Epic | Tasks Checked | Valid | Total Issues | E_MISSING_REF | E_ORPHAN | E_CIRCULAR | E_CROSS_EPIC_GAP | E_STALE_DEP |
|------|---------------|-------|--------------|---------------|----------|------------|------------------|-------------|
| T1737 | 52 | No | 15 | 15 | 0 | 0 | 0 | 0 |
| T1768 | 11 | Yes | 0 | 0 | 0 | 0 | 0 | 0 |
| T1824 | 8 | Yes | 0 | 0 | 0 | 0 | 0 | 0 |
| T1840 | 6 | No | 1 | 1 | 0 | 0 | 0 | 0 |
| T1844 | 7 | No | 5 | 5 | 0 | 0 | 0 | 0 |
| T1042 | 39 | No | 6 | 6 | 0 | 0 | 0 | 0 |
| **TOTAL** | **123** | — | **27** | **27** | **0** | **0** | **0** | **0** |

---

## Per-Issue Detail

All 27 issues are `E_MISSING_REF` — a task's `depends` array references a task ID that does not exist in the database. This occurs when a depended-upon task has been completed and removed, merged into another task, or was never created.

### T1737 — CleoOS (15 issues)

| Task | Missing Dep | Proposed Fix |
|------|-------------|--------------|
| T1737 | T1768 | `cleo update T1737 --remove-dep T1768` (if T1768 is complete/removed) |
| T1737 | T1824 | `cleo update T1737 --remove-dep T1824` |
| T1737 | T1840 | `cleo update T1737 --remove-dep T1840` |
| T1738 | T1826 | `cleo update T1738 --remove-dep T1826` |
| T1739 | T1816 | `cleo update T1739 --remove-dep T1816` |
| T1740 | T1816 | `cleo update T1740 --remove-dep T1816` |
| T1741 | T1841 | `cleo update T1741 --remove-dep T1841` |
| T1742 | T1841 | `cleo update T1742 --remove-dep T1841` |
| T1743 | T1841 | `cleo update T1743 --remove-dep T1841` |
| T1745 | T1819 | `cleo update T1745 --remove-dep T1819` |
| T1750 | T1817 | `cleo update T1750 --remove-dep T1817` |
| T1751 | T1817 | `cleo update T1751 --remove-dep T1817` |
| T1785 | T1841 | `cleo update T1785 --remove-dep T1841` |
| T1786 | T1841 | `cleo update T1786 --remove-dep T1841` |
| T1787 | T1841 | `cleo update T1787 --remove-dep T1841` |

**Repeating patterns in T1737:**
- T1841 referenced by 6 tasks (T1741, T1742, T1743, T1785, T1786, T1787) — T1841 is in the T1840 epic and may have been renamed/merged
- T1816 referenced by T1739 and T1740 — likely merged or superseded
- T1817 referenced by T1750 and T1751 — likely merged or superseded
- T1826 referenced by T1738 — may have been merged into T1824 epic

### T1768 — SDK Tools (0 issues)

No issues. Dep graph is valid.

### T1824 — Decision Storage (0 issues)

No issues. Dep graph is valid.

### T1840 — Multi-language Extractor (1 issue)

| Task | Missing Dep | Proposed Fix |
|------|-------------|--------------|
| T1843 | T1838 | `cleo update T1843 --remove-dep T1838` |

T1838 does not exist in DB. T1843 (Swift extractor) blocked on T1838 — owner should confirm whether T1838 was folded into another task or if T1843's blocker should be updated to a different task ID.

### T1844 — Edge Completeness (5 issues)

| Task | Missing Dep | Proposed Fix |
|------|-------------|--------------|
| T1844 | T1841 | `cleo update T1844 --remove-dep T1841` |
| T1836 | T1841 | `cleo update T1836 --remove-dep T1841` |
| T1837 | T1841 | `cleo update T1837 --remove-dep T1841` |
| T1846 | T1841 | `cleo update T1846 --remove-dep T1841` |
| T1847 | T1841 | `cleo update T1847 --remove-dep T1841` |

T1841 (benchmark harness, child of T1840) is referenced as a dep by 5 tasks across T1844 but does not exist in DB. This is the most common cross-epic missing ref — T1841 may have been renumbered or merged.

### T1042 — Nexus (6 issues)

| Task | Missing Dep | Proposed Fix |
|------|-------------|--------------|
| T1042 | T1845 | `cleo update T1042 --remove-dep T1845` |
| T1834 | T1845 | `cleo update T1834 --remove-dep T1845` |
| T1835 | T1841 | `cleo update T1835 --remove-dep T1841` |
| T1839 | T1841 | `cleo update T1839 --remove-dep T1841` |
| T1844 | T1841 | `cleo update T1844 --remove-dep T1841` |
| T1873 | T1864 | `cleo update T1873 --remove-dep T1864` |

Notes:
- T1845 (benchmark harness) referenced by T1042 epic itself and T1834 — T1845 does not exist in DB
- T1864 referenced by T1873 — T1864 (P0 architectural fix) is marked done and may have been removed from DB
- T1841 appears again as a phantom dep in T1835 and T1839

---

## Recurring Phantom Task IDs

These task IDs appear in multiple epics' dep graphs but do not exist in the DB:

| Phantom ID | Referenced By | Count | Likely Status |
|------------|---------------|-------|---------------|
| T1841 | T1737, T1844, T1042 | 9 references | Likely renamed/merged; was "benchmark harness" in T1840 |
| T1816 | T1737 | 2 references | Unknown — may have been superseded |
| T1817 | T1737 | 2 references | Unknown — may have been superseded |
| T1845 | T1042, T1844 | 2 references | Pending benchmark task — never created? |
| T1826 | T1737 | 1 reference | Likely merged into T1824 |
| T1819 | T1737 | 1 reference | Unknown |
| T1838 | T1840 | 1 reference | Unknown — T1843 (Swift extractor) blocker |
| T1864 | T1042 | 1 reference | Done task removed from DB |

---

## Summary

- **27 total issues** across 4 of 6 epics
- **All issues are E_MISSING_REF** — no orphan tasks, no circular deps, no cross-epic gaps, no stale deps detected by the validator
- **2 epics clean**: T1768 (SDK Tools) and T1824 (Decision Storage)
- **Primary root cause**: T1841 phantom (9 references) — owner should confirm this task's fate and update all dependent tasks accordingly
- **No auto-fixes applied** — all proposed `cleo update --remove-dep` commands above require owner review before execution

---

## Raw JSON Outputs

Raw JSON outputs written to `/tmp/T1859-{epic}.json` for each epic. Contents:

- T1737: 15 E_MISSING_REF issues across 52 tasks
- T1768: valid (11 tasks)
- T1824: valid (8 tasks)
- T1840: 1 E_MISSING_REF issue across 6 tasks
- T1844: 5 E_MISSING_REF issues across 7 tasks
- T1042: 6 E_MISSING_REF issues across 39 tasks
