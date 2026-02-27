# T4767: Graph-RAG, Graph Ops, and Nexus Audit

**Date**: 2026-02-27
**Task**: T4767
**Epic**: T4763 (BRAIN Foundation)
**Type**: Research/Audit

---

## 1. Graph-RAG (`src/core/tasks/graph-rag.ts`)

### Status: Production-ready with caveat (no tests)

**4 Discovery Algorithms**:
1. `discoverByLabels()` - Jaccard similarity on shared labels. Correct implementation.
2. `discoverByDescription()` - Keyword tokenization with stopword removal + Jaccard. Correct.
3. `discoverByFiles()` - Shared file path matching. Correct.
4. `discoverByHierarchy()` - Sibling/cousin detection via parent/grandparent traversal. Correct.
5. `discoverRelatedTasks()` - Combined auto mode with hierarchy boosting. Correct merge logic.

**Scoring**: All methods use Jaccard similarity (0.0-1.0), hierarchy adds boost (sibling=0.15, cousin=0.08). Scores are capped at 1.0 in auto mode.

**Issues Found**:
- **CRITICAL: Zero test coverage**. No `graph-rag.test.ts` exists.
- `suggestRelates()` accesses `task.relates` which is not in the TypeScript type definition (uses `as Task & { relates?: RelatesEntry[] }` cast).
- Tokenizer is English-only (stopwords hardcoded).

**Recommendations**:
- Create `src/core/tasks/__tests__/graph-rag.test.ts` with tests for each discovery method.
- Consider adding `relates` to the Task type if it's a runtime field.

---

## 2. Graph Ops (`src/core/tasks/graph-ops.ts`)

### Status: Production-ready

**Functions**:
1. `computeDependencyWaves()` - BFS-style wave computation. Handles cycles by placing remaining tasks in final wave.
2. `getNextTask()` - Priority-based ready task selection. Active tasks ranked first, then by priority.
3. `getCriticalPath()` - Topological sort + longest path via dynamic programming. Returns task ID array.
4. `getTaskOrder()` - Topological sort with priority fallback on cycles.
5. `getParallelTasks()` - First wave extraction from dependency waves.

**Test Coverage**: 20 tests, all passing. Covers linear chains, parallel grouping, completed task exclusion, cycles, empty inputs.

**Issues Found**: None. Clean implementation.

---

## 3. Graph Cache (`src/core/tasks/graph-cache.ts`)

### Status: Production-ready, minimal usage

**Features**:
- TTL-based caching (default 30s) for descendants, children, dependents, and waves.
- Automatic invalidation via task checksum (computed from IDs, statuses, parents, deps).
- `invalidate()` method for manual cache clearing.
- `getStats()` for observability.

**Issues Found**:
- No direct test coverage for the `GraphCache` class itself.
- Not imported directly by graph-rag.ts or graph-ops.ts. Used primarily by nexus deps.
- Checksum is string-based concatenation which is fast but collision-prone for very large task sets.

**Recommendations**:
- Consider adding basic unit tests for TTL expiration and checksum invalidation.

---

## 4. Nexus (`src/core/nexus/`)

### Status: Shipped, unvalidated (as noted in ADR-009)

**Modules**:
1. `registry.ts` - Project registration, sync, listing. Zod schema validation.
2. `permissions.ts` - Three-tier access control (read/write/execute). Zod-validated.
3. `query.ts` - Cross-project task search and resolution.
4. `deps.ts` - Cross-project dependency analysis with graph cache.

**Test Coverage**: 65 tests across 4 test files, all passing.
- Registry: 22 tests (CRUD, sync, validation)
- Permissions: 14 tests (level checks, enforcement)
- Query: 19 tests (search, resolution)
- Deps: 10 tests (cross-project deps, cache)

**Issues Found**:
- Nexus operates on file-based JSON (`~/.cleo/cleo-nexus-registry.json`), not SQLite. ADR-006 mandates SQLite for Nexus (`cleo-nexus.db`). This is a known gap per ADR-009 Section 8 #4.
- Cross-project similarity (`nexus.find`) is listed as "shipped (unvalidated)" in ADR-009.

**Recommendations**:
- Nexus SQLite migration should be tracked as a separate follow-up task.
- Validate cross-project search accuracy when real multi-project scenarios exist.

---

## 5. Summary Assessment

| Module | Lines | Tests | Status | Risk |
|--------|-------|-------|--------|------|
| graph-rag.ts | 313 | 0 | Production-ready | Medium (no tests) |
| graph-ops.ts | 209 | 20 | Production-ready | Low |
| graph-cache.ts | 161 | 0 (indirect) | Production-ready | Low |
| nexus/ | ~800 | 65 | Shipped (unvalidated) | Medium (storage gap) |

**Overall**: The graph systems are well-implemented and architecturally sound. The primary gap is test coverage for graph-rag.ts. All existing tests pass. The Nexus storage migration to SQLite is a known future task.
