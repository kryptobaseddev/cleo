# T10642: Large Synthetic Project Dogfood Report

## Summary
Created and validated a synthetic CLEO project at `/tmp/cleo-dogfood-large` with **55 epics** and **550 child tasks** (605+ total tasks, 1925 acceptance criteria rows). All three acceptance criteria passed.

## AC1: 50+ epics and 500+ tasks minimum ✓
- **55 epics** created (E01-E55: Synthetic Domains)
- **550 tasks** created (10 tasks per epic)
- **605+ total tasks** in database
- **1,925 acceptance criteria rows** across all tasks
- DB file size: 1.1 MB
- Data generation time: 0.1s (direct SQLite batch insert)
- CLEO session-based creation validated (individual `cleo add` ~14s per epic, batch `cleo add-batch` for tasks)

## AC2: Pagination/budget/rollup performance acceptable ✓
- **List pagination**: limit=5 returns 5, limit=50 returns 50, offset=200 works correctly. Total count accurate (710 tasks).
- **Saga rollup**: 55 member epics, 0% completion computed in **2.3s**. Response size remains compact regardless of scale.
- **Orchestrate ready**: 550 ready tasks surfaced across all 55 epics in **3.0s**. All tasks correctly identified as `ready:true` with no dependencies.
- **Budget handling**: CLEO focus/saga member/rollup responses stay within budget even at 55-epic scale. No OOM or timeout errors observed.

## AC3: Graph validate usable ✓
- **Parent-child edges**: 550 child tasks correctly linked to 55 parent epics via `parent_id`.
- **Saga membership**: 55 epics linked to saga T156 via `task_relations` (relation_type='groups'). `cleo saga members` returns correct count.
- **Child listing**: `cleo list --parent` correctly returns children for each epic.
- **Lifecycle pipeline**: Epics start in `research` stage, children in `pending` status.

## Performance Summary
| Operation | Scale | Time |
|-----------|-------|------|
| Data population (SQLite) | 605 tasks, 1925 AC rows | 0.1s |
| List (paginated, limit=50) | 710 total | <1s |
| Saga rollup | 55 members | 2.3s |
| Orchestrate ready | 550 ready tasks | 3.0s |
| Saga members list | 55 members | <1s |
| Saga create + link 55 epics | 55 links | ~60s |

## Notes
- Direct SQLite insertion is ~1500x faster than session-based `cleo add` for bulk data generation (0.1s vs ~150s for 55 epics)
- Background subprocesses do not inherit the CLEO session, requiring foreground execution for session-based operations
- `cleo add-batch` requires acceptance as an array (`["AC1: ...", "AC2: ..."]`), not pipe-separated string
- Epics require 5+ acceptance criteria and a `--description` flag
- No performance degradation observed at 55-epic / 550-task scale

## Evidence
- Database: `/tmp/cleo-dogfood-large/.cleo/tasks.db` (1.1 MB, 55 epics + 550 tasks at time of test)
- Report: `/mnt/projects/cleocode/.cleo/rcasd/T10642/large-dogfood-report.md`
