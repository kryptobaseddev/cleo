---
id: t13280-exclusion-filter
tasks: [T13280]
kind: fix
summary: cleo run's whole-suite guard follows pnpm's filter semantics for exclusions (--filter '!foo' selects every other package) and strips quotes inside package scripts
---

`pnpm --filter '!foo' test` runs the test script of every workspace package except
`foo`. The guard used to treat an exclusion as matching nothing, so it let that run
through. It now follows pnpm:

- the selected packages are the union of the positive selectors, or every package when
  there are only exclusions, minus the excluded packages;
- an exclusion that matches precisely, by name, name glob or path, is subtracted;
- a graph or git exclusion such as `!foo...` subtracts nothing, because its exact set is
  unknown here and subtracting a guess could only refuse less.

Words inside a package script lose one layer of surrounding quotes, so a script that
runs `pnpm --filter "@x/a" run test` is matched against package `@x/a`.
