# T487 Final Wave (Wave 5 + 6) — Commander-Shim Deletion

## Files Deleted

- `packages/cleo/src/cli/commander-shim.ts` — shim class, removed entirely
- `packages/cleo/src/cli/help-generator.ts` — dead code (applyParamDefsToCommand + buildOperationHelp, 0 native citty callers)
- `packages/cleo/src/cli/__tests__/help-generator.test.ts` — 21 tests for deleted module

## Files Rewritten

- `packages/cleo/src/cli/help-renderer.ts` — `buildAliasMap()` now accepts `Record<string, CommandDef>` (identity-based alias detection); `renderGroupedHelp()` and `createCustomShowUsage()` now accept the same type; `NATIVE_COMMAND_DESCS` constant removed (descriptions read from each CommandDef's `meta.description`); `ShimCommand` import removed
- `packages/cleo/src/cli/index.ts` — `ShimCommand` import removed, `rootShim` instance removed, `buildAliasMap(subCommands)` and `createCustomShowUsage(CLI_VERSION, subCommands, aliasMap)` now pass native `subCommands` record directly
- `packages/cleo/src/cli/__tests__/startup-migration.test.ts` — ShimCommand mock removed; added new `CLI subCommands wiring` describe block that asserts `show`, `add`, `complete`, `find`, `done`, `rm` are all present in the citty `defineCommand` call

## Stale Comments Stripped (5 files)

- `packages/cleo/src/cli/commands/cant.ts` — removed "Migrated from commander-shim" line
- `packages/cleo/src/cli/commands/check.ts` — removed "Migrated from commander-shim" line
- `packages/cleo/src/cli/commands/claim.ts` — removed "Migrated from commander-shim" line
- `packages/cleo/src/cli/commands/complexity.ts` — removed "Migrated from commander-shim" line
- `packages/cleo/src/cli/commands/backup.ts` — rephrased comment that referenced "previous commander-shim implementation"

## Gate Results

| Gate | Result |
|------|--------|
| `pnpm biome check --write packages/cleo/src/cli/` | Fixed 16 files, 0 errors |
| `pnpm biome ci packages/cleo` | **0 errors** (baseline was 15) |
| `pnpm run build` (root) | Exit 0 |
| `pnpm --filter @cleocode/cleo run test` | **1408 passed, 2 skipped** (delta: -21 = deleted help-generator tests, zero regressions) |
| `grep -rn "commander-shim\|ShimCommand" packages/ --include="*.ts" (src only)` | 1 comment-only hit in restore-finalize.test.ts line 100 — prose, not import/usage |
| `test ! -f packages/cleo/src/cli/commander-shim.ts` | DELETED |

## Smoke Test Outputs

### `node dist/cli/index.js --help` (NO_COLOR=1, first 4 groups)
```
CLEO V2 - Task management for AI coding agents (cleo v2026.4.76)

USAGE cleo <command> [OPTIONS]

TASK MANAGEMENT
  add                 Create a new task (requires active session)
  show                Show full task details by ID ...
  list (ls)           List tasks with optional filters
  complete (done)     Mark a task as completed ...
  labels (tags)       List all labels with counts ...
```
Aliases render correctly (identity-based detection working).

### `node dist/cli/index.js show --help`
```
Show full task details by ID (cleo show v2026.4.76)
USAGE cleo show [OPTIONS] <TASKID>
ARGUMENTS / OPTIONS rendered correctly
```

### `node dist/cli/index.js show T487 --json`
```json
{"success":true,"data":{"task":{"id":"T487",...}}}
```
Native citty command executes and returns LAFS envelope.
