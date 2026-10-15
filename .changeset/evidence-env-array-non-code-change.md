---
id: evidence-env-array-non-code-change
tasks: [T13744, T13745]
kind: fix
summary: "CLEO_PR_REQUIRED_WORKFLOWS reads a JSON array ([] = none); a root-config-only change has a targeted evidence path"
---

`CLEO_PR_REQUIRED_WORKFLOWS='[]'` was split on commas and read as one
workflow named `[]`, so `cleo done --plan` reported `[] NOT FOUND`. A value
that is a JSON array is now read as the list, with the same entry rules as
`release.prRequiredWorkflows`: `[]` means no required workflows. A bare name or
a comma list works as before.

A change touching only non-code files could never satisfy testsPassed or
qaPassed without whole-repo runs: a targeted test-run and a qa-run were
refused as workspace-wide, and qa-run needed a typecheck + lint pair. A change
made only of non-code paths, an allowlist of documentation and known-inert
editor or bot settings (`renovate.json`, `.editorconfig`, `.vscode/`, `.idea/`,
`.zed/`, `*.code-workspace`), now has a sanctioned path:

- `tool:test` records not applicable, with the paths, and runs nothing. It is
  pinned to the tree like a test-run, so code committed after verify voids it
  at complete. It stands for a code task.
- A `qa-run` lint (or structural) receipt whose roots hold the files stands
  for qaPassed alone, with no typecheck owed.
- `cleo done --plan` plans exactly that.

Every other path is code: `.cleo/` (it changes evidence rules), CI, deploy,
hook and toolchain configs keep every existing requirement. For such a change
outside every package, the honest route is merged CI: `ci:<pr>` with
`evidence.ciSatisfies` and `evidence.ciChecks.covering` mapping the path to the
CI job that checks it, and `cleo done --plan` now names that route.

An env value that starts with `[` but is not a JSON array of named entries is
refused as an undetermined required-check list, never read as `[]`.
