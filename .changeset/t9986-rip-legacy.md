---
id: t9986-rip-legacy
tasks: [T9986]
kind: feat
summary: "RIP legacy worktree code (E9-RIP-LEGACY)"
---

feat(T9986): RIP legacy worktree code (E9-RIP-LEGACY)

Final cleanup pass on the worktree subsystem for Saga T9977 SG-WORKTRUNK-OWN.

- DELETE the runtime in `packages/cant/src/worktree.ts` (298 LOC, "2nd creation
  site" per T9801 audit). The file is retained as a TYPE-ONLY deprecation shim
  because `@cleocode/caamp` still imports `WorktreeHandle` as a type for its
  `SpawnOptions.worktree` / `SubagentSpawnOptions.worktree` fields. Runtime
  functions (`createWorktree`, `mergeWorktree`, `listWorktrees`,
  `resolveWorktreeRoot`) had zero production consumers and are gone.
- DELETE `packages/cant/tests/worktree.test.ts` and
  `packages/cant/tests/wave-9-empirical.test.ts` (both exercised the deleted
  runtime).
- Stop re-exporting the runtime functions from `packages/cant/src/index.ts`;
  type re-exports retained for the deprecation cycle.

Confirmed prior-PR state (no further action needed):
- `packages/worktree/src/compat.ts` deleted in PR #487.
- `packages/worktree/src/copy-on-write.ts` is a 96-LOC napi wrapper (kept for
  call-site stability — preserves `copyPathsWithReflock` signature).
- `packages/worktree/src/worktree-include.ts` is a 225-LOC napi wrapper +
  legacy `.cleo/worktree-include` deprecation reader per ADR-077 — kept for
  one-cycle deprecation.
- Hardcoded `['node_modules', 'packages/*/dist']` copy block removed in PR #487
  (only a comment remains at `worktree-create.ts:311`).
- Inline `git worktree add` in `packages/core/src/docs/publish-pr.ts` was
  rerouted in PR #489 to `addTransientWorktree` from `@cleocode/worktree`.

Final grep gate (`scripts/lint-no-raw-git-worktree.mjs`): EXIT 0. Zero raw
`git worktree` shell-outs in `packages/` outside the allowlist
(`packages/worktree/`, `packages/git-shim/`, `packages/cleo/scripts/`,
`packages/skills/internal/`) plus the four documented per-file exemptions.

Closes T10045, T10046, T10047, T10048, T10049, T10050, T10051, T10052.
Saga: T9977 (SG-WORKTRUNK-OWN)
Decision: D010
