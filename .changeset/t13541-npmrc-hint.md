---
id: t13541-npmrc-hint
tasks: [T13541]
kind: fix
summary: "Worktree installs always use the worktree's own pnpm store, a tracked .npmrc gets a --store-dir hint, and info/exclude no longer hides .npmrc in the main checkout"
---
Follow-up to #2108 (T13524/T13538).

- **Every provisioning install passes `--store-dir <worktree>/.pnpm-store`.** This covers both the serialized install and the build-ready install. A repo that tracks `.npmrc` therefore still installs into the worktree's own store, never the shared global one.
- **The worker gets the hint after a successful install.** When `.npmrc` is tracked, the preamble tells the worker to pass the same `--store-dir` to any later pnpm install or add. A tracked `.npmrc` cannot carry it.
- **Only `/.pnpm-store/` goes into `info/exclude` now, not `/.npmrc`.** `git rev-parse --git-path info/exclude` resolves to the COMMON `.git`, so excluding `.npmrc` hid a new `.npmrc` in the owner's main checkout as well. The tracked guard plus explicit staging covers `.npmrc`.
