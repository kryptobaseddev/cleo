---
id: derived-project-root-and-briefing-identity
tasks: [T12557, T12559]
kind: fix
summary: "Moving a project no longer breaks `cleo docs add`. A persisted projectRoot/projectHash is ignored, init stops writing projectHash, `doctor project-identity --resolve` strips legacy copies, and `cleo briefing` warns about identity problems"
---
**`cleo docs add` failed projection after any move.** `.cleo/project-info.json`
can hold an absolute `projectRoot`. `cleo project move` writes one, and older
Linux stores have `/mnt/...` values. `captureDocumentProjection` and five
knowledge-repair scope checks compared that string with the real root. After a
`mv`, every docs projection returned `coverage: missing` with "Canonical
project-info root differs from the captured project root".

- Identity is the `projectId`. Docs projection and `doctor knowledge` no longer
  compare against a persisted `projectRoot`.
- `projectRoot` and `projectHash` are derived at runtime. `cleo init`, the
  project-info regenerator used by restore, and the scaffold check no longer
  write or require `projectHash`. The schema no longer requires it. A legacy
  persisted `projectHash` is still read, so existing correlation and release
  keys do not change. When it is absent, the reader derives it from the root.
- `cleo doctor project-identity` lists persisted `projectRoot`/`projectHash`
  fields in `project-info.json` and `project-context.json` under
  `derivedFields`. `--resolve` strips them. `--dry-run` shows the plan. Each
  removed value is recorded in the `strip-derived-fields` step.
- On a CLEO root that is not a git work tree, the `missing` and `invalid`
  remedies no longer tell you to run git commands.
- `cleo briefing` adds one warning with the remedy when project identity is not
  `ok`, for example when `.cleo/project-id` is missing or conflicts.
