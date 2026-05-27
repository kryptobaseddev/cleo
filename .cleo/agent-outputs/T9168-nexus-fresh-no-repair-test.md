# T9168 — Nexus fresh-DB no-warning regression test

**Status**: complete
**Task**: T9168
**Epic**: T9163
**Branch**: task/T9168
**Commit**: c67c8a28528bcba52ebd3e5dbef0f0ae6862637b

## What was done

Added `packages/core/src/store/__tests__/migration-fresh-no-repair.nexus.test.ts`.

This test locks in the T9164 fix (explicit forward migration for `nexus_nodes.is_external`) by:

1. Using `vi.resetModules()` + `vi.doMock('../../paths.js')` to redirect nexus.db into an isolated tmpdir.
2. Installing a capturing warn mock on `../../logger.js` before dynamically importing `nexus-sqlite.js`.
3. Calling `getNexusDb()` to trigger a fresh canonical migration path.
4. Asserting zero `"Adding missing column"` warnings were emitted.
5. Verifying via `PRAGMA table_info` that `nexus_nodes.is_external` exists (T9164) and `nexus_relations` has `weight`, `last_accessed_at`, `co_accessed_count` (T998).

## Evidence gates

- **implemented**: commit c67c8a285 on task/T9168
- **testsPassed**: 1/1 pass (test-run:/tmp/t9168-tests.json)
- **qaPassed**: biome ci clean + tsc 0 errors

## Key findings

- The `vi.doMock` + `vi.resetModules` pattern must be applied before dynamic import of the module under test to intercept `getLogger()` calls inside `migration-manager.ts`.
- Logger mock must capture both positional signatures: `warn(msg)` and `warn(obj, msg)`.
- The worktree GIT_DIR env trick (`GIT_DIR=$WORKTREE/.git cleo verify/complete`) is required when the worktree branch commit is not yet merged to release branch.
- All 8 migration test files (107 tests) pass alongside the new test.
