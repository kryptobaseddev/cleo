---
id: t13522-git-shim-install
tasks: [T13522]
kind: fix
summary: "Worker worktrees install the git shim they advertise, block pushes to main, and say `unavailable` when the shim cannot be installed"
---
Worker worktrees set `CLEO_BRANCH_PROTECTION=strict` and put `.cleo/bin/git-shim` first on PATH. But `ensureGitShimDir` had no callers, so the directory never existed and workers ran the real git unguarded (axiom T1804). Its resolver also looked only in the project's node_modules, which a standalone project does not have.

- **Install on every spawn.** `spawnWorktree`, the spawn chokepoint for both spawn paths, now installs the shim before creating the worktree.
- **Resolve from the CLI install.** `ensureGitShimDir` resolves the shim from the `@cleocode/git-shim` package the running CLI was installed with (`resolveShimBinPath()`). It writes the launcher, checks the launcher is executable, and returns `{dir, installed, shimBinPath, reason}`.
- **No more stub.** The weaker inline stub is gone. If the real shim cannot be installed, nothing is installed.
- **Honest advertising.** `createWorktree` takes the result as `gitShim`. It advertises `strict` and prepends the shim to PATH only when the shim is installed. Otherwise the env says `CLEO_BRANCH_PROTECTION=unavailable`, and the worker preamble says the git rules are not enforced.
- **Block pushes to main.** The shim now refuses, with exit 77, a restricted role's `git push` whose destination is `main` or `master` in any refspec spelling (`main`, `HEAD:main`, `+refs/heads/main`, …). It also refuses `push --all` and `push --mirror`: worker worktrees share refs, so these would push main or force-update and delete remote refs (T13533). Beyond these quick argument checks, the shim resolves where a worker's push really goes by rerunning it as `git push --dry-run --porcelain --no-verify` with the worker's own global options, arguments and config. It refuses when any destination git reports is `refs/heads/main` or `master`, or when the dry run fails. This catches pattern refspecs (`refs/heads/*:refs/heads/*`), configured or `-c` `remote.<r>.push` targets, bare pushes to a protected upstream, and global options the argument parser does not know (T13535). A leading option the shim does not recognise, which might take a value and hide the real command, is refused outright for a worker (bypass with `CLEO_ALLOW_GIT=1`, audited).
- **Global options no longer hide the subcommand.** The shim finds the subcommand after git's global options, so `git -C dir push …` and `git -c k=v push …` no longer skip every rule.
- **SDK helper is honest too.** `buildWorktreeSpawnResult` accepts the `ensureGitShimDir` result and says `unavailable` when the shim is not installed. The contracts `CLEO_BRANCH_PROTECTION` type gains `unavailable`.

The launcher lives under `.cleo/bin/`, which the deny-by-default `.cleo/.gitignore` already ignores.
