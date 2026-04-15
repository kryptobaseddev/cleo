# T547 — Nexus CLI Commands: Wiring & Testing

**Status**: complete
**Date**: 2026-04-13
**Task**: Wire `cleo nexus analyze`, `cleo nexus clusters`, `cleo nexus flows` into the CLI

---

## Root Cause Analysis

Three distinct bugs prevented the nexus pipeline commands from working:

### Bug 1: `graphology` not in cleo's runtime node_modules
- **Symptom**: `Error: Cannot find module 'graphology'` on any nexus CLI command
- **Root cause**: The `community-processor.ts` uses `createRequire(import.meta.url)` to load `graphology` (a CJS package). When the CLI is bundled at `packages/cleo/dist/cli/index.js`, `createRequire` resolves from that path. `graphology` was only installed in `packages/nexus/node_modules/` — not accessible from cleo's bundle location.
- **Fix**: Added `graphology`, `graphology-communities-louvain`, `graphology-types` as direct dependencies of `@cleocode/cleo` via `pnpm --filter @cleocode/cleo add graphology graphology-communities-louvain graphology-types`.

### Bug 2: `.all().catch()` on synchronous Drizzle query
- **Symptom**: `cleo nexus clusters --json` returned `"message": "db.select(...).from(...).all(...).catch is not a function"`
- **Root cause**: `NodeSQLiteDatabase` uses the sync Drizzle adapter (`'sync'` mode). `.all()` returns a plain array — not a Promise — so `.catch()` is not available on it.
- **Fix**: Replaced the `.all().catch()` pattern with a `try-catch` block around `.all()` in both `nexus clusters` and `nexus flows` commands in `packages/cleo/src/cli/commands/nexus.ts`.

### Bug 3: `.where({ projectId })` object-style where clause fails in Drizzle v1 beta
- **Symptom**: `cleo nexus status` showed `indexed: false` even after a successful `cleo nexus analyze`; `cleo nexus clusters` returned 0 communities before the Louvain data was committed
- **Root cause**: Multiple functions in `packages/nexus/src/pipeline/index.ts` used `.where({ projectId } as unknown as Record<string, unknown>)` — an invalid Drizzle v1 API. The object-style where clause throws "Unknown named parameter 'projectId'" which is caught and silently returns empty data.
- **Fix**: Imported `eq, and` from `drizzle-orm` in `packages/nexus/src/pipeline/index.ts` and replaced all object-style where clauses with `eq(column, value)` calls. Also fixed the delete pattern in the CLI's `nexus analyze` to use `eq()` with `.run()` instead of `await db.delete().where(callback)`.

---

## Files Modified

| File | Change |
|------|--------|
| `packages/cleo/package.json` | Added `graphology`, `graphology-communities-louvain`, `graphology-types` as dependencies |
| `packages/cleo/src/cli/commands/nexus.ts` | Fixed `.all().catch()` → try-catch; fixed delete `.where(callback)` → `eq()`+`.run()` |
| `packages/nexus/src/pipeline/index.ts` | Added `eq, and, Column` imports from `drizzle-orm`; fixed all `.where({ projectId })` calls |

---

## Test Results

### Command Tests

```
cleo nexus analyze packages/contracts --json
  success: true, nodeCount: 626, relationCount: 104, fileCount: 52, durationMs: ~5000ms

cleo nexus status packages/contracts --json
  success: true, indexed: true, nodeCount: 626, relationCount: 104, fileCount: 613, staleFileCount: 0

cleo nexus clusters packages/contracts --json
  success: true, count: 13 communities

cleo nexus flows packages/contracts --json
  success: true, count: 0 flows (expected: contracts has no cross-file execution flows)
```

### Unit/Integration Tests

```
Test Files: 396 passed (396)
Tests:      7129 passed | 10 skipped | 32 todo (7171)
Duration:   80.95s
Zero new failures.
```

### Human-Readable Output Verification

```
cleo nexus status packages/contracts
  [nexus] Index status for: /mnt/projects/cleocode/packages/contracts
    Project ID:   L21udC9wcm9qZWN0cy9jbGVvY29kZS9w
    Nodes:        626
    Relations:    104
    Files:        613
    Last indexed: 2026-04-13T00:36:05.025Z
    Staleness:    up to date
```

---

## Quality Gates

- [x] `pnpm biome check --write .` (no violations)
- [x] `pnpm run build` (passes cleanly)
- [x] `pnpm run test` (396/396 test files pass, 0 new failures)
- [x] `git diff --stat HEAD` verified scope of changes
