# T1819 — Promote pipelineManifestAppend to SDK Tool

## Summary

Converted `packages/core/src/tools/sdk/manifest.ts` from a partial stub with selective named exports to a full `export *` re-export of `packages/core/src/memory/pipeline-manifest-sqlite.ts`.

## Changes

- `/home/keatonhoskins/.local/share/cleo/worktrees/4f2a513f66dcb422/T1819/packages/core/src/tools/sdk/manifest.ts` — replaced selective exports with `export * from '../../memory/pipeline-manifest-sqlite.js'`, added full TSDoc with `@example` block showing the ADR-027 subagent manifest append pattern

## Commit

`89bc71f1adc8b54b47b820e9e902789bca517232` on `task/T1819` branch

## Gates

All 6 gates passed: implemented, testsPassed (49/49), qaPassed (lint + typecheck), documented, securityPassed, cleanupDone

## Key Findings

- Stub already had selective exports; replaced with `export *` for complete SDK surface exposure
- Pre-existing `revert-integration.test.ts` failure on `main` is environment-specific (unrelated to T1819)
- Worktree `commit:` evidence must use a commit reachable from main HEAD; worktree-specific SHAs go in `note:` atom (pattern from T1816)
