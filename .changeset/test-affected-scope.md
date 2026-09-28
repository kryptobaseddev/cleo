---
id: test-affected-scope
tasks: [T12635]
kind: feat
summary: "`tool:test-affected` runs tests for the packages a branch diff touches plus their dependents, recorded as scope:affected; merged CI or a full run supersedes it after merge (D11150)"
---
- `deriveAffectedPackages` maps each changed path to the workspace package that
  owns its directory, then adds every dependent through the workspace graph. The
  graph reads the patterns in `pnpm-workspace.yaml` or `package.json#workspaces`,
  and follows all four dependency fields transitively. Documentation outside the
  code roots is ignored. Any other path outside the packages makes the scope
  `full`: the lockfile, root `package.json`, workspace, build or test config,
  `scripts/`, `.github/`.
- `tool:test-affected` runs `testing.affectedCommand` over that set.
  `{projects}`, `{filters}` and `{packages}` expand per package. The run goes
  through the ADR-061 cache and the heavy-tool caps as canonical `test`. The atom
  records `scope: 'affected'` and `affectedPackages`. A `full` scope, an empty set
  or a missing command is refused, pointing at `tool:test`.
- `cleo done` before merge (branch change set) plans `tool:test-affected` for
  testsPassed when a command is configured. After merge (PR change set), a
  testsPassed whose only result is an affected run counts as not passed and is
  planned again from `ci:<pr>` or `tool:test`.
- cleocode sets `testing.affectedCommand: "pnpm exec vitest run {projects}"`.
  Vitest ignores `--project` names that have no project.
- An affected run selects each affected package's own vitest project by the name
  its config declares. It always appends every project in the root vitest config
  that is not a workspace package, such as the root `scripts` project, whose
  tests read live templates and skills. The atom records `affectedProjects`, and
  `untestedPackages` for affected packages that have no project.
