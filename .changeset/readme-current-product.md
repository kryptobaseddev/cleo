---
id: readme-current-product
tasks: [T14112]
kind: docs
summary: "README describes CLEO as it ships today, with a verified quick start and the docs-never-rot story; package READMEs point at it and drop removed commands"
---

**Root README**

- **What it covers:** tasks, evidence, the pull-request close flow (ADR-099),
  docs, memory (BRAIN), code intelligence (Nexus) and `cleo release cut`, plus
  a quick start that works on `2026.11.1-canary.2`. A fresh project needs a
  root saga first.
- **Docs that don't rot:** a section explains the documentation-rot problem
  and how CLEO Docs solves it: one canonical home, stable names, kind folders,
  drift checks and `cleo docs modernize`.
- **Removed:** the stale operation counts, the old release verbs
  (`release start`/`ship`) and links to doc paths that are moving.

**Package READMEs**

- **Pointer:** each public package README now opens with a pointer to the
  root README.
- **`packages/cleo/README.md`:** trimmed to install, quick start and
  `cleo <command> --help`. Its command table listed 6 commands the CLI no
  longer has (`commands`, `implementation`, `memory-brain`, `observe`,
  `phases`, `validate`).
- **`ct-release-orchestrator` row:** the skills README row now describes
  `cleo release cut`.
