# T352: regenerators.ts — dry-run JSON file generators

**Status**: complete
**Commit**: 47f0fc09
**Branch**: worktree-agent-ab635101

## Files Delivered

1. `packages/core/src/store/regenerators.ts` — 4 exported functions
2. `packages/core/src/store/__tests__/regenerators.test.ts` — 22 tests

## Summary

Implemented pure dry-run generators for the three CLEO runtime JSON files. Each function returns the same content that `cleo init` would write without touching the filesystem.

### Functions

- `regenerateConfigJson(projectRoot)` — mirrors `createDefaultConfig()` + contributor block detection
- `regenerateProjectInfoJson(projectRoot)` — mirrors `ensureProjectInfo()` logic; uses `generateProjectHash`, `getCleoVersion`, `getSchemaVersion`, and `SQLITE_SCHEMA_VERSION` (mirrored constant to avoid sqlite.ts side effects)
- `regenerateProjectContextJson(projectRoot)` — calls `detectProjectType()` directly
- `regenerateAllJson(projectRoot)` — convenience wrapper returning all three

### Key design decisions

- `SQLITE_SCHEMA_VERSION` mirrored as a local constant (value `'2.0.0'`) to avoid importing sqlite.ts which bootstraps `node:sqlite` at module load time
- `ProjectContext` type used directly for `regenerateProjectContextJson` return type to avoid `as Record<string, unknown>` double-cast
- Drift risks documented in TSDoc on the module header and each function

## Gates

- biome: clean (0 errors, 0 warnings)
- tsc: 0 errors on regenerators.ts (pre-existing errors in other files unrelated)
- tests: 22/22 pass
- git: exactly 2 files changed
