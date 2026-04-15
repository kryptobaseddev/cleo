# T537 — Brain Graph Auto-Population Hooks

**Status**: complete
**Date**: 2026-04-11
**Epic**: T523 (BRAIN Integrity)

## Summary

Wired automatic knowledge graph population from the four surviving legitimate
write paths in the BRAIN memory system. When a decision, observation, pattern,
or learning is created, corresponding `brain_page_nodes` rows are upserted and
`brain_page_edges` rows are inserted. Task completion also creates a task node
and `part_of` edge to its parent epic.

All graph writes are:
- **Best-effort** — fire-and-forget with `catch(() => {})`, never block the
  primary operation
- **Gated on `brain.autoCapture`** — via the shared `isAutoCaptureEnabled`
  helper from `handler-helpers.ts`
- **Idempotent** — `onConflictDoUpdate` for nodes, `onConflictDoNothing` for
  edges (composite PK prevents duplicates)

## Files Created

### `packages/core/src/memory/graph-auto-populate.ts` (new)

Central module with two public functions:

- `upsertGraphNode(projectRoot, nodeId, nodeType, label, qualityScore, content, metadata?)` — inserts or updates a `brain_page_nodes` row; derives `contentHash` from SHA-256 prefix of content.
- `addGraphEdge(projectRoot, fromId, toId, edgeType, weight?, provenance?)` — inserts a `brain_page_edges` row, ignoring conflicts on the composite PK.

Both functions check `isAutoCaptureEnabled` before touching the DB.

## Files Modified

### `packages/core/src/memory/decisions.ts`

After `accessor.addDecision(row)`:
- Upserts `decision:<id>` node with type, confidence metadata
- If `validTaskId` present: upserts `task:<id>` node + `applies_to` edge
- If `validEpicId` present: upserts `epic:<id>` node + `applies_to` edge
- Also refreshes the node on the duplicate-update path

### `packages/core/src/memory/brain-retrieval.ts` (`observeBrain`)

After `accessor.addObservation(...)`:
- Upserts `observation:<id>` node with sourceType, agent metadata
- If `validSessionId` present: upserts `session:<id>` node + `produced_by` edge

### `packages/core/src/memory/patterns.ts` (`storePattern`)

After `accessor.addPattern(entry)`:
- Upserts `pattern:<id>` node with type, impact metadata
- Also refreshes node on the duplicate-update (frequency-increment) path

### `packages/core/src/memory/learnings.ts` (`storeLearning`)

After `accessor.addLearning(entry)`:
- Upserts `learning:<id>` node with source, confidence, actionable metadata
- Also refreshes node on the duplicate-update (confidence-merge) path

### `packages/core/src/tasks/complete.ts`

After the transaction commits (SEPARATE from the gutted `extractTaskCompletionMemory`):
- Upserts `task:<id>` node with status=done, priority metadata
- If `task.parentId` present: upserts `epic:<parentId>` node + `part_of` edge

## Graph Node Types Used

| Node Type   | Source               | Node ID Format         |
|-------------|----------------------|------------------------|
| `decision`  | `storeDecision`      | `decision:<D-id>`      |
| `observation` | `observeBrain`     | `observation:<O-id>`   |
| `pattern`   | `storePattern`       | `pattern:<P-id>`       |
| `learning`  | `storeLearning`      | `learning:<L-id>`      |
| `task`      | `completeTask`       | `task:<T-id>`          |
| `epic`      | `completeTask`       | `epic:<parent-id>`     |
| `session`   | `observeBrain`       | `session:<ses-id>`     |

## Graph Edge Types Wired

| Edge Type    | From         | To        | Trigger           |
|--------------|--------------|-----------|-------------------|
| `applies_to` | decision     | task/epic | `storeDecision`   |
| `produced_by`| observation  | session   | `observeBrain`    |
| `part_of`    | task         | epic      | `completeTask`    |

## Quality Gates

- `pnpm biome check --write` — passed (2 files auto-fixed: minor style)
- `pnpm --filter @cleocode/core run build` — passed, zero errors
- `pnpm run test` — 43 memory/task test files pass (750 tests). The one failing
  suite (`nexus.test.ts`) is a pre-existing failure from T534's pipeline changes
  to `nexus.ts` before `@cleocode/nexus` is built; not caused by T537.

## autoCapture Gate Verification

`shouldAutoPopulateGraph` delegates to `isAutoCaptureEnabled` from
`handler-helpers.ts`. If the config cannot be loaded (e.g., brain.db not
migrated, config missing), it returns `false`, keeping all graph writes
disabled. Default when config key is absent is `false` — same as existing
hook handlers.
