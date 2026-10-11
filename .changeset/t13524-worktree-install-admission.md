---
id: t13524-worktree-install-admission
tasks: [T13524]
kind: fix
summary: "Worktree dependency installs go through the machine-wide heavy queue or are deferred to the worker; `orchestrate spawn --no-install` skips them"
---
`createWorktree` ran `pnpm install` through `installWorktreeDependencies` (behind a per-project lock only) or `ensureWorktreeBuildReady` (behind no lock at all). Neither was admitted through `cleo run`'s resource queue, and there was no way to skip the install. axiom saw it on 10.6 while a shared QA lane was active.

- **Admission.** `CreateWorktreeOptions` gains `admitInstall`. It runs before the install and resolves to a release once admitted, or to `null` when the budget is busy. `spawnWorktree`, the path every spawn takes, supplies it: a non-blocking `scoped-build` admission, the same class as `cleo run --class build`. A busy budget defers the install to the worker instead of stalling the spawn. Admission state that cannot be written fails open, as every governed run does.
- **Skip.** `CreateWorktreeOptions.skipInstall`, exposed as `cleo orchestrate spawn --no-install`, provisions without installing.
- **Envelope.** The result carries `install: {status, reason?, command?}`, surfaced as `data.install` in the spawn envelope. The status is one of `installed`, `failed`, `skipped`, `deferred` or `not-needed`. When nothing was installed, the worker preamble gives the command to run: `cleo run --wait --class build -- pnpm install --frozen-lockfile --prefer-offline --store-dir '<worktree>/.pnpm-store'`. It installs into the worktree's own store: concurrent installs into the shared global store corrupt `.pnpm/` (T9938, T13538), and deferral happens exactly when many spawns are in flight. Provisioning also writes `store-dir=<worktree>/.pnpm-store` into the worktree's `.npmrc` on the deferred and skipped paths, keeping any other `.npmrc` lines. A tracked `.npmrc` is never edited, because a dirty tracked file could be committed; there the command's `--store-dir` and a preamble line carry the store. Any later pnpm run in that worktree therefore uses its own store, and the per-worktree store is what removes the shared resource the old project lock guarded.
- **No needless admission.** A worktree with no lockfile, or one that already has node_modules, never asks for admission.
