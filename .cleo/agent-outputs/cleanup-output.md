# Phase 4: Legacy Cleanup Output

**Task**: #12
**Status**: Complete
**Date**: 2026-03-15

## Deleted Files

### .claude-plugin/ directory (11 files)
- `.claude-plugin/hooks/scripts/session-start.sh`
- `.claude-plugin/hooks/scripts/observe.sh`
- `.claude-plugin/hooks/scripts/stop.sh`
- `.claude-plugin/hooks/scripts/brain-hook.sh`
- `.claude-plugin/hooks/scripts/brain-start.sh`
- `.claude-plugin/hooks/scripts/brain-context.sh`
- `.claude-plugin/hooks/scripts/brain-worker.cjs`
- `.claude-plugin/hooks/hooks.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/README.md`
- `.claude-plugin/CLAUDE.md`

### Old adapter files (4 files)
- `src/core/install/claude-plugin.ts` (replaced by `packages/adapters/claude-code/src/install.ts`)
- `src/core/spawn/adapters/claude-code-adapter.ts` (replaced by `packages/adapters/claude-code/src/spawn.ts`)
- `src/core/spawn/adapters/opencode-adapter.ts` (replaced by `packages/adapters/opencode/src/spawn.ts`)
- `src/core/spawn/adapters/__tests__/opencode-adapter.test.ts` (functionality tested in adapter packages)

### Removed empty directories
- `src/core/install/`
- `src/core/spawn/adapters/`
- `src/core/spawn/adapters/__tests__/`

## Refactored Files

### `src/core/spawn/adapter-registry.ts`
- `initializeDefaultAdapters()` now dynamically imports from `@cleocode/adapter-claude-code` and `@cleocode/adapter-opencode` adapter packages
- Added `bridgeSpawnAdapter()` function that maps between `AdapterSpawnProvider` (contracts) and `CLEOSpawnAdapter` (internal types)
- Import failures are caught gracefully (adapter packages may not be installed)

### `src/cli/commands/install-global.ts`
- Step 6 rewritten: replaced `installClaudePlugin()` import with `AdapterManager`-based discovery and installation
- Now discovers all available adapters, detects active providers, and calls `adapter.install.install()` for each

### `src/core/spawn/__tests__/adapter-registry.test.ts`
- Rewritten to test `SpawnAdapterRegistry` class directly with mock adapters
- Tests for `initializeDefaultAdapters` verify graceful handling when packages are unavailable
- Tests verify idempotency of double-initialization

### `package.json`
- Removed `.claude-plugin` from the `files` array

### Comment updates (historical references cleaned)
- `packages/shared/src/observation-formatter.ts` — updated origin comment
- `packages/shared/src/hook-dispatch.ts` — updated origin comment
- `packages/adapters/claude-code/src/hooks.ts` — removed stale directory references
- `README.md` — updated plugin architecture link to point to `packages/adapters/claude-code/`

## Verification

- **Build**: `npm run build` passes clean
- **Tests**: 4864 passed, 7 skipped, 2 failed (both pre-existing failures unrelated to this change)
- **TODO scan**: Zero TODO comments found in src/ or packages/
- **Unused `_` imports**: Only pre-existing `_DatabaseSyncType` aliases found (all actively used for node:sqlite conditional import pattern)
- **No remaining references** to deleted files in source code
