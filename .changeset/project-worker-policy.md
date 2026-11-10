---
id: project-worker-policy
tasks: [T14456]
kind: feat
summary: "Project worker policy: resolve verification placement and project instructions in every spawn tier"
---

Projects can configure `orchestrate.workerPolicy` in `.cleo/config.json` to
require single-file local checks and place full build, tests, lint and typecheck
in required CI. The canonical composer and legacy preparation path share these
rules across harnesses without changing project-context command declarations.
Explicit owner instructions and evidence requirements remain authoritative;
missing policy preserves existing prompts and malformed policy refuses dispatch
with a repair command.

Project instruction text is bounded to 16 single-line items of 512 characters;
headings and control characters are rejected, and structured refusal envelopes
retain the repair command.
