# T1857 Complete: cleo deps validate + cleo deps tree

**Task**: T1857 — T1855-2: cleo deps validate + cleo deps tree commands
**Status**: done
**Merge commit**: d75e157826b3774c578d17cf886eee5c877c4bfb
**Unblocked**: T1858, T1859

## What Was Delivered

### New CLI commands

- `cleo deps validate [--epic <id>] [--scope all|open|critical]` — runs orphan/circular/cross-epic-gap/stale-dep detection (tier-0, no LLM)
- `cleo deps tree --epic <id> [--json] [--mermaid]` — renders dep-graph tree with critical path highlighted

### Key files

| File | Purpose |
|------|---------|
| `packages/core/src/tasks/dep-graph-validator.ts` | Pure validation engine: detectOrphans, detectCircularDeps (delegated), detectCrossEpicGaps, detectStaleDeps, validateDepGraph, runValidation |
| `packages/cleo/src/cli/commands/deps.ts` | validateCommand + depsTreeCommand subcommands added to existing depsCommand |
| `packages/cleo/src/dispatch/domains/tasks.ts` | deps.validate + deps.tree dispatch handlers |
| `packages/core/src/tasks/task-ops.ts` | taskDepsValidate + taskDepsTree functions |
| `packages/contracts/src/operations/tasks.ts` | TasksDepsValidateParams/Result + TasksDepsTreeParams/Result + DepsTreeNode/Edge types |
| `packages/cleo/src/cli/commands/__tests__/deps-validate.test.ts` | 19 vitest tests covering all issue types |

### Test results

- 19 deps-validate tests: all passing
- Full cleo package test suite: 2220 tests, 133 files passed
- Full monorepo: 765 test files, 12655 passed (1 pre-existing revert-integration failure on main, not related)
- biome check: clean
- typecheck: clean

## Implementation Notes

### Rebase conflict resolved

The WIP commit had a trivial conflict in `packages/contracts/src/index.ts` when rebasing onto local main (which was 2 commits ahead of origin/main due to T1815 merge). The conflict was:
- T1857 branch added `DepGraphIssue` export and a `// T1857 —` comment
- main had neither
- Resolution: kept both additions

### @cleocode/paths build required

T1882 added `@cleocode/paths` as a new package. The worktree's node_modules linked it correctly but the `dist/` directory was absent. Running `pnpm --filter @cleocode/paths run build` resolved the test runner import failure.

### Verification workflow

Since the worktree commits were not reachable from the main project's HEAD (task/T1857 branch had to be merged first), the `implemented` gate used the merge commit SHA `d75e15782` rather than the individual WIP commit SHA. The worktree was merged via `git merge --no-ff` per ADR-062.

## Gates

| Gate | Evidence |
|------|---------|
| implemented | commit:d75e15782 + file sha256 hashes |
| testsPassed | tool:test (765 files, 12655 passed) |
| qaPassed | tool:lint + tool:typecheck |
| documented | files:packages/core/src/tasks/dep-graph-validator.ts (TSDoc on all exports) |
| securityPassed | note:read-only CLI command no network surface |
| cleanupDone | note:WIP consolidated; dependency-check.ts preserved |
