# T651: BUG CRITICAL Fix — /api/living-brain brain_page_edges + cross-substrate bridges

## Status: complete

## Problem

The `/api/living-brain` API returned 357 nodes but only 114 edges, all of type
`has_method`, `calls`, `parent_of`, `messages` — exclusively nexus/tasks edges.
ZERO brain edges (supersedes, applies_to, derived_from, code_reference, etc).
ZERO cross-substrate bridges connecting brain to tasks or nexus.

## Root Causes (three layered issues)

### Root Cause 1: Schema mismatch — brain_patterns and brain_learnings

The brain adapter queried `SELECT id, title, ...` from `brain_patterns` and
`brain_learnings`, but neither table has a `title` column:

- `brain_patterns` uses `pattern` (text), `type`, `extracted_at` (not `created_at`)
- `brain_learnings` uses `insight` (text), `created_at`

This threw `no such column: title` (and `no such column: created_at` for patterns)
inside the `try/catch` block, aborting the entire brain adapter before any
edge synthesis ran.

### Root Cause 2: Type-prefix ID mismatch in brain_page_edges lookup

The adapter built `rawIds` by stripping the `"brain:"` LBNode prefix
(e.g. `"brain:O-abc"` → `"O-abc"`), then tried to look up edges in
`brain_page_edges` where IDs are stored in type-prefixed format
(`"observation:O-abc"`, `"decision:D-xxx"`, `"pattern:P-xxx"`).

No IDs matched, so zero edges were emitted even when patterns/learnings
queries would have succeeded.

### Root Cause 3: ISO-8601 timestamp format

SQLite stores datetimes as `"2026-04-13 20:27:45"` (space separator).
The `createdAt` contract requires ISO-8601 (`"2026-04-13T20:27:45"` with T).
The `created-at-projection` test would fail with any brain node that
reached the returned nodes array.

## Fix

### File: packages/studio/src/lib/server/living-brain/adapters/brain.ts

**Schema fixes:**
- `brain_patterns` query: `pattern` column (not `title`), `type`, `extracted_at`
- `brain_learnings` query: `insight` column (not `title`)
- All four tables: `strftime('%Y-%m-%dT%H:%M:%S', ...)` to normalise timestamps

**Type-prefix ID mapping:**
- Build `typeIdToLBId: Map<string, string>` while loading each node set
- Keys use type-prefix format: `observation:O-xxx`, `decision:D-xxx`, etc.
- Fall back to `brainTypeIdToLBId()` helper for nodes outside the loaded set

**Edge classification logic (new):**
- `isTaskId(to_id)` → `task:T-xxx` → emit as `brain:xxx → tasks:xxx`, substrate `cross`
- `isNexusStyleId(to_id)` → `::` paths or `/` paths → emit as `brain:xxx → nexus:to_id`, substrate `cross`
- Otherwise → intra-brain edge, substrate `brain`

**Cross-substrate bridges (new):**
- `brain_memory_links` table: each row → `brain:xxx → tasks:T-xxx` with link_type as edge type
- `brain_observations.files_modified_json`: each file path → `brain:xxx → nexus:path` (`modified_by`)
- `brain_decisions.context_task_id`: direct soft-FK → `brain:D-xxx → tasks:T-xxx` (`applies_to`)

### File: packages/studio/src/lib/server/living-brain/__tests__/bridges.test.ts (new)

23 new unit tests covering all bridge types using synthetic in-memory fixtures:
- intra-brain edges (supersedes, derived_from)
- brain→tasks cross bridges (applies_to, derived_from from page_edges)
- brain→nexus cross bridges (code_reference via :: paths)
- brain_memory_links edges (produced_by, applies_to)
- files_modified_json → modified_by bridges
- brain_decisions.context_task_id direct bridges
- edge substrate classification
- combined multi-bridge scenario

## Verification

### Before fix
```
Total edges: 114
Edge types: {calls: 74, has_method: 6, parent_of: 37, messages: 3}
Substrates: {nexus, tasks, cross}
```

### After fix
```
Total edges: 3575
Edge types: {code_reference: 2669, supersedes: 463, applies_to: 114,
             derived_from: 107, contradicts: 100, calls: 74,
             parent_of: 37, has_method: 6, messages: 3, produced_by: 2}
Substrates: {cross: 2895, brain: 563, nexus: 80, tasks: 37}
```

### Quality Gates
- `pnpm biome check --write packages/studio`: no issues
- `pnpm --filter @cleocode/studio run build`: pass
- `pnpm --filter @cleocode/studio run test`: 143/143 pass (23 new)
- `pnpm run test`: 7642/7642 pass (all 425 test files)

## Files Changed

- `packages/studio/src/lib/server/living-brain/adapters/brain.ts` — root cause fix
- `packages/studio/src/lib/server/living-brain/__tests__/bridges.test.ts` — new tests (23)
