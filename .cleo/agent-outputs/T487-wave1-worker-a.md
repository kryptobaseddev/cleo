# T487 Wave 1 Worker A — Commander-Shim Removal (Sub-tier A)

**Date**: 2026-04-16
**Session**: ses_20260416230443_5f23a3
**Status**: complete

## Files Migrated

### 1. `packages/cleo/src/cli/commands/current.ts`
- **Before**: `export function registerCurrentCommand(program: Command): void` (shim pattern)
- **After**: `export const currentCommand = defineCommand({...})` (native citty)
- **Dispatch**: `dispatchFromCli('query', 'tasks', 'current', {}, { command: 'current' })` — unchanged

### 2. `packages/cleo/src/cli/commands/detect.ts`
- **Before**: `export function registerDetectCommand(program: Command): void`
- **After**: `export const detectCommand = defineCommand({...})`
- **Dispatch**: `dispatchFromCli('mutate', 'admin', 'detect', {}, { command: 'detect', operation: 'admin.detect' })` — unchanged

### 3. `packages/cleo/src/cli/commands/plan.ts`
- **Before**: `export function registerPlanCommand(program: Command): void`
- **After**: `export const planCommand = defineCommand({...})`
- **Dispatch**: `dispatchFromCli('query', 'tasks', 'plan', {}, { command: 'plan', operation: 'tasks.plan' })` — unchanged

### 4. `packages/cleo/src/cli/commands/refresh-memory.ts`
- **Before**: `export function registerRefreshMemoryCommand(program: Command): void`
- **After**: `export const refreshMemoryCommand = defineCommand({...})`
- **Logic**: Direct call to `getProjectRoot()` + `writeMemoryBridge()` — preserved exactly

### 5. `packages/cleo/src/cli/commands/stop.ts`
- **Before**: `export function registerStopCommand(program: Command): void`
- **After**: `export const stopCommand = defineCommand({...})`
- **Dispatch**: `dispatchFromCli('mutate', 'tasks', 'stop', {}, { command: 'stop' })` — unchanged

### 6. `packages/cleo/src/cli/commands/analyze.ts`
- **Before**: `export function registerAnalyzeCommand(program: Command): void` with `--auto-start` option (unused in dispatch)
- **After**: `export const analyzeCommand = defineCommand({...})` — args omitted since auto-start was not forwarded to dispatch in the original either
- **Dispatch**: `dispatchFromCli('query', 'tasks', 'analyze', {}, { command: 'analyze' })` — unchanged

## index.ts Changes

- Replaced 6 `import { registerXxxCommand }` with `import { xxxCommand }` for all 6 commands
- Removed 6 `registerXxxCommand(rootShim)` shim registration calls
- Added 6 `subCommands['xxx'] = xxxCommand` entries in the native subCommands block

```
subCommands['current'] = currentCommand;
subCommands['detect'] = detectCommand;
subCommands['plan'] = planCommand;
subCommands['refresh-memory'] = refreshMemoryCommand;
subCommands['stop'] = stopCommand;
subCommands['analyze'] = analyzeCommand;
```

## help-renderer.ts Changes

Added 6 entries to `NATIVE_COMMAND_DESCS`:
- `current`: description from original
- `detect`: description from original
- `plan`: description from original
- `refresh-memory`: description from original
- `stop`: description from original
- `analyze`: description from original

## startup-migration.test.ts Changes

Updated 6 vi.mock entries to match new native exports:
- `{ registerAnalyzeCommand: vi.fn() }` → `{ analyzeCommand: {} }`
- `{ registerCurrentCommand: vi.fn() }` → `{ currentCommand: {} }`
- `{ registerDetectCommand: vi.fn() }` → `{ detectCommand: {} }`
- `{ registerPlanCommand: vi.fn() }` → `{ planCommand: {} }`
- `{ registerRefreshMemoryCommand: vi.fn() }` → `{ refreshMemoryCommand: {} }`
- `{ registerStopCommand: vi.fn() }` → `{ stopCommand: {} }`

Also updated mocks for other pre-existing migrated commands (blockers, checkpoint, complete, delete, exists, find, generate-changelog, grade, list, map, next, ops, promote, reparent, roadmap, show, start, validate, conduit, add-batch, cancel) to match their already-migrated native exports.

## Quality Gate Results

```
pnpm biome check --write [6 files + index + help-renderer]: PASS (1 import fix in refresh-memory.ts)
pnpm biome ci .: 7 pre-existing errors in unrelated files (unchanged from baseline)
pnpm --filter @cleocode/cleo run build: EXIT 0 (clean)
pnpm --filter @cleocode/cleo run test: 83 passed, 1430 tests, 0 failures, 2 skipped
```

## Smoke Tests

```
cleo current: {"success":true,"data":{"currentTask":null,"currentPhase":null},...}
cleo analyze: {"success":true,"data":{"recommended":{...}},...}
cleo stop: {"success":true,"data":{"cleared":true,"previousTask":null},...}
cleo --help: shows 'stop' and 'current' with correct descriptions in TASK MANAGEMENT group
```

## Notes

- The file revert problem: biome's `--write` flag was causing tool-level read cache to serve stale content; bash-direct writes were used to persist all 6 command files reliably.
- `analyze.ts` args were omitted (no `--auto-start` in defineCommand) since the original shim also never forwarded this flag to dispatch — behavior identical.
- Pre-existing type errors in index.ts (39 total) are from other Wave 1 workers' partial migrations and do not affect our 6 commands. These existed before our session.
