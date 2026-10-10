---
id: charge-by-process-shape
tasks: [T13440, T13452]
kind: fix
summary: cleo run charges a single-process tsc one heap and a hook-free git push the light footprint, never a flat class plan
---

- **tsc (T13440).** `cleo run --class build -- tsc --noEmit` was planned and
  charged 4096 MiB × 4 workers. Two such jobs held a 48 GiB budget while a P0
  waited about 11 minutes. Now any `tsc` without `-b`, and not fanned out
  across the workspace, is charged one process: one heap and no worker slots.
  The reason recorded is `tsc without -b (one process)`. `tsc -b` and
  workspace-wide runs keep the multi-process plan.
- **git (T13452).** A `git push` run through `cleo run` was admitted as a
  24 GiB scoped-build and held half the budget for 13 minutes. git itself runs
  no heavy tool, so it is now charged the light footprint (1 GiB). The
  exception is a `git push` or `git commit` whose repository has an executable
  hook that can do work (pre-push, the commit hooks, post-merge, post-checkout,
  pre-rebase, the am hooks; `-C` and an inline `-c core.hooksPath` honoured). That keeps the
  class plan, with a reason naming the hook, because whatever the hook runs
  rides the push's admission.

`git gc`, `repack`, `fsck` and `clone` keep the class plan (they can use
gigabytes across threads), as does a git command line whose subcommand cannot
be found. A tsc under a pnpm `--filter`/`-F`/`--dir` exec is a fan-out and
keeps the class plan.
