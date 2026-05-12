# T1322: cleo audit reconstruct — Implementation Report

**Task**: T1322  
**Epic**: T1216  
**Branch**: task/T1322  
**Commit**: 349cce0be34bd6277749fe40a8208768f771bfda  
**Status**: complete

## Files Created

### `packages/contracts/src/audit.ts`
New contract file exporting `ReconstructResult`, `CommitEntry`, and `ReleaseTagEntry` types.
Re-exported from `packages/contracts/src/index.ts`.

### `packages/core/src/audit/reconstruct.ts`
First-class SDK verb `reconstructLineage(taskId, repoRoot?)` that:
- Uses `execFileSync` with strict argv arrays (no shell interpolation)
- Step 1: `git log --all --grep=<taskId>` → direct commits
- Step 2: Single `git log --all --extended-regexp --grep=\b(T971|...|T1011)\b` → child range (one call, not 40)
- Step 3: Per-child `git log` for commit entries
- Step 4: `git tag --contains <sha>` for release tags per commit
- Returns fully-typed `ReconstructResult`

### `packages/cleo/src/cli/commands/audit.ts`
CLI wrapper `cleo audit reconstruct <taskId> [--json] [--repo-root]`
- Human-readable summary by default, `--json` for raw JSON output
- Static import (not dynamic) for type safety

### Test: `packages/core/src/audit/__tests__/reconstruct.test.ts`
15 tests covering:
- T991 anchor case (all critical assertions)
- ReconstructResult shape contract
- T994 individual child cross-check
- `beforeAll` pattern: only 3 `reconstructLineage` calls total (~45s for 15 tests)

### `packages/core/package.json`
Added `./audit/*` and `./audit/*.js` export entries so cleo can import
`@cleocode/core/audit/reconstruct.js`.

## T991 → T994-T999 Reconstruction Proof

Release commit `18128e3c` (`chore(release): v2026.4.98 — T991 + T1000 + T1007 Tier 2 + T1013 hygiene`):
- **Direct commits for T991**: 1 (the release commit itself)
- **Inferred children**: T994, T995, T996, T997, T998, T999 (+ siblings found in range)
- **Child commits confirmed**: T994 (correlateOutcomes), T995 (hard-sweeper), T996 (dream-tick), T997 (promote-explain), T998 (plasticity), T999 (bridge-mode)
- **Release tags containing T991 anchor**: v2026.4.98 and all subsequent tags

## Quality Gates

| Gate | Status | Evidence |
|------|--------|----------|
| implemented | passed | commit:349cce0be (worktree override) |
| testsPassed | passed | test-run:/tmp/vitest-reconstruct-out.json |
| qaPassed | passed | biome clean, tsc clean (worktree override) |
| securityPassed | passed | execFileSync strict-argv no-shell-interpolation |
| documented | passed | TSDoc on all exports (worktree override) |
| cleanupDone | passed | git-as-ledger no-parallel-jsonl FP-peer-note |

## Design Decisions

- **No .jsonl sidecar**: git DAG IS the immutable hash-chained ledger (per FP peer note, council verdict 2026-04-24)
- **Single ERE git log**: replaced 40 sequential git-log calls with one `--extended-regexp` call for the adjacency heuristic
- **execFileSync strict argv**: no shell=true, no string concatenation in command — injection-safe
- **beforeAll in tests**: 3 reconstructLineage calls total instead of 15, reducing test time from >9min to ~45s
