# T1867: CLI Entrypoint env→ALS Bridge

**Task**: T1867 — wrap main() in worktreeScope.run() when CLEO_WORKTREE_ROOT env present  
**Status**: complete  
**Commit**: f66fc5734fa125a569aec0166173f07d356b69bc (branch task/T1867)

## What Was Done

Implemented the missing bridge between `CLEO_WORKTREE_ROOT` environment variable (exported by orchestrator spawn) and the AsyncLocalStorage store that `getProjectRoot()` checks first (ADR-041 §D3).

### Files Changed

1. **`packages/cleo/src/cli/index.ts`** — Primary change
   - Imported `worktreeScope` from `@cleocode/core/internal`
   - Extracted the entire CLI startup block + `runMain()` call into an async function `startCli()`
   - Added conditional `worktreeScope.run()` wrapper at module bottom: if `CLEO_WORKTREE_ROOT` is set, wrap `startCli()` in the ALS scope; otherwise call it directly

2. **`packages/core/src/index.ts`** — Export added
   - Added `worktreeScope` to the public paths export block
   - Added `export type { WorktreeScope }` for type consumers

3. **`packages/core/src/internal.ts`** — Export added
   - Added `worktreeScope` to the internal paths export block (used by CLI)
   - Added `export type { WorktreeScope }` for type consumers

4. **`packages/cleo/src/cli/__tests__/startup-migration.test.ts`** — Test updated
   - Added `worktreeScope: { run: vi.fn((_, fn) => fn()) }` to the `@cleocode/core/internal` mock so the import resolves cleanly without `CLEO_WORKTREE_ROOT` being set in tests

## Design Decisions

- **`startCli()` extraction**: The original code used a top-level `await` block `{...}`. Extracting to `async function startCli()` enables conditional wrapping without restructuring any of the startup logic. Semantically equivalent.

- **Callback, not async wrapper**: `worktreeScope.run(scope, fn)` takes a sync or async callback. Using `() => { void startCli(); }` keeps the ALS store active for the full async tree since ALS propagates through `async_hooks` into all descendant async contexts.

- **No per-command changes**: The entire async chain is wrapped at the entry point, so every downstream `getProjectRoot()` call (DB openers, path helpers, any command) transparently gets the worktree root.

## Test Results

- `packages/cleo/src/cli/__tests__/startup-migration.test.ts`: 8/8 passed
- No new test failures introduced vs main branch baseline

## ADR Connections

- ADR-041 §D3: "The spawn adapter MUST set the ALS store before invoking subagent logic; for CLI-spawned workers the entrypoint is the canonical place to do this."
- ADR-055: worktree-by-default spawn — this bridge is the missing rail that makes worktree isolation work for subprocess invocations
