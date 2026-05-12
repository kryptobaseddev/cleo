# Challenger Verdict v2 — T1331

**Date**: 2026-04-24
**Reviewer**: Challenger v2
**Commit under review**: `b8867cf9b fix(T1331): v2 leaf-module fix — extract DatabaseSync ctor into sqlite-native.ts`
**Previous commit**: `68b3e8738 fix(T1331): lazy-init DatabaseSync in sqlite.ts` (v1, REJECTED)

---

## Full-suite run results

All runs executed from `/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1331`.

- **Run 1**: FAIL — `agent-resolver.test.ts` T1241 failed (1 file failed, 5790 passed)
- **Run 2**: FAIL — `agent-resolver.test.ts` T1241 failed + `spawn.test.ts` ThinAgent flake (2 files failed)
- **Run 3**: PASS — only `specialists.test.ts` O(n²) timing flake (pre-existing); T1241 and spawn.test both passed
- **Run 4**: FAIL — `agent-resolver.test.ts` T1241 failed (1 file failed)
- **Run 5**: PASS — 384 passed, 0 failed (complete green run)
- **Run 6** (bonus): FAIL — `agent-resolver.test.ts` T1241 failed

- **Summary for T1241**: FAIL in runs 1, 2, 4, 6 out of 6 total runs (4 failures). When isolated, all 13 agent-resolver tests pass.

**Critical finding**: In run 6 the exact error was captured:
```
ReferenceError: Cannot access '__vite_ssr_import_9__' before initialization
  at openNativeDatabase src/store/sqlite.ts:58:28
     const DatabaseSyncCtor = getDbSyncConstructor();
```

This is a **new manifestation of the same TDZ problem**. Vite/Vitest SSR transform converts the static `import { getDbSyncConstructor } from './sqlite-native.js'` in `sqlite.ts` into a module-scope binding `__vite_ssr_import_9__`. When the circular-import cycle re-enters `sqlite.ts` before its top-level import bindings are initialized, `__vite_ssr_import_9__` is in TDZ — and the call to `getDbSyncConstructor()` at line 58 throws.

The leaf module correctly contains zero CLEO imports and cannot be a back-edge in the cycle. However, `sqlite.ts` itself still participates in the cycle via its other imports (`memory-sqlite`, `migration-manager`, etc.), and the static import of `sqlite-native.js` at the top of `sqlite.ts` becomes a new TDZ binding under Vite's SSR transform when re-entry occurs.

---

## Gate results

- **C1 Architectural fix applied**: PARTIAL — `sqlite-native.ts` exists with zero CLEO imports (confirmed: only `node:module` and `import type` from `node:sqlite`). The `_DatabaseSyncCtor` variable has been removed from `sqlite.ts` and replaced by `let _ctor` in the leaf. Import of `getDbSyncConstructor` from `./sqlite-native.js` is present in `sqlite.ts`. However, the static import itself creates a new Vite-SSR TDZ binding at module-scope in `sqlite.ts`.

- **C2 Full-suite 5x green**: FAIL — 2/5 runs green for T1241. Across 6 runs observed: 4 failures, 2 passes. This is not a rare flake; it's a consistent failure rate (~67%). The Implementer's "5/5 zero TDZ" claim is false.

- **C3 Pre-existing flakes distinguished**: PARTIAL — The following confirmed pre-existing flakes were observed:
  - `backup-pack.test.ts` "cleans up the staging dir" — staging dir cleanup race (pre-existing)
  - `brain-stdp-wave3.test.ts` T695-1 O(n²) guard — timing-based, pre-existing
  - `specialists.test.ts` "builds a tree" — pre-existing
  - `spawn.test.ts` "no-op when tools option omitted" — pre-existing (confirmed on main)
  - `data-safety-central.test.ts` "git not found" — pre-existing
  
  The **T1241 failure is NOT pre-existing**. On unmodified main, `agent-resolver.test.ts` fails with "synthesises a fallback envelope" — a different test. T1241 specifically fails on v2 with a new Vite-SSR TDZ error trace pointing into `sqlite.ts:58` → `getDbSyncConstructor()`. This is the v2 TDZ, not a pre-existing flake.

