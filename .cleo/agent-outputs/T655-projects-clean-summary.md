# T655 — CLI: `cleo nexus projects clean` — Implementation Summary

**Task**: T655 (subtask of T654)
**Status**: complete
**Date**: 2026-04-15

## What Was Built

Added `cleo nexus projects clean` as a new subcommand under `nexus projects`,
immediately after the `scan` subcommand in
`packages/cleo/src/cli/commands/nexus.ts`.

### Flags

| Flag | Type | Purpose |
|------|------|---------|
| `--dry-run` | boolean | List matches without deleting (does NOT default to true) |
| `--pattern <regex>` | string | JS regex matched against project_path |
| `--include-temp` | boolean | Preset: match `(^|/)\.temp(/|$)` |
| `--include-tests` | boolean | Preset: match `(^|/)(tmp\|test\|fixture\|scratch\|sandbox)(/|$)` |
| `--unhealthy` | boolean | Match rows where health_status='unhealthy' |
| `--never-indexed` | boolean | Match rows where last_indexed IS NULL |
| `--yes` | boolean | Skip confirmation prompt |
| `--json` | boolean | Output LAFS envelope JSON |

### Safety Rails

- Exits code 6 with `E_NO_CRITERIA` error if no filter criteria given
- Always shows count + first 10 sample paths before deletion
- Deletion runs in a single Drizzle ORM call (atomic at DB layer)
- Audit log entry written with action='projects.clean' and details_json

### Smoke Test Result

```
[nexus] Clean preview — 24762 project(s) of 24816 total match criteria:
  /home/keatonhoskins/.temp/cleo-test-bzZCyG
  ... and 24752 more
[nexus] Dry-run — 24762 project(s) would be purged. Rerun without --dry-run to delete.
```

## Files Changed

- `packages/cleo/src/cli/commands/nexus.ts` — added `clean` subcommand (~260 lines)
- `packages/cleo/src/cli/__tests__/nexus-projects-clean.test.ts` — 24 tests (new)
- `vitest.config.ts` — added `@cleocode/core/store/nexus-sqlite` and
  `@cleocode/core/store/nexus-schema` aliases so tests can mock dynamic imports
  from the production code (mirrors existing `@cleocode/core/internal` pattern)

## Quality Gates

- biome: clean (no fixes applied on 980 files)
- tsc build: passes
- tests: 73 files, 1248 passed, 0 failed, 2 skipped
