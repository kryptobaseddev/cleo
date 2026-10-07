---
id: t13277-per-package-test-scripts
tasks: [T13277, T13241]
kind: fix
summary: cleo run's whole-suite guard reads each matched workspace package's test script for pnpm -r / --filter, and follows a root script that delegates to them
---

`cleo run` refuses an unnarrowed whole-suite test run unless `--whole-suite` is passed
(T13236). For `pnpm -r test` and `pnpm --filter <selector> test` it used to read the root
`test` script. It now reads the `test` script of each matched workspace package, found
through `pnpm-workspace.yaml` or the `workspaces` field, and refuses when any of them runs
vitest without narrowing. A run across every package is the largest whole-suite case.

- An exact name, a name glob such as `@x/*`, or a path such as `./pkg` or `{pkg}` matches
  exactly those packages.
- A graph or git selector (`pkg...`, `...pkg`, `[ref]`) is treated as matching every
  package. That can only refuse more, never less.
- `-C` / `--dir` is honoured.
- A script that itself runs `pnpm -r …` or `pnpm --filter …`, such as a root `test` that
  delegates, is followed. In this repo, `pnpm test:changed` therefore now counts as a
  whole-suite run.
- `package.json` is parsed with a type guard rather than casts.
- The TSDoc of `getClaudeAgentsDir` now says not to write there, because it is user-global
  (T13241).
