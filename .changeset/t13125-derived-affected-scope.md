---
id: t13125-derived-affected-scope
tasks: [T13125]
kind: fix
summary: tool:test runs only the affected packages in a workspace without a declared affectedCommand; doctor proposes one and names ci:<pr>
---

A scope-aware `tool:test` (T12959) ran only the changed packages and their dependents when the project
declared `testing.affectedCommand`, and the whole workspace otherwise. Most workspaces never declared one: on
2026-10-03 VidaPeps (`testing.command` = `pnpm -r --no-bail --if-present run test`) ran its entire suite for
`cleo verify T1955` and again for T1956, back to back.

- When none is declared, the affected template is derived from a workspace-wide test command whose affected
  form is mechanical: `pnpm -r … test` → `pnpm {filters} … test`, `npm … test --workspaces` →
  `npm … test {workspaces}` (new placeholder: `--workspace <name>` per package), `turbo run test` →
  `turbo run test {filters}`, read through the root `test` script when the command delegates to it. It runs
  the same per-package `test` scripts on the subset; the planner still runs the full suite when a change
  touches anything outside every package. The atom says the template was derived and from what.
  `testing.preferAffected: false` still opts out (now in the schema).
- `cleo init` / `cleo detect` write the derived `testing.affectedCommand` into `project-context.json`.
- `cleo doctor` gains `affected_test_scope`: it warns about a workspace whose every `tool:test` runs the
  whole suite, proposes the derived command where one exists, and, when `evidence.ciSatisfies` is set, names
  `ci:<pr>` as the preferred testsPassed evidence.
- A whole-suite `tool:test` now records why on its atom; with `evidence.ciSatisfies` the reason, and
  `cleo done --plan`, name `ci:<pr>` as the preferred evidence.
- Regenerating `project-context.json` (`cleo detect`, `cleo upgrade`, the 30-day refresh) no longer drops the
  user's `evidence` and `release` blocks or `testing.affectedCommand` / `testing.preferAffected`. Dropping
  them silently turned off `evidence.ciSatisfies` and put evidence back on whole-suite local runs.