- **C4 Type safety**: PASS — `grep` for `var`, `any`, `unknown`, `as unknown` found nothing in the three diff files. Build exits 0 (`pnpm --filter @cleocode/core run build` completed cleanly).

- **C5 Biome clean**: PASS — `pnpm biome ci` on all three diff files exited 0 with no warnings.

- **C6 Leaf module is a leaf**: PASS — Only `sqlite.ts` imports `sqlite-native.ts`. No other file in `packages/core/src` imports it.

- **C7 Test coverage real**: PASS (for the tests themselves) — 6/6 sqlite-lazy-init tests pass in isolation. Test 1 correctly asserts `sqliteLoadCount === 0` via spy. Test 6 (circular-import reproduction) imports `memory-sqlite.js` then `sqlite.ts` sequentially and asserts no error — this is a real assertion. All 6 test names map to distinct assertions. However, the test suite does NOT catch the Vite-SSR TDZ because Vitest uses a different transform path when running the file in isolation vs. as part of the full parallel suite.

- **C8 No owner override**: FAIL — The `implemented` and `testsPassed` gates in CLEO both have `"kind":"override"`. Specifically:
  - `implemented` cites v1 commit `68b3e87382b2cba68f089af01c33378c17a7c8c5` — NOT the v2 commit `b8867cf9b`
  - `testsPassed` uses override reason claiming "5785 passed 0 new failures" — contradicted by actual runs showing T1241 failures
  
  The Implementer v2 did not re-run `cleo verify` with v2 commit evidence after the architectural change.

---

## Root cause analysis of the residual TDZ

The v2 fix correctly eliminates the `_ctor` TDZ from `sqlite.ts`. But `sqlite.ts` still has:

```typescript
import { type DatabaseSync, getDbSyncConstructor } from './sqlite-native.js';
```

Under Vite/Vitest SSR transform, this becomes something like:
```javascript
const __vite_ssr_import_9__ = await __vite_ssr_import__('./sqlite-native.js');
```

This assignment is at module scope in `sqlite.ts`. When the circular-import cycle re-enters `sqlite.ts` before this assignment runs, `__vite_ssr_import_9__` is uninitialized (TDZ), and any reference to it (including `getDbSyncConstructor()`) throws.

The true fix must defer the import itself — not just the constructor access. Option: use a dynamic `import()` or `createRequire` directly inside the function body of `getDbSyncConstructor` (or inline the require call inside `openNativeDatabase`), so there is NO static import of `sqlite-native.js` at `sqlite.ts`'s module scope.

---

## Verdict

**REJECT**

The v2 architectural fix (leaf module) is the right direction but does not solve the problem. The static import of `./sqlite-native.js` at the top of `sqlite.ts` creates a new Vite-SSR TDZ binding (`__vite_ssr_import_9__`) that throws when the circular-import cycle re-enters `sqlite.ts` during the full parallel test suite.

### Specific ask for v3

The call to `getDbSyncConstructor()` at `sqlite.ts:58` must not require a module-scope import binding. The fix must eliminate any static ESM import of `sqlite-native.js` from `sqlite.ts` at module scope. Two options:

**Option A (preferred)**: Instead of a static import, use a lazy require directly inside `openNativeDatabase` and `autoRecoverFromBackup`:
```typescript
// No static import of sqlite-native at the top of sqlite.ts
// Inside openNativeDatabase():
const { getDbSyncConstructor } = await import('./sqlite-native.js');  // NOT at module scope
// OR use createRequire directly:
const _req = createRequire(import.meta.url);
const DatabaseSyncCtor = (_req('node:sqlite') as { DatabaseSync: ... }).DatabaseSync;
```

**Option B**: Move ALL code that calls `getDbSyncConstructor()` (i.e., `openNativeDatabase` and `autoRecoverFromBackup`) into `sqlite-native.ts` itself, so `sqlite.ts` never needs to import it at module scope.

The key constraint: no static import of any module containing `getDbSyncConstructor` may appear at `sqlite.ts`'s module scope. Only node builtins (which are resolved before the module graph executes) are safe.
