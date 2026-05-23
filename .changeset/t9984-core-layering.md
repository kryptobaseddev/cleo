---
id: t9984-core-layering
tasks: [T9984]
kind: feat
summary: "packages/core consumes packages/worktree exclusively (no raw git-worktree shell-outs)"
---

feat(T9984): packages/core consumes packages/worktree exclusively (no raw git-worktree shell-outs)

- `docs/publish-pr.ts`: inline `git worktree add` / `git worktree remove` → `@cleocode/worktree.addTransientWorktree` / `removeTransientWorktree`
- `spawn/branch-lock.ts`: paths-SSoT violation (`createHash('sha256')` + `process.env['XDG_DATA_HOME']`) → `@cleocode/paths` (`computeProjectHash`, `resolveWorktreeRootForHash`); raw provisioning retained for legacy sync test-fixture surface (production hot-path already routes through `@cleocode/worktree` via `sentient/worktree-dispatch.ts`)
- New `@cleocode/worktree` exports: `addTransientWorktree` + `removeTransientWorktree` — the legitimate escape hatch for non-canonical worktree locations (docs-PR temp tree in tmpdir)
- `scripts/lint-no-raw-git-worktree.mjs`: CI gate that rejects raw `git worktree` shell-outs outside `@cleocode/worktree`. Allowlist scoped to `packages/worktree/`, `packages/git-shim/`, build/release scripts, plus 4 named SDK primitives in `packages/core/src/worktree/`
- CI workflow `Raw Git Worktree Lint (T9984)` added to `.github/workflows/ci.yml`
- Integration test `spawn-pipeline-worktree.test.ts` — exercises the spawn pipeline end-to-end against the napi-backed `@cleocode/worktree` SDK (4 cases: canonical XDG path, banned location rejection, clean destroy, branch isolation)

Closes T10035, T10036, T10037, T10038, T10039.
Saga: T9977
Decision: D010
