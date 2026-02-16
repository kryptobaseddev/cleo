# Performance Analysis: validate and deps Commands

**Task**: T4649
**Epic**: T4638
**Date**: 2026-02-16
**Status**: analysis

---

## Benchmark Summary

| Command   | Ratio vs Bash | Target |
|-----------|---------------|--------|
| validate  | 4.29x slower  | < 2x   |
| deps      | 3.33x slower  | < 2x   |

---

## validate Command Bottlenecks

### Bottleneck 1: Double JSON parse (archive loading)

**File**: `src/cli/commands/validate.ts:83-95`

The validate command reads `todo.json` (line 44) and then separately reads
`todo-archive.json` (line 84) on every run, even when archive is empty or
does not exist. Each call to `readJson` goes through `safeReadFile` (async
readFile) plus `JSON.parse`.

**Fix**: Only load the archive when duplicate-ID checking is needed. Add a
`--skip-archive` flag for fast validation. Alternatively, cache the parsed
archive across validation runs using `getCachedValidation` from the doctor
project-cache module.

**Impact**: Medium - archive can be large (hundreds of archived tasks).

### Bottleneck 2: O(n^2) circular dependency detection

**File**: `src/cli/commands/validate.ts:23-32, 124-138`

`hasCircularDep` is called for every task with dependencies, and each call
does a fresh DFS using `tasks.find()` (linear scan per lookup). For n tasks
with dependencies, this is O(n * m) where m is the chain length, and each
step is O(n) due to the `find` call. Combined: O(n^2 * m).

**Fix**: Build a `Map<string, Task>` once and pass it to `hasCircularDep`.
Better yet, use the proper cycle detection from `src/core/phases/deps.ts`
(`detectCycles`) which builds an adjacency graph once and runs a single DFS
pass over all nodes.

**Impact**: High - the existing `detectCycles()` in deps.ts already does
this correctly in O(V+E). Replace the inline algorithm.

### Bottleneck 3: Checksum recomputation

**File**: `src/cli/commands/validate.ts:193-199`

`computeChecksum(data.tasks)` calls `JSON.stringify` on the entire tasks
array, then SHA-256 hashes it. For large task lists this is non-trivial.

**Fix**: Cache the computed checksum if it was already computed during a
prior operation in the same process. Alternatively, skip checksum
verification in `--quick` mode.

**Impact**: Low-Medium - depends on task count.

---

## deps Command Bottlenecks

### Bottleneck 1: Repeated file reads across subcommands

**File**: `src/core/phases/deps.ts`

Every function (`getDepsOverview`, `getTaskDeps`, `getExecutionWaves`,
`getCriticalPath`, `getImpact`, `detectCycles`, `getTaskTree`) independently
calls `readJsonRequired<TodoFile>(getTodoPath())`. If a user calls
`deps overview` followed by `deps waves`, the file is read and parsed twice.

**Fix**: Add a module-level cache for the parsed TodoFile with TTL-based
invalidation (check file mtime). The `readJsonRequired` result can be memoized
within the same process invocation since CLI commands are single-shot.

**Impact**: Medium - eliminates redundant I/O and parsing.

### Bottleneck 2: Full graph rebuild per operation

**File**: `src/core/phases/deps.ts:62-88`

`buildGraph()` is called fresh by every function. For `getTaskDeps`, the
full graph is built even though only one task's neighborhood is needed.

**Fix**: Cache the graph at module scope. Since CLI commands are single-shot,
the graph only needs to be built once per invocation. Add a `getOrBuildGraph`
helper:

```typescript
let _graphCache: { tasks: Task[]; graph: Map<string, DepNode> } | null = null;

function getOrBuildGraph(tasks: Task[]): Map<string, DepNode> {
  if (_graphCache && _graphCache.tasks === tasks) return _graphCache.graph;
  const graph = buildGraph(tasks);
  _graphCache = { tasks, graph };
  return graph;
}
```

**Impact**: Low for single subcommand runs, Medium if chained.

### Bottleneck 3: TaskMap recreation

**File**: `src/core/phases/deps.ts:123, 264, 392`

`new Map(tasks.map(t => [t.id, t]))` is created inside multiple functions
independently. This duplicates work.

**Fix**: Move the taskMap creation into a shared helper alongside the graph
cache. Both the graph and the taskMap derive from the same tasks array.

**Impact**: Low - Map creation is fast, but it adds up.

---

## Recommended Priority Order

1. **validate: Replace inline cycle detection with `detectCycles`** - High
   impact, eliminates O(n^2) algorithm. Straightforward refactor.

2. **validate: Lazy archive loading** - Medium impact. Only read archive
   when cross-file duplicate check is enabled.

3. **deps: Cache parsed TodoFile per process** - Medium impact. Single
   memoization wrapper around readJsonRequired.

4. **validate: Add --quick mode** - Skips archive loading, checksum, and
   stale task detection. Useful for pre-commit hooks.

5. **deps: Cache graph and taskMap** - Low-Medium impact. Module-level
   singleton for graph.

6. **Both: Consider StoreProvider caching** - When SQLite backend lands,
   the in-memory db handles caching natively. Focus on JSON-mode
   optimizations now; SQLite will handle the rest.

---

## Notes

- Node.js startup overhead accounts for a fixed ~100-200ms regardless of
  command. The bash baseline is lower because bash has minimal startup cost.
- The `proper-lockfile` import in `store/lock.ts` adds latency to any write
  path but should not affect read-only commands like validate and deps.
- `write-file-atomic` is imported eagerly in `store/atomic.ts` but only used
  on writes. Lazy import could shave off startup time.
