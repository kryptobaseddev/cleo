# T538 — Community Detection + Process Detection

**Status**: complete
**Date**: 2026-04-12
**Task**: Wave G-1 — Community detection (Louvain) + process detection ported from GitNexus

## What Was Built

### 1. Dependency Installation

Installed `graphology`, `graphology-communities-louvain`, and `graphology-types` into
`@cleocode/nexus`:

```
pnpm add graphology graphology-communities-louvain graphology-types --filter @cleocode/nexus
```

Using Louvain (not Leiden) per cross-validation recommendation RR2. Resolution parameter
set to `2.0` for monorepo-aware clustering.

### 2. Entry Point Scoring (`packages/nexus/src/pipeline/entry-point-scoring.ts`)

Ported from GitNexus `entry-point-scoring.ts`, simplified to TypeScript/JavaScript patterns:

- `calculateEntryPointScore(name, isExported, callerCount, calleeCount)` — composite score
  using call ratio × export multiplier × name pattern multiplier
- Universal entry patterns: `handle*`, `on*`, `*Controller`, `process*`, `execute*`,
  `handle*`, plus React hooks (`use*`)
- Utility penalty patterns: getters, setters, formatters, parsers, converters
- `isTestFile(filePath)` — excludes `.test.ts`, `.spec.ts`, `__tests__/`, etc.
- `isUtilityFile(filePath)` — identifies `/utils/`, `/helpers/`, `/lib/` paths

### 3. Community Detection (`packages/nexus/src/pipeline/community-processor.ts`)

Ported from GitNexus `community-processor.ts`, adapted for CLEO's KnowledgeGraph API:

- Builds an undirected graphology `Graph` from CALLS, EXTENDS, IMPLEMENTS edges
- Large-graph mode (> 10K symbols): filters edges below confidence 0.5, skips degree-1 nodes
- Runs Louvain with 60-second timeout guard; falls back to single cluster on timeout
- Skips singleton communities (size < 2)
- Generates heuristic labels from most common parent folder name
- Calculates cohesion (internal edges / total edges, sampled at 50 members)
- Writes `community` nodes into KnowledgeGraph
- Writes `member_of` edges from symbols to communities
- Sets `communityId` on participating graph nodes in-place

CJS/ESM interop: `graphology-communities-louvain` is loaded via `createRequire` because its
`index.js` uses `module.exports`. A typed `GraphInstance` interface wraps the graphology
`Graph` class to avoid TypeScript namespace conflicts under `NodeNext` module resolution.

### 4. Process Detection (`packages/nexus/src/pipeline/process-processor.ts`)

Ported from GitNexus `process-processor.ts`:

- Builds forward and reverse CALLS adjacency lists (confidence >= 0.5)
- Scores entry point candidates using `calculateEntryPointScore`; top 200 selected
- BFS trace from each entry point (max depth 10, max branching 4, min steps 3)
- Deduplicates traces: subset removal + longest-path-per-endpoint-pair
- Limits to 75 processes, sorted by descending step count
- Writes `process` nodes into KnowledgeGraph with meta: processType, stepCount, communities
- Writes `step_in_process` edges (1-indexed step position in reason field)
- Writes `entry_point_of` edges from entry point node to process node
- Sets `processIds` on all participating graph nodes

### 5. Pipeline Integration (`packages/nexus/src/pipeline/index.ts`)

Phases wired in after call resolution:

```
Phase 5: Community detection (Louvain)
Phase 6: Process (execution flow) detection
```

`PipelineResult` extended with:
- `communityCount` — number of non-singleton communities
- `communityModularity` — Louvain quality metric (0–1)
- `processCount` — detected execution flows
- `crossCommunityProcessCount` — flows spanning multiple communities

All new types exported from `packages/nexus/src/pipeline/index.ts`.

### 6. CLI Commands (`packages/cleo/src/cli/commands/nexus.ts`)

Two new subcommands added to `cleo nexus`:

- `cleo nexus clusters [path] [--json] [--project-id <id>]`
  Lists all community nodes from the last analysis. Queries `nexus_nodes` where
  `kind = 'community'`. Outputs: id, label, symbolCount, cohesion.

- `cleo nexus flows [path] [--json] [--project-id <id>]`
  Lists all process nodes from the last analysis. Queries `nexus_nodes` where
  `kind = 'process'`. Outputs: id, label, stepCount, processType, entryPointId.

Both commands support `--json` for LAFS-envelope output and `--project-id` override.

## Test Coverage

New test file: `packages/nexus/src/__tests__/community-process.test.ts`

Tests cover:
- `calculateEntryPointScore`: zero score on no callees, export bonus, utility penalty,
  entry pattern bonus, call ratio ranking
- `isTestFile`: `.test.ts`, `.spec.ts`, `__tests__/`, normal source files
- `isUtilityFile`: `/utils/` paths
- `detectCommunities`: empty graph, graph with no CALLS edges, two-cluster graph
  (verifies community nodes + MEMBER_OF edges created)
- `detectProcesses`: empty graph, multi-hop 3-step trace (verifies process nodes +
  STEP_IN_PROCESS + ENTRY_POINT_OF edges), test file exclusion

## Quality Gates

- `pnpm biome check --write` — passed, no violations
- `pnpm run build` — passed (395 packages, 0 errors; 2 pre-existing parse-loop.ts errors
  unrelated to T538)
- `pnpm run test` — 395 test files passed, 7112 tests passed, 0 failures

## Files Changed

- `packages/nexus/src/pipeline/entry-point-scoring.ts` (new)
- `packages/nexus/src/pipeline/community-processor.ts` (new)
- `packages/nexus/src/pipeline/process-processor.ts` (new)
- `packages/nexus/src/pipeline/index.ts` (extended: imports, exports, PipelineResult, Phases 5+6)
- `packages/nexus/package.json` (graphology deps added)
- `packages/cleo/src/cli/commands/nexus.ts` (nexus clusters + nexus flows commands)
- `packages/nexus/src/__tests__/community-process.test.ts` (new)
