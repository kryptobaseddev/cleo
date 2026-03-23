# T044: CLI Commands for Reasoning Operations

**Status**: complete
**Task**: T044
**Epic**: T038 (Documentation-Implementation Drift Remediation)
**Date**: 2026-03-22

## Summary

Implemented `cleo reason` command group providing CLI parity for reasoning
and intelligence operations previously available only via MCP.

## Files Created

- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/reason.ts`
  New command registration file for the `reason` subcommand group.

## Files Modified

- `/mnt/projects/cleocode/packages/cleo/src/cli/index.ts`
  Added import and registration of `registerReasonCommand`.

- `/mnt/projects/cleocode/packages/core/src/agents/index.ts`
  Pre-existing: `checkAgentHealth` was already aliased to `findStaleAgentRows`
  to resolve duplicate export. File was correct; no changes needed from T044.

- `/mnt/projects/cleocode/packages/core/src/agents/health-monitor.ts`
  Fixed pre-existing build error: unused `cutoff` variable in `detectStaleAgents`.

- `/mnt/projects/cleocode/packages/core/src/intelligence/impact.ts`
  Fixed pre-existing build error: unused `ImpactedTask` and `ImpactReport`
  imports removed from type-import block.

## Commands Implemented

| Command | Dispatch | Parameters | Description |
|---------|----------|-----------|-------------|
| `cleo reason why <taskId>` | `query memory reason.why` | `taskId` | Causal trace through dependency chains |
| `cleo reason similar <taskId>` | `query memory reason.similar` | `entryId` (accepts taskId) | Find semantically similar BRAIN entries |
| `cleo reason impact <taskId>` | `query tasks depends` | `taskId, action: impact, depth` | Downstream dependency impact analysis |
| `cleo reason timeline <taskId>` | `query tasks history` | `taskId, limit` | Task history and audit trail |

## Design Decisions

- `reason why` maps to `memory.reason.why` — the existing dispatch operation for
  causal dependency chain tracing through brain.db.

- `reason similar` maps to `memory.reason.similar` with `entryId` param. The CLI
  accepts the argument as `<taskId>` for UX consistency but passes it as `entryId`
  to the dispatch layer (which accepts any BRAIN entry ID, including task IDs).

- `reason impact` reuses the existing `tasks.depends` operation with
  `action: 'impact'` — the same backend that powers `deps impact`. This avoids
  duplication and correctly delivers downstream reverse dependency analysis.
  T043 tracks a future enhancement for free-text change description impact
  prediction (`predictImpact`).

- `reason timeline` maps to `tasks.history` with `taskId` — provides per-task
  audit history (start/stop events, updates).

## Quality Gates

- `pnpm biome check --write`: no issues
- `pnpm run build`: succeeded (warnings are pre-existing, unrelated to T044)
- `pnpm run test`: 274 test files passed, 4821 tests passed, 5 skipped, 0 failed

## Verification

```
$ node packages/cleo/dist/cli/index.js reason --help
Reasoning and intelligence operations (why, similar, impact, timeline)

USAGE cleo reason why|similar|impact|timeline

COMMANDS
     why    Explain why a task exists via causal trace through dependency chains
 similar    Find BRAIN entries semantically similar to a task or observation ID
  impact    Show downstream tasks affected by changes to the given task
timeline    Show history and audit trail for a task
```
