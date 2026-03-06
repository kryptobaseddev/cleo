# T5371 Complete: Constitution §6.9 → 31 ops

## Changes made

### Constitution §6.9
- Header: changed from "25 operations" to "31 operations"
- Added 5 new query rows: `critical-path`, `blocking`, `orphans`, `discover`, `search`
- Added 1 new mutate row: `reconcile` (tier 1, was missing from Constitution)
- Updated description to note reconcile is tier 1 (all others are tier 2)
- Summary table: nexus row updated from 12q/13m/25t to 17q/14m/31t
- Grand totals: 121q/91m/212t → 126q/92m/218t
- Tier 1 count: 36 → 37 (reconcile is tier 1)
- Tier 2 count: 39 → 44 (5 new query ops are tier 2)

### Atlas
No changes needed. Atlas already references nexus.db and SQLite correctly. No stale operation counts found.

### dispatch/registry.ts header
Updated comment from "207 operations (118 query + 89 mutate)" to "247 operations (140 query + 107 mutate)" — reflects actual OPERATIONS array size (which had drifted from the comment).

### VERB-STANDARDS compliance
- `discover`, `search`: `search` is listed as deprecated verb (should be `find`), but these ops are already wired in code. Noted but not changed per instructions.
- `critical-path`, `blocking`, `orphans`: These are noun-form analysis ops, not verb violations. Compliant.

## Validation
- `grep "6.9 nexus"` result: `### 6.9 nexus (31 operations)`
- `grep -c "critical-path|blocking|orphans"` result: 6 (>= 3, pass)
- VERB-STANDARDS compliance: `nexus.search` uses deprecated `search` verb (should be `find`), but this is an existing code decision, not introduced by this task.

## Note on counts
The registry OPERATIONS array contains 247 entries (140q + 107m) per actual count, significantly more than the header's previous claim of 207. The Constitution summary table tracks a subset view (218 after this update). Multiple domains have drifted from their Constitution counts; only the nexus row was updated in this task per scope.

## Status: COMPLETE
