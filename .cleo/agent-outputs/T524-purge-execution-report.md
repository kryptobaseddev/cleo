# T524 — Brain.db Purge Execution Report

**Date**: 2026-04-12
**Task**: T524 (Epic: T523)
**Status**: COMPLETE

---

## Backup Taken

Backup ID: `snapshot-2026-04-12T01-56-01-228Z`
Path: `.cleo/backups/snapshot`
Files: tasks.db, brain.db, config.json, project-info.json

---

## Pre-Purge State

| Table | Count |
|-------|-------|
| Patterns | 2482 |
| Learnings | 332 |
| Decisions | 5 |
| Observations | ~239 |
| **TOTAL** | **~3058** |

---

## Purge Rules Applied

### Rule 1: Pattern Deduplication
- Strategy: for each unique pattern text, keep the newest row (max `extracted_at`), delete duplicates
- **Deleted**: 2396 duplicate pattern rows

### Rule 2: Delete ALL Learnings
- All learnings were auto-generated noise: "Completed: T..." prefixes and dependency notices
- **Deleted**: 332 rows (100% of table)

### Rule 3: Delete All Decisions Except D-mntpeeer
- Safety check confirmed D-mntpeeer present before any deletes
- Kept: `D-mntpeeer` — "Use CLI-only dispatch for all CLEO operations"
- **Deleted**: 4 test/audit decision rows

### Rule 4: Delete Observation Noise
Deleted observations matching these patterns:
- `Task start: T*` — task lifecycle noise
- `Task complete: T*` — task lifecycle noise
- `Task T*` — task dependency noise
- `Session note: *` — all session note observations
- Keywords: audit test, audit probe, probe observation, dup test, provider test, brain regression, brain validation, release test, functional validation, test title, sticky note, etc.
- **Deleted**: 198 observation rows

---

## Post-Purge State

| Table | Before | After | Deleted |
|-------|--------|-------|---------|
| Patterns | 2482 | 86 | 2396 |
| Learnings | 332 | 0 | 332 |
| Decisions | 5 | 1 | 4 |
| Observations | ~239 | 41 | ~198 |
| **TOTAL** | **~3058** | **128** | **~2930** |

### Signal Preserved
- **D-mntpeeer**: "Use CLI-only dispatch for all CLEO operations" — CONFIRMED PRESENT
- **Release observation**: O-mntphoj6-0 — "Release v2026.4.30 — Full CLI Remediation" — CONFIRMED PRESENT
- **FTS5 indexes rebuilt**: YES — search verified working post-purge

---

## Verification

### FTS5 Search Verification
```
cleo memory find "CLI-only dispatch"
→ Found: D-mntpeeer (1 result)

cleo memory find "Release v2026"
→ Found: O-mntphoj6-0 (1 result)
```

### Tasks.db Untouched
The purge only operated on brain.db tables:
- brain_patterns
- brain_learnings
- brain_decisions
- brain_observations

tasks.db was not touched.

---

## Files Added

| File | Purpose |
|------|---------|
| `packages/core/src/memory/brain-purge.ts` | Reusable purge function with TSDoc |
| `scripts/brain-purge-runner.ts` | Standalone runner script |
| `packages/cleo/src/cli/commands/brain.ts` | Added `cleo brain purge` subcommand |
| `packages/core/src/internal.ts` | Exported `purgeBrainNoise` and `PurgeResult` |

---

## Quality Gates

- [x] `pnpm biome check --write` — passed
- [x] `pnpm run build` — passed (Build complete)
- [x] `pnpm run test` — 7014 tests pass, 0 new failures

---

## Notes

- The patterns count (86 remaining) is higher than the target of ~29 because the database has grown since T523's analysis. New patterns were added by recent task completions (T525, T526, T527). These 86 are all unique, deduplicated entries.
- Observations count (41 remaining) is higher than the ~27 target for the same reason — real observations from recent sessions are valid signal.
- The purge script is idempotent: re-running it after the first pass deleted 0 additional rows.
