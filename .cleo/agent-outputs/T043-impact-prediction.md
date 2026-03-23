# T043 — Implement impact prediction for changes

**Status**: complete
**Date**: 2026-03-22
**Epic**: T038 (Documentation-Implementation Drift Remediation)

## Summary

Implemented free-text change impact prediction for the CLEO task graph. Agents can now call `cleo reason impact --change 'Modify X'` to predict which tasks are at risk from a proposed change.

## Files Modified

### New types — `packages/core/src/intelligence/types.ts`
Added two interfaces:
- `ImpactedTask` — a single affected task with `exposure` (`direct | dependent | transitive`), `downstreamCount`, and `reason`
- `ImpactReport` — full report with `matchedTasks`, `affectedTasks`, `totalAffected`, and `summary`

### Core function — `packages/core/src/intelligence/impact.ts`
Added `predictImpact(change, cwd?, accessor?, matchLimit?)`:
- Tokenises the change description (stop-word filtered)
- Scores every task in the project by keyword overlap with the change description
- Seeds the top `matchLimit` (default 5) matched tasks
- BFS traversal of the reverse dependency graph from each seed
- Classifies each affected task as `direct`, `dependent`, or `transitive`
- Sorts results: direct first, then dependent, then transitive; within each group by descending downstream count

### Barrel exports
- `packages/core/src/intelligence/index.ts` — exports `predictImpact`, `ImpactedTask`, `ImpactReport`
- `packages/core/src/internal.ts` — exports `predictImpact`, `ImpactedTask`, `ImpactReport` (for `@cleocode/cleo` internal access)

### Dispatch engine — `packages/cleo/src/dispatch/engines/task-engine.ts`
Added `taskImpact(projectRoot, change, matchLimit?)` engine function wrapping `predictImpact`.

### Dispatch barrel — `packages/cleo/src/dispatch/lib/engine.ts`
Exported `taskImpact` from the task engine barrel.

### Domain handler — `packages/cleo/src/dispatch/domains/tasks.ts`
Added `case 'impact'` to the `query` switch in `TasksHandler`. Added `'impact'` to the supported query operations list.

### Registry — `packages/cleo/src/dispatch/registry.ts`
Registered `tasks.impact` (query, tier 1, idempotent, requires `change` param).

### CLI command — `packages/cleo/src/cli/commands/reason.ts`
Updated the existing `reason impact [taskId]` subcommand to support two modes:
- `cleo reason impact --change "Modify X"` — free-text prediction via `tasks.impact`
- `cleo reason impact <taskId>` — existing graph-based impact via `tasks.depends`

### Tests — `packages/core/src/intelligence/__tests__/impact.test.ts`
Added 7 new unit tests for `predictImpact`:
- Returns empty report when no keywords match
- Returns direct match for keyword overlap
- Traces downstream dependents from matched seeds
- Classifies exposure correctly (direct / dependent / transitive)
- Sorts by exposure order
- Respects `matchLimit` parameter
- Produces meaningful summary string
- `downstreamCount` is 0 for leaf tasks

### Test fixture updates
Updated 3 parity/count tests to account for the new operation:
- `packages/cleo/src/dispatch/domains/__tests__/tasks.test.ts` — added `'impact'` to query ops list
- `packages/cleo/src/mcp/gateways/__tests__/query.test.ts` — updated tasks count 15→16
- `packages/cleo/src/dispatch/__tests__/parity.test.ts` — updated registry count 214→215, queryCount 122→123

## Quality Gates

- biome check: PASS (4 auto-formatted files)
- build: PASS (Build complete, warnings pre-existing)
- tests: PASS (4855 passed, 5 skipped, 275 test files)
