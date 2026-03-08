# T5671 Gauntlet Report: Sticky Domain

**Agent**: gauntlet-nexus-sticky
**Date**: 2026-03-08
**Test environment**: `/tmp/cleo-gauntlet-nexus`

## Registry vs Constitution Alignment

Constitution defines **6 operations** (2 query + 4 mutate). Registry matches exactly.

| Gateway | Operation | Constitution | Registry | CLI Command | Status |
|---------|-----------|:---:|:---:|-------------|--------|
| query | list | Y | Y | `sticky list` | PASS |
| query | show | Y | Y | `sticky show` | PASS |
| mutate | add | Y | Y | `sticky add` | PASS |
| mutate | convert | Y | Y | `sticky convert` | PASS |
| mutate | archive | Y | Y | `sticky archive` | PASS |
| mutate | purge | Y | Y | `sticky purge` | PASS |

## A) Functional Testing

### Full Lifecycle Test

1. **add** SN-001 ("First sticky note") -- PASS, returns `{id, content, createdAt, tags, status, color, priority, sourceType}`
2. **add** SN-002 with `--tag important` -- PASS, tags array populated correctly
3. **list** -- PASS, returns both stickies with `total`, `filtered`, pagination metadata
4. **show** SN-001 -- PASS, returns full sticky detail
5. **archive** SN-001 -- PASS, status changes to `"archived"`
6. **convert** SN-002 `--to-task --title "Converted"` -- PASS, returns `{taskId: "T002"}`
7. **add** SN-003 ("To be purged") -- PASS
8. **purge** SN-003 -- PASS, returns purged sticky data
9. **add** SN-003 (reused ID) + **convert --to-memory** -- PASS, returns `{memoryId: "O-mmi8njen-0"}`
10. **list** (empty) -- Returns `{stickies: [], total: 0}` with exit code 100 (special condition: empty result)

### Error Cases

| Test | Input | Result | Verdict |
|------|-------|--------|---------|
| show nonexistent | `SN-999` | `{success: false, code: 4, "not found"}` | PASS |
| purge nonexistent | `SN-999` | `{success: false, code: 4, "not found"}` | PASS |
| convert nonexistent | `SN-999 --to-task` | `{success: false, code: 4, "not found"}` | PASS |
| add missing content | `(no args)` | Commander: `"missing required argument 'content'"` | PASS |
| convert wrong flag | `--to task` | Commander: `"unknown option '--to'"` | PASS |

## B) Usability

### Help Discoverability
- `sticky --help` shows all subcommands with aliases (`add|jot`, `list|ls`)
- `sticky convert --help` shows all conversion flags (`--to-task`, `--to-memory`, `--title`, `--type`, `--epic`)
- Command aliased as `note` (`cleo note` = `cleo sticky`)

### Error Messages
- Not-found errors use exit code 4 with clear message including the sticky ID
- Commander handles missing args/unknown options at the CLI framework level
- Empty list returns exit code 100 (documented special condition, not an error)

### Convert UX
- Two distinct flags: `--to-task` and `--to-memory` (not a single `--to <type>`)
- Convert to task requires `--title`
- Convert to memory accepts `--type` (pattern|learning|decision|observation, default: observation)

## C) Consistency

- All 6 ops in registry match Constitution exactly
- LAFS envelope present on all responses
- `_meta.operation` uses correct `sticky.*` naming
- All ops are tier 1 (correct per Constitution)
- `convert` is a documented VERB-STANDARDS exception (no canonical verb equivalent for type conversion)
- Pagination metadata included in list responses

## Issues Found

| Severity | Issue | Details |
|----------|-------|---------|
| INFO | Exit code 100 for empty list | `sticky list` returns exit code 100 when no stickies exist. This is a documented special condition (100+ range), not an error. Consistent with CLEO exit code spec. |
| LOW | Convert flag naming | Uses `--to-task`/`--to-memory` rather than `--to task`/`--to memory`. This is actually fine for boolean flags but differs from what users might initially guess (as shown by the `--to task` error during testing). |

## Verdict: PASS

All 6 operations work correctly through the CLI. Full lifecycle tested (add -> list -> show -> archive -> convert -> purge). Error handling is consistent with exit code 4 for not-found. Registry and Constitution are perfectly aligned.
