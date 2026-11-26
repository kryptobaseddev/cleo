---
id: cant-validate-s04-imported-spans
tasks: [T14642]
kind: fix
summary: "cleo cant validate reports missing imports (S04), reports diagnostics from imported files at their own file and line, and warns when an old cant-napi binary cannot run the import rules"
---

- S04 (import target existence) now runs in the import-graph walk: an import
  that resolves to no file is an error naming the import and the line.
- A diagnostic raised in an imported file (S12 on its agent, S03/S04/S09/S10
  on its own imports) carries that file's path in `file` with its own
  line/col, through the napi binding and `compileBundle`'s `sourcePath`.
- New napi entry point `cantValidateFile(content, filePath)`. An addon without
  it ignores `filePath` silently, so `validateDocument` then runs only the
  single-document rules, returns `importRulesRun: false`, and
  `cleo cant validate` warns once (`W_CANT_IMPORT_RULES_NOT_RUN`).
- `cleo cant validate --help` now says all 42 numbered rules run.
