# T1140 — Worktree-by-Default Spawn Prompts (Lead D Implementation)

**Task**: T1140 — Meta-A: cleo orchestrate spawn must emit worktree-by-default worker prompts  
**Date**: 2026-04-22  
**Branch**: task/T1140  
**Commit**: 2f1a8a591e5aece15433797346e0aebc9a8bd077

## Summary

Implemented worktree-by-default spawn prompt emission for `cleo orchestrate spawn`. Every agent spawn now gets an explicit `## Worktree Setup (REQUIRED)` section in the prompt body, routes worktree creation through the SDK dispatch layer, supports `--no-worktree` opt-out with audit logging, and documents the new behavior in CLEO-INJECTION.md.

## Changes Shipped

### packages/core/src/orchestration/spawn-prompt.ts
- Added `worktreePath?: string` and `worktreeBranch?: string` to `BuildSpawnPromptInput`
- Added `buildWorktreeSetupBlock()` function that generates the `## Worktree Setup (REQUIRED)` section with context-isolation text "authorized only within `<path>`" and FIRST ACTION directive
- Inserted the section after Session Linkage in the prompt body (step 5 in section order)
- Added `WORKTREE_PATH` and `WORKTREE_BRANCH` to the token map for template use

### packages/core/src/orchestration/spawn.ts
- Added `worktreePath?: string` and `worktreeBranch?: string` to `ComposeSpawnPayloadOptions`
- Passes them through to `buildSpawnPrompt`

### packages/cleo/src/dispatch/engines/orchestrate-engine.ts
- Replaced inline `createAgentWorktree/buildWorktreeSpawnResult` (from `@cleocode/core/internal`) with `spawnWorktree` from `worktree-dispatch.ts` (SDK-first per D023 / ADR-055)
- Added `noWorktree?: boolean` parameter to `orchestrateSpawn`
- When `--no-worktree`: logs INFO + writes audit entry via `accessor.appendLog`
- When provisioning: extracts `worktreePath` and `worktreeBranch` from `CreateWorktreeResult.path/.branch`
- Passes `worktreePath/worktreeBranch` to `composeSpawnForTask` so the prompt section is emitted in-body
- Builds backward-compat `WorktreeSpawnResult` shim for harness adapters that read `worktree/worktreeEnv/worktreeCwd`

### packages/cleo/src/dispatch/domains/orchestrate.ts
- Extracts `noWorktree` from dispatch params and threads to `orchestrateSpawn`

### packages/cleo/src/cli/commands/orchestrate.ts
- Added `--no-worktree` boolean flag to the `spawn` subcommand with description

### packages/core/src/internal.ts
- Exported `listProjectWorktrees`, `pruneWorktreesForProject`, `spawnWorktree`, `teardownWorktree`, `warmupWorktreeBackend` from `./sentient/worktree-dispatch.js`

### packages/core/templates/CLEO-INJECTION.md
- Added `--no-worktree` row to Orchestration table
- Added new `## Worktree-by-Default (T1140 · ADR-055)` section documenting D029 canonical path, context-isolation contract, FIRST ACTION pattern, and --no-worktree opt-out

### packages/core/src/orchestration/__tests__/spawn-prompt.test.ts
- Added 5 new tests for T1140 worktree setup section:
  - Emits section when `worktreePath` provided
  - Omits section when `worktreePath` absent (--no-worktree path)
  - Uses default branch name `task/<taskId>`
  - Injects WORKTREE_PATH/WORKTREE_BRANCH tokens
  - Verifies section ordering (after Session Linkage, before File Paths)

## Gate Results

- `implemented`: override (commit on task branch, not yet cherry-picked to main)
- `testsPassed`: 60 spawn-prompt tests pass (test-run:/tmp/vitest-T1140.json)
- `qaPassed`: biome CI clean (1840 files, 0 errors), tsc exit 0
- `documented`: CLEO-INJECTION.md updated
- `securityPassed`: internal spawn path changes, no network surface
- `cleanupDone`: node_modules symlinks not committed

## Key Findings

1. The old pattern (T1118) prepended the `## BRANCH ISOLATION PROTOCOL` block BEFORE the prompt. T1140 moves the worktree context INTO the prompt body as a named section after Session Linkage.
2. The `CreateWorktreeResult` (SDK) is flat (`path`, `branch` top-level) vs `WorktreeSpawnResult` (branch-lock) which has a nested `worktree` object. A backward-compat shim is built in the engine.
3. Pre-existing test failure in `brain-stdp-wave3.test.ts` (timeout) is unrelated to these changes; all 1290 orchestration-relevant tests pass.
4. Biome requires alphabetically-sorted export blocks — the worktree-dispatch exports in internal.ts were auto-fixed to `l, p, s, t, w` order.
