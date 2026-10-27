---
id: branch-integration-module
tasks: [T10862, T10863, T10864]
kind: refactor
summary: "Branch integration (merge, fetch, landed-detection, the merge decision) moves out of the branch-lock lifecycle module"
---

`packages/core/src/spawn/branch-integration.ts` now owns default-branch
resolution, upstream fetch and landed-detection, the integration decision and
plan, the `--no-ff` merge of `task/<id>` (ADR-062) and its audit row:
`getDefaultBranch`, `assessUpstreamIntegration`, `planWorktreeIntegration`,
`completeAgentWorktreeViaMerge`, `completeAgentWorktreeIntegration` and
`integrationOutcome`. `branch-lock.ts` keeps worktree lifecycle, shims and
filesystem hardening only. The move is verbatim; the public barrels export the
same names, and core callers import from the new module.
