# T5719: Rewire CLI command imports from src/core/ to @cleocode/core

**Task**: T5719
**Epic**: T5701
**Date**: 2026-03-18
**Status**: complete

---

## Summary

All 28 CLI source files (26 source + 2 test files) have been rewired from relative `../../core/` imports to the `@cleocode/core` package alias. Four missing flat exports were added to `src/core/index.ts` to cover imports that were not yet exposed at the barrel level. TSC reports zero new errors and `npm run build` exits with "Build complete."

## Changes Made

### src/core/index.ts — Added Missing Exports

Added the following flat re-exports (T5719 section at end of file):

| Export | Source module |
|--------|--------------|
| `checkStorageMigration`, `PreflightResult` | `./system/storage-preflight.js` |
| `migrateClaudeMem`, `ClaudeMemMigrationOptions`, `ClaudeMemMigrationResult` | `./memory/claude-mem-migration.js` |
| `detectEnvMode`, `generateMcpServerEntry`, `getMcpServerName`, `McpEnvMode` | `./mcp/index.js` |
| `measureTokenExchange` | `./metrics/token-service.js` |
| `addRemote`, `getCurrentBranch`, `listRemotes`, `pull`, `push`, `removeRemote` | `./remote/index.js` |
| `getRemoteSyncStatus` (aliased from `getSyncStatus`) | `./remote/index.js` |
| `clearOtelData`, `getOtelSessions`, `getOtelSpawns`, `getOtelStatus`, `getOtelSummary`, `getRealTokenUsage` | `./otel/index.js` |
| `checkRootGitignore` | `./validation/doctor/checks.js` |

**Note on naming conflict**: `remote/index.ts` exports a `getSyncStatus` function that conflicts with the already-exported `getSyncStatus` from `admin/sync.js`. The remote function is exported as `getRemoteSyncStatus`. `remote.ts` imports it with a local alias: `getRemoteSyncStatus as getSyncStatus`.

### CLI Files Rewired (26 source files)

| File | Imports changed |
|------|----------------|
| `src/cli/logger-bootstrap.ts` | `LoggerConfig`, `initLogger`, `getProjectInfoSync` |
| `src/cli/index.ts` | `loadConfig`, `getNodeUpgradeInstructions`, `getNodeVersionInfo`, `MINIMUM_NODE_MAJOR`, `checkStorageMigration` |
| `src/cli/renderers/index.ts` | `FormatOptions`, `formatSuccess` |
| `src/cli/renderers/error.ts` | `getErrorDefinition`, `CleoError` |
| `src/cli/commands/init.ts` | `CleoError`, `InitOptions`, `initProject`, `formatError` |
| `src/cli/commands/migrate-claude-mem.ts` | `migrateClaudeMem`, `getProjectRoot` |
| `src/cli/commands/config.ts` | `loadConfig`, `CleoError`, `formatError` |
| `src/cli/commands/restore.ts` | `CleoError`, `formatError` |
| `src/cli/commands/install-global.ts` | `getAgentsHome`, `getCleoHome` |
| `src/cli/commands/checkpoint.ts` | `CleoError`, `formatError`, `getCleoDir` |
| `src/cli/commands/self-update.ts` | `CleoError`, `formatError`, `getCleoHome`, `getRuntimeDiagnostics`, `checkStorageMigration`, `runUpgrade` |
| `src/cli/commands/mcp-install.ts` | `CleoError`, `detectEnvMode`, `generateMcpServerEntry`, `getMcpServerName`, `formatError` |
| `src/cli/commands/list.ts` | `createPage` |
| `src/cli/commands/sticky.ts` | `CleoError`, `formatError` |
| `src/cli/commands/remote.ts` | `CleoError`, `formatError`, `addRemote`, `getRemoteSyncStatus as getSyncStatus`, `listRemotes`, `pull`, `push`, `removeRemote` |
| `src/cli/commands/env.ts` | `getRuntimeDiagnostics` |
| `src/cli/commands/otel.ts` | `CleoError`, `clearOtelData`, `getOtelSessions`, `getOtelSpawns`, `getOtelStatus`, `getOtelSummary`, `getRealTokenUsage`, `formatError` |
| `src/cli/commands/extract.ts` | `CleoError`, `formatError`, `getCleoDir` |
| `src/cli/commands/docs.ts` | `CleoError`, `formatError`, `getAgentOutputsAbsolute` |
| `src/cli/commands/generate-changelog.ts` | `CleoError`, `formatError`, `getConfigPath`, `getProjectRoot` |
| `src/cli/commands/observe.ts` | `getProjectRoot` |
| `src/cli/commands/refresh-memory.ts` | `getProjectRoot` |
| `src/cli/commands/find.ts` | `createPage` |
| `src/cli/commands/upgrade.ts` | `CleoError`, `formatError`, `runUpgrade` |
| `src/cli/commands/web.ts` | `CleoError`, `formatError`, `getCleoHome` |
| `src/cli/commands/token.ts` | `measureTokenExchange`, `recordTokenExchange` |

### Test Files Rewired (2 files)

Neither test file uses `vi.mock` targeting specific submodule paths, so both were rewired:

| File | Import changed |
|------|---------------|
| `src/cli/commands/__tests__/nexus.test.ts` | `nexusGetProject`, `nexusInit`, `nexusList`, `nexusRegister` |
| `src/cli/commands/__tests__/init-gitignore.test.ts` | `checkRootGitignore` |

## Verification Results

| Check | Result |
|-------|--------|
| `grep -r "from.*\/core\/" src/cli/ --include="*.ts" -l` | 0 files |
| `npx tsc --noEmit` | 0 new errors (2 pre-existing in `src/mcp/index.ts`) |
| `npm run build` | "Build complete." |

## References

- Related tasks: T5718 (dispatch layer rewire), T5701 (epic), T5716
- Pattern: `@cleocode/core` resolves to `src/core/index.ts` via tsconfig paths
