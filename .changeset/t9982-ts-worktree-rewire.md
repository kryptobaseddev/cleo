---
id: t9982-ts-worktree-rewire
tasks: [T9982]
kind: feat
summary: "packages/worktree rewired to @cleocode/worktree-napi"
---

feat(T9982): packages/worktree rewired to @cleocode/worktree-napi

The TS worktree subsystem now calls into Rust for ALL hot paths:

- `copyPathsWithReflock` → `napi.copyPathsParallel` (4-thread rayon + reflink,
  replaces 150-LOC sequential `execFile('cp')` per leaf).
- `loadWorktreeIncludePatterns` → `napi.readWorktreeInclude` (real
  `ignore::gitignore` matching, fixes the existsSync-on-literal-pattern
  correctness bug). Canonical file is now `.worktreeinclude` at the project
  root (multi-language native); legacy `.cleo/worktree-include` is still read
  via a one-cycle deprecation shim that emits `process.emitWarning`.
- `destroyWorktree` → `napi.destroyWorktree` (`git worktree remove` plumbing
  in Rust; audit-log + sentinel-index work stays TS).
- `listWorktrees` → `napi.listWorktrees` (single Rust call for the porcelain
  parse; the prior N+1 `git rev-parse` loop is gone). Classification stays in
  TS because it consumes the tasks DB.

REMOVED: the hardcoded `['node_modules', 'packages/*/dist']` bootstrap copy
block in `worktree-create.ts`. Projects that need those paths mirrored MUST
now declare them in `.worktreeinclude`. The default is "copy nothing" — the
spawn pipeline no longer pays a 1.9 GB / 69k-file blast-radius cost on every
agent provision. This is the consumer-side fix that finally unblocks the 60s
spawn-timeout bug.

REMOVED: `packages/worktree/src/compat.ts` (legacy `LegacyWorktree*` shim).
Verified zero external consumers across the monorepo.

Saga: T9977
Decision: D010
Closes: T10019, T10020, T10021, T10022, T10023, T10024, T10025, T10026, T10027, T10028
