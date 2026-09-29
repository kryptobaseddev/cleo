---
id: git-shim-skip-pnpm-bin-wrapper
tasks: [T12652]
kind: fix
summary: git-shim no longer treats pnpm's `.bin/git` wrapper as real git, so `pnpm exec` from packages/core stops failing with "recursive executable delegation refused"
---

`@cleocode/core` depends on `@cleocode/git-shim`, so pnpm installs
`packages/core/node_modules/.bin/git`. That file is a shell wrapper that runs
`node "$basedir/../@cleocode/git-shim/dist/shim.js"`. It is a regular file
with its own inode, so the shim's realpath and inode checks did not recognise
it. `pnpm exec` puts that directory first on PATH, so the shim chose the
wrapper as real git and re-entered itself. The second hop then refused the
recursion and every git call failed. Under `pnpm exec` from `packages/core`,
all 15 tests in `init-nested-git-root.test.ts` failed.

`resolveRealGit` now reads small text candidates (no NUL byte, 64 KiB or
less). It expands `$basedir`, `%~dp0`, `%dp0%` and `$PSScriptRoot` to the
directory each candidate was found in, and skips any launcher whose `.js`,
`.mjs` or `.cjs` target resolves to this shim or to a copy already in the
delegation chain. Launchers for other tools, and real git binaries, are still
accepted.
