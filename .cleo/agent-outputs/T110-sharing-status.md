# T110 — Enhance SharingStatus with git sync fields

**Status**: complete
**Date**: 2026-03-22

## Summary

Added four git sync state fields to the `SharingStatus` interface and updated
`getSharingStatus` to populate them by inspecting the `.cleo/.git` isolated repo.

## Changes

### `packages/core/src/nexus/sharing/index.ts`

- Added import of `cleoGitCommand` and `isCleoGitInitialized` from
  `../../store/git-checkpoint.js`.
- Extended `SharingStatus` interface with four new fields:
  - `hasGit: boolean` — whether `.cleo/.git/HEAD` exists (uses `isCleoGitInitialized`).
  - `remotes: string[]` — git remote names from `git remote` output.
  - `pendingChanges: boolean` — whether `git status --porcelain` returns any output.
  - `lastSync: string | null` — ISO timestamp parsed from the reflog for the most recent
    fetch/push/pull action, or `null` if none found.
- Added three private helpers with TSDoc:
  - `getCleoGitRemotes(cleoDir)` — runs `git remote`, splits on newlines.
  - `hasCleoGitPendingChanges(cleoDir)` — runs `git status --porcelain`.
  - `getLastSyncTimestamp(cleoDir)` — scans `git reflog --format=%gs %ci HEAD` for
    fetch/push/pull lines and parses the trailing ISO date.
- Updated `getSharingStatus` with full TSDoc (`@remarks`, `@example`, `@task`).
  Git fields are populated in parallel via `Promise.all` only when `hasGit` is true;
  all git commands are non-fatal (errors produce safe defaults).

### `packages/core/src/__tests__/sharing.test.ts`

- Added two new `getSharingStatus` tests:
  1. `returns safe defaults for git sync fields when .cleo/.git does not exist` —
     asserts `hasGit=false`, `remotes=[]`, `pendingChanges=false`, `lastSync=null`.
  2. `reports hasGit=true when .cleo/.git/HEAD exists` — creates a stub `.git/HEAD`
     file and asserts `hasGit=true` with correct types for the other fields.

## Quality Gates

- `pnpm biome check --write` — passed (1 file reformatted, no errors).
- `pnpm run build` — passed (`Build complete`, warnings pre-existing).
- `pnpm run test` — passed (272 test files, 4784 tests, 0 failures).
  All 11 sharing-related tests pass, including the 2 new ones.

## Design Notes

- No new dependencies — reuses `cleoGitCommand` from `git-checkpoint.ts` which
  already suppresses all git errors and handles the `GIT_DIR` / `GIT_WORK_TREE`
  environment setup for the isolated `.cleo/.git` repo.
- The `lastSync` timestamp is derived from the reflog rather than a custom state
  file, so it accurately reflects actual push/pull activity with zero extra I/O.
- All git I/O runs in parallel with `Promise.all` to keep `getSharingStatus` fast.
