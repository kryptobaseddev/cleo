---
id: docs-publish-dry-run-checks
tasks: [T13919, T12583]
kind: fix
summary: "docs publish --dry-run runs the real checks, and an outside-root destination is refused with E_VALIDATION_ERROR in both modes"
---

`cleo docs publish --to <path outside the project root> --dry-run` reported
success because the file dry run only echoed its arguments; the real run then
failed `E_INTERNAL` asking for `allowOutsideRoot`, which the CLI does not
expose (Axiom repro; T12583 from a worktree). The file dry run now goes
through `publishDocs` with `dryRun`, which resolves the owner, attachment and
bytes and applies the same containment check (the project root or a
registered canonical task worktree, T13376) and writes nothing. An outside
destination is refused in both modes with `E_VALIDATION_ERROR`, a fix naming
the supported destinations, and no directory created.
