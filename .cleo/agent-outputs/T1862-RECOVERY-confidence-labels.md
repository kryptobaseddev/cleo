# T1862 Recovery — Confidence Labels Rebase

## Summary

Rebased task/T1862 commit `92b13ccc5` onto current main (`3fed6c64b`), resolved one
merge conflict in `packages/contracts/src/index.ts` (preserved `DecisionsConfig` export
from HEAD, T1862 branch had diverged before that export was added), completed merge via
`git merge --no-ff task/T1862`, re-verified all gates, and completed the task.

## Rebase Result

- Old base: `d75e15782`
- New base: `3fed6c64b` (post-T1865 merge, v2026.5.28)
- New T1862 SHA: `92b13ccc5460d71764a8de72f50f398230b2a61e`
- Merge commit: `7388cce06`

## Conflict Resolution

File: `packages/contracts/src/index.ts`
Conflict: `DecisionsConfig` export present in HEAD but absent in task/T1862 branch.
Resolution: Kept HEAD version (preserved `DecisionsConfig`). T1862's confidence label
exports (`GraphEdgeConfidenceLabel`, `confidenceLabelFromNumeric`) confirmed intact.

## Gates

| Gate | Status | Evidence |
|------|--------|----------|
| implemented | PASS | commit:92b13ccc5 + 3 files |
| testsPassed | PASS | test-run JSON (157 pass, 0 fail) |
| qaPassed | PASS | tool:lint + tool:typecheck |
| documented | PASS | files:packages/contracts/src/graph.ts |
| securityPassed | PASS | note:additive contract field |
| cleanupDone | PASS | note:additive change |

## Tests

160 nexus tests passed (882ms). Biome clean on graph.ts and parse-loop.ts.
