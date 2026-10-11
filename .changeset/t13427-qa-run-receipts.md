---
id: t13427-qa-run-receipts
tasks: [T13427]
kind: feat
summary: qaPassed accepts qa-run receipts (a native typecheck or lint run, bound to the change like test-run), and a single-package project's done --plan asks for them instead of a fresh whole-project typecheck
---

A project that checks its changes with its own scoped typecheck and lint had
no way to record them: `qaPassed` accepted only `tool:` results from CLEO's own
tool cache, or merged CI. `cleo done --plan` then proposed a fresh
whole-project typecheck (with a heap sized from total RAM).

- **`qa-run:<receipt.json>`** is a new evidence atom for `qaPassed`. The
  receipt is JSON: `{kind: "typecheck"|"lint", command, exitCode,
  diagnostics: {errors}, roots, startTime?, tool?: {name, version}}`. It must
  pass (exit 0, zero errors), be fresh (the same clock as `test-run:`), and
  have roots that hold every changed code file. In a workspace, packages that
  depend on a changed package must be covered too, and a workspace-wide change
  is refused. HEAD and the tree hash are recorded; `cleo complete` refuses the
  receipt once the tree moves, unless merged CI takes over.
- `qaPassed` needs a typecheck and a lint result. Each can be a receipt or a
  `tool:` atom (a not-applicable `tool:lint` records a project with no linter).
- **`cleo done --plan`** in a single-package project: a lint or typecheck with
  no fresh cached result becomes a `qa-run-needed` blocker naming the changed
  roots, instead of a fresh whole-project run. A cached result still binds as
  `tool:`. Workspaces keep planning their tool runs.

What a receipt does not prove: it is a file the caller supplies, and a scoped
typecheck does not see unchanged files that import a changed export. Merged
CI or a whole-project `tool:typecheck` speaks for the whole program.
