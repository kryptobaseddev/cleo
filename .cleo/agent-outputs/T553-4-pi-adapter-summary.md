# T553-4: Pi Adapter with CAAMP Hook Coverage

**Date**: 2026-04-13
**Commit**: d4c0dc5a
**Status**: complete

## Summary

Pi was CAAMP's first-class primary harness (ADR-035) but had 0% CAAMP hook coverage. This task adds the full Pi adapter with 11/16 canonical event mappings, registers Pi in the adapter discovery system, adds Pi to hook-mappings.json, and extends `session_shutdown` in `cleo-cant-bridge.ts` to trigger memory bridge refresh and backup.

## What Was Built

### 1. Pi Adapter (`packages/adapters/src/providers/pi/`)

Five new files following exact patterns from existing adapters (claude-code, opencode):

| File | Class | Purpose |
|------|-------|---------|
| `adapter.ts` | `PiAdapter` | `CLEOProviderAdapter` — 11/16 hook events, spawn, install |
| `hooks.ts` | `PiHookProvider` | `AdapterHookProvider` — maps Pi snake_case → CAAMP PascalCase |
| `install.ts` | `PiInstallProvider` | `AdapterInstallProvider` — AGENTS.md injection (project + global) |
| `spawn.ts` | `PiSpawnProvider` | `AdapterSpawnProvider` — spawns via `pi` CLI or `PI_CLI_PATH` |
| `index.ts` | — | Barrel export + `createAdapter()` factory |
| `manifest.json` | — | Detection patterns (env vars, file, CLI) |

### 2. hook-mappings.json — Pi Entry Added

```
"pi": {
  "hookSystem": "extension",
  "hookConfigPath": "$PI_CODING_AGENT_DIR/extensions/",
  "hookFormat": "typescript",
  "nativeEventCatalog": "pi",
  "mappings": {
    SessionStart        → session_start
    SessionEnd          → session_shutdown
    PromptSubmit        → input
    Notification        → turn_end
    PreToolUse          → tool_call
    PostToolUse         → tool_result
    SubagentStart       → before_agent_start
    SubagentStop        → agent_end
    PreModel            → before_provider_request
    PreCompact          → context
    (+ 6 unsupported: ResponseComplete, PostToolUseFailure, PermissionRequest, PostModel, PostCompact, ConfigChange)
  }
}
```

### 3. Provider Discovery — Pi Registered

`packages/adapters/src/registry.ts`:
- Added `'pi'` to `PROVIDER_IDS` constant
- Added lazy factory in `discoverProviders()` for `PiAdapter`

### 4. session_shutdown → Memory Refresh + Backup

`packages/cleo-os/extensions/cleo-cant-bridge.ts`:
- Added `execFile` + `promisify` imports
- Extended `session_shutdown` handler to fire (best-effort, non-blocking):
  - `cleo refresh-memory` — regenerates `.cleo/memory-bridge.md`
  - `cleo backup add` — snapshots `tasks.db` and `brain.db`

## Event Coverage

Pi supports 11 of 16 CAAMP canonical events (69% — highest among non-claude-code providers):

| Canonical | Pi Native | Notes |
|-----------|-----------|-------|
| SessionStart | session_start | |
| SessionEnd | session_shutdown | Also triggers memory refresh + backup |
| PromptSubmit | input | |
| Notification | turn_end | Turn complete proxy |
| PreToolUse | tool_call | Also tool_execution_start |
| PostToolUse | tool_result | Also tool_execution_end |
| SubagentStart | before_agent_start | |
| SubagentStop | agent_end | |
| PreModel | before_provider_request | |
| PreCompact | context | Context assembly proxy |
| (unsupported) | — | ResponseComplete, PostToolUseFailure, PermissionRequest, PostModel, PostCompact, ConfigChange |

## Detection Hierarchy

1. `PI_CLI_PATH` env var set
2. `PI_CODING_AGENT_DIR` env var set
3. `PI_HOME` env var set
4. `.pi/settings.json` file in project
5. `pi` CLI available in PATH

## Quality Gates

- biome check: 0 fixes needed
- build: success (`pnpm run build`)
- tests: 396 passed, 0 new failures (`pnpm run test`)
- commit: d4c0dc5a (pushed to main)
