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

A change touching only root config (for example `.cleo/project-context.json`)
could never satisfy testsPassed or qaPassed without whole-repo runs: a
targeted test-run and a qa-run were refused as workspace-wide, and qa-run
needed a typecheck + lint pair. A change made only of non-code paths
(documentation, or a JSON/YAML/TOML file at the root or in a top-level
dot-directory that is not a toolchain config such as `package.json`,
lockfiles, `tsconfig*.json` or `biome.json`) now has a sanctioned path:

- `tool:test` records not applicable, with the paths, and runs nothing; it
  stands for a code task.
- A `qa-run` lint (or structural) receipt whose roots hold the files stands
  for qaPassed alone, with no typecheck owed.
- `cleo done --plan` plans exactly that.

A change that also touches code keeps every existing requirement.
