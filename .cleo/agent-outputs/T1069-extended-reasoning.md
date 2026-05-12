# T1069 — Extended Code Reasoning (`cleo nexus why` + `impact-full`)

## Status: complete

## Files Changed

| File | Change |
|------|--------|
| `packages/contracts/src/nexus-living-brain-ops.ts` | Added `CodeReasonTrace`, `ReasonTraceStep`, `ImpactFullReport`, `BrainRiskNote` types |
| `packages/contracts/src/index.ts` | Re-exported the 4 new types |
| `packages/core/src/memory/brain-reasoning.ts` | Added `reasonWhySymbol()` function |
| `packages/core/src/nexus/living-brain.ts` | Added `reasonImpactOfChange()` function |
| `packages/cleo/src/cli/commands/nexus.ts` | Added `why` and `impact-full` subcommands |
| `packages/core/src/memory/__tests__/brain-reasoning-symbol.test.ts` | New test file — 7 tests green |

## Commits

- `b675425e3` — feat(T1069/PartD): contracts
- `5f8368ea4` — feat(T1069/PartA): reasonWhySymbol
- `75dabed22` — feat(T1069/PartB): reasonImpactOfChange
- `e37178a1e` — feat(T1069/PartC): CLI verbs
- `85a45c7f5` — feat(T1069/PartE): tests

## Key Implementation Notes

### Part A — `reasonWhySymbol`
- Walks `code_reference`, `documents`, `applies_to`, `mentions` reverse edges
- Fetches `brain_decisions` with `context_task_id` for each decision node
- Adds `task` steps via `brain_memory_links` lookup
- Returns `CodeReasonTrace { symbolId, narrative, chain: ReasonTraceStep[] }`

### Part B — `reasonImpactOfChange`
- Resolves symbol ID (name lookup fallback) in nexus.db
- Calls `analyzeImpact` BFS for structural blast radius
- Calls `getTasksForSymbol` for open task references
- Queries `code_reference`, `documents`, `mentions`, `affects` edges for brain risk notes
- Computes merged risk score: `max(structural, open-task-tier, brain-note-tier)`
- Returns `ImpactFullReport { symbolId, structural, openTasks, brainRiskNotes, mergedRiskScore, narrative }`

### Part C — CLI
- `cleo nexus why <symbol>` — renders narrative + chain table; supports `--json`
- `cleo nexus impact-full <symbol>` — renders merged report; supports `--json`

### Part E — Tests (7/7 green)
- reasonWhySymbol: empty chain, 3-step decision+task chain, observation handling
- reasonImpactOfChange: empty impact, brain risk note merge, risk tier elevation, narrative format
