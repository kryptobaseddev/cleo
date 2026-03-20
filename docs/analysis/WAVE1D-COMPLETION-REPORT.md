# Wave 1D Completion Report: NEXUS End-to-End Validation

## Summary

- **Test file**: `packages/core/src/nexus/__tests__/nexus-e2e.test.ts`
- **New tests**: 89 (all passing)
- **Existing tests**: 80 (all still passing)
- **Total nexus tests**: 169 (all passing)
- **Bugs found**: 1 (fixed)
- **Build status**: Clean (no errors)

## Bugs Found and Fixed

### BUG: `extractKeywords()` strips uppercase letters instead of lowercasing

**File**: `packages/core/src/nexus/discover.ts`
**Function**: `extractKeywords()`

**Problem**: The function applied a regex `/[^a-z0-9\s-]/g` to strip non-lowercase characters BEFORE lowercasing the input. This caused uppercase letters to be stripped instead of converted, producing broken keywords like `'uthentication'` from `'Authentication'`.

**Impact**: Low in practice because all internal callers (in `discoverRelated`) pre-lowercase their input before calling `extractKeywords`. However, the public API contract was broken for any direct caller passing mixed-case text.

**Fix**: Added `.toLowerCase()` as the first step in the pipeline, before the regex replace. One-line change.

## Test Coverage by Category

### 1. Audit Log Verification (9 tests) -- NEW
- register/unregister/sync/sync-all/set-permission/reconcile all create audit entries
- Audit entries survive project deletion (append-only integrity)
- Audit entries have valid timestamps and unique UUIDs

### 2. Health Status (4 tests) -- NEW
- Newly registered projects have `unknown` health status
- Health status can be updated (unknown/healthy/degraded/unreachable)
- Health status preserved through readRegistry round-trip
- All 4 valid health status values storable and retrievable

### 3. Permission Updates (6 tests) -- NEW
- nexusSetPermission upgrade (read -> write, read -> execute)
- nexusSetPermission downgrade (execute -> read)
- nexusSetPermission throws for non-existent project
- setPermission (permissions module wrapper) works correctly
- setPermission throws on empty name

### 4. Schema Integrity (6 tests) -- NEW
- nexus.db created with correct schema version in nexus_schema_meta
- All required tables (project_registry, nexus_audit_log, nexus_schema_meta) exist
- project_registry indexes exist and are usable (hash, name)
- nexus.db file created on disk
- readRegistry behavior on uninitialized DB
- readRegistryRequired behavior on empty DB

### 5. Multi-Project Operations (4 tests) -- NEW
- Register and list 5 projects
- nexusSyncAll syncs multiple projects correctly
- readRegistry returns correct structure for all projects
- Unregistering one project does not affect others

### 6. Cross-Project Task Resolution (5 tests) -- NEW
- Resolve task from named project
- Resolve task from a different project
- Wildcard resolution across projects
- Throws for task not found in specific project
- Throws for non-existent project

### 7. Dependency Graph (4 tests) -- NEW
- Builds graph from multiple projects with correct node/edge counts
- Forward dependency resolution
- Reverse dependency resolution
- resolveCrossDeps resolves local dependencies

### 8. Orphan Detection (2 tests) -- NEW
- No orphans when all deps are local
- No orphans for projects with zero dependencies

### 9. Blocking Analysis Extended (1 test) -- NEW
- Diamond dependency pattern (A -> B, A -> C, B -> D, C -> D) correctly finds all transitively blocked tasks

### 10. Critical Path Extended (2 tests) -- NEW
- Returns valid CriticalPathResult structure
- blockedBy field behavior verified

### 11. Discovery Module (20 tests) -- NEW (previously ZERO tests)
- **extractKeywords**: 4 tests (meaningful extraction, stop word filtering, empty string, case handling)
- **searchAcrossProjects**: 7 tests (keyword search, task ID pattern, no match, limit, project filter, non-existent project filter, wildcard syntax)
- **discoverRelated**: 8 tests (label matching, description matching, auto mode, invalid syntax error, wildcard error, limit, score sorting, result shape)

### 12. Reconciliation Extended (2 tests) -- NEW
- Hash-based reconciliation (no project-info.json)
- Auto-registration for unknown project without projectId

### 13. Edge Cases (12 tests) -- NEW
- Very long path registration
- Empty path/name/hash error handling
- Idempotent nexusInit
- Zero-task project registration
- Label sorting and deduplication
- Empty string nexusGetProject
- Fresh nexusList
- lastUpdated timestamp correctness
- Hash determinism and uniqueness

### 14. Query Module Extended (6 tests) -- NEW
- validateSyntax for 3+ digit IDs
- Reject empty and too-short IDs
- parseQuery with currentProject override
- Dot syntax
- getProjectFromQuery for all syntaxes

### 15. Permission Module Extended (6 tests) -- NEW
- permissionLevel numeric values
- Default permission for unregistered projects
- checkPermissionDetail full result
- requirePermission descriptive error message
- Permission hierarchy (write includes read)
- NEXUS_SKIP_PERMISSION_CHECK bypass

### 16. Graph Caching (1 test) -- NEW
- invalidateGraphCache forces rebuild

## Coverage Gaps Remaining

1. **Concurrent registration**: The SQLite WAL mode provides concurrency safety at the DB level, but there are no multi-process contention tests. This would require spawning child processes and is more of an integration/stress test.

2. **JSON-to-SQLite migration**: The `migrateJsonToSqlite()` function exists but testing it requires creating a legacy JSON registry file. The migration path is a one-time operation that has already been deployed.

3. **Cross-project dependency orphans with real cross-project dep strings**: SQLite FK constraints prevent storing cross-project dependency strings (like `backend:T001`) in the task dependency table. The orphan detection code handles the cross-project reference pattern `project:taskId`, but creating test data with actual cross-project deps requires bypassing FK constraints.

4. **Sharing module**: The sharing submodule (`nexus/sharing/`) has its own test coverage path and is outside the nexus registry scope.

## Files Modified

- `packages/core/src/nexus/discover.ts` -- Bug fix: added `.toLowerCase()` in `extractKeywords()`
- `packages/core/src/nexus/__tests__/nexus-e2e.test.ts` -- New: 89 comprehensive E2E tests
