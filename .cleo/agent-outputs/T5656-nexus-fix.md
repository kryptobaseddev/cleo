# T5656: Remove projects-registry.json and Wire nexus.db as Canonical Cross-Project Store

**Task**: T5656
**Epic**: T5562
**Date**: 2026-03-08
**Status**: complete

---

## Summary

Audited all `projects-registry.json` references in `src/`. Confirmed `src/core/nexus/registry.ts` already uses nexus.db (SQLite via Drizzle) as the canonical store — `readRegistry()` reads from nexus.db, not JSON. Removed the dead `src/store/project-registry.ts` file (no imports), cleaned vestigial `NEXUS_REGISTRY_FILE` env var from 6 test files, removed `getRegistryPath` from the public nexus index, purged 2211 garbage test entries from nexus.db, registered 2 real projects (ProjectBoss, execdash), and renamed the JSON file to `.migrated`.

## What Was Found

### Code references to projects-registry.json

| File | Reference type | Action |
|------|---------------|--------|
| `src/store/project-registry.ts` | Dead code — full JSON-backed registry (not imported by anything) | Deleted |
| `src/core/nexus/registry.ts` | `getRegistryPath()` — `@deprecated`, only used by migrate-json-to-sqlite | Retained (needed for migration logic) |
| `src/core/nexus/registry.ts` | `readRegistry()` — reads from **nexus.db**, not JSON | No change needed |
| `src/core/nexus/migrate-json-to-sqlite.ts` | Migration utility, reads JSON and writes to nexus.db | Retained |
| `src/core/nexus/index.ts` | Exported `getRegistryPath` (deprecated symbol) | Removed from public index |
| 6 test files | `NEXUS_REGISTRY_FILE` env var (vestigial — unused by actual test operations) | Removed |

### Key finding: no JSON fallback in active code

The `readRegistry()` function in `registry.ts` — the one called by all consumers — already reads exclusively from nexus.db. There was no active JSON fallback path. The `projects-registry.json` file was only consulted during `nexusInit()` migration (first-run only, when nexus.db is empty).

### NEXUS_REGISTRY_FILE env var

All 6 test files set `NEXUS_REGISTRY_FILE` but none of the test operations actually used it — tests register projects via `nexusRegister()` directly (which hits nexus.db via `CLEO_HOME`). The var only fed `getRegistryPath()` which is only called by `migrateJsonToSqlite()`, which never runs during tests (nexus.db is never empty in tests since projects are registered directly). These lines were vestigial.

## Garbage Entries Removed from nexus.db

**Location**: `~/.local/share/cleo/nexus.db` (Linux XDG data path; CLEO_HOME defaults to this, not `~/.cleo/`)

Before cleanup:
- Total: 2212 entries
- Real projects: 1 (`claude-todo`)
- Garbage (`.temp/` and `/tmp/`): 2211 entries from E2E test runs

After cleanup:
- Total: 3 entries
- `claude-todo` → `/mnt/projects/claude-todo`
- `ProjectBoss` → `/mnt/projects/ProjectBoss` (registered from JSON)
- `execdash` → `/mnt/projects/execdash` (registered from JSON)

Cleanup method: direct sqlite3 DELETE via Python on `~/.local/share/cleo/nexus.db` after WAL checkpoint.

## JSON File Disposition

`~/.cleo/projects-registry.json` renamed to `~/.cleo/projects-registry.json.migrated`. This is separate from `~/.local/share/cleo/` (the actual CLEO data home on this Linux system). The JSON file was at the old Bash-era `~/.cleo/` location.

## Files Changed

- **Deleted**: `src/store/project-registry.ts` (dead code, 253 lines, zero imports)
- **Modified**: `src/core/nexus/index.ts` — removed `getRegistryPath` from public exports
- **Modified**: `src/core/nexus/__tests__/registry.test.ts` — removed vestigial `NEXUS_REGISTRY_FILE`
- **Modified**: `src/core/nexus/__tests__/reconcile.test.ts` — removed vestigial `NEXUS_REGISTRY_FILE`
- **Modified**: `src/core/nexus/__tests__/query.test.ts` — removed vestigial `NEXUS_REGISTRY_FILE`
- **Modified**: `src/core/nexus/__tests__/permissions.test.ts` — removed vestigial `NEXUS_REGISTRY_FILE`
- **Modified**: `src/core/nexus/__tests__/deps.test.ts` — removed vestigial `NEXUS_REGISTRY_FILE`
- **Modified**: `src/cli/commands/__tests__/nexus.test.ts` — removed vestigial `NEXUS_REGISTRY_FILE`

## Test Results

- `src/core/nexus/__tests__/` — 80/80 pass
- `src/cli/commands/__tests__/nexus.test.ts` — 11/11 pass
- TypeScript: zero errors (`npx tsc --noEmit`)

## Remaining Notes / Caveats

1. `src/core/nexus/migrate-json-to-sqlite.ts` and `registry.ts::getRegistryPath()` are retained. They provide the JSON-to-SQLite one-time migration path for users who haven't yet run `nexus init`. They can be removed in a future cleanup task once the migration window is considered closed.

2. `NEXUS_REGISTRY_FILE` env var is no longer exported in the index. Any code that set it was doing so unnecessarily (only affected the deprecated migration path). If users set it in their environment, it remains harmless.

3. The `~/.cleo/` directory still exists with other files (config, logs, backups, etc.) — only the JSON registry file was marked `.migrated`.

## References

- Task: T5656
- Parent: T5562 (nexus domain review)
- Blocks: T5563 (nexus inventory)
- Commit: `fix(nexus): remove projects-registry.json fallback, wire nexus.db canonical (T5656)`
