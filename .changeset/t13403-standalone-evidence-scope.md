---
id: t13403-standalone-evidence-scope
tasks: [T13403]
kind: fix
summary: a single-package project (no workspace declared) is one package, so a targeted test-run of the changed test files satisfies testsPassed and `cleo done --plan` proposes it instead of a whole-suite tool:test
---

A project with a root `package.json` and no `pnpm-workspace.yaml` or
`package.json#workspaces` had no packages at all. Every changed path fell
outside them, the evidence scope became `full`, every `test-run:` report was
refused with `E_EVIDENCE_INSUFFICIENT`, and `cleo done --plan` proposed a
whole-suite `tool:test`.

- The named root `package.json` is now the project's one package when the
  CLEO root is its git top level. Changes inside the root map to it; docs stay
  ignored; a path outside the root still makes the scope `full`. A CLEO root
  in a subdirectory of its checkout keeps the old behaviour (`full`).
- A `test-run:` report binds under the same per-package rule a workspace
  package uses, and in a single-package project it must also pass every test
  file the change adds or edits. An unrelated or partial report is refused.
- `cleo done --plan` reports a `test-run-needed` blocker naming the changed
  test files when they exist, instead of planning `tool:test` or
  `tool:test-affected`, which both run the whole suite there.

Workspaces (pnpm, npm/yarn `workspaces`) are unchanged.
