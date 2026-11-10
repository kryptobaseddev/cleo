---
id: file-level-affected-tests
tasks: [T14366]
kind: feat
summary: "PR unit shards and tool:test-affected run the test files whose import graph reaches the change, and cleo nexus affected --base <ref> reports them"
---

Affected test selection was package-level: any change to core selected every
test of core and of every package that depends on it, so a PR's unit shards
took as long as main's.

- `selectAffectedTestFiles` (core `tasks/affected-tests`) walks the static
  import graph of the checkout from each changed module, through its
  importers and by name through re-exports, to the test files that reach it.
  It reads no NEXUS index and no build output, so it works on a fresh CI clone.
- It returns `mode: full` with a reason, and the caller falls back to
  package-level selection, when the graph cannot speak for the change: a root
  config or lockfile, a changed file that is not an importable module (a
  migration, fixture or template), a changed module no test reaches, or more
  than 1,200 selected files.
- Tests that read source trees or spawn processes run whenever their package
  is affected, tests naming another package's tree whenever any package is,
  and the root `scripts` tests always.
- `scripts/ci-affected-test-projects.mjs` passes the files to vitest as file
  filters; `tool:test-affected` with a `{projects}` template names them in
  place of the projects. Main, nightly, merge-group and dispatch runs stay full.
- `cleo nexus affected --base <ref>` reports the selection, the vitest
  projects that collect it and the changed modules' exported symbols as one
  LAFS envelope.
