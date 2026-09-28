---
id: t12477-project-integrity-trigger
tasks: [T12477]
kind: docs
summary: agents run the project integrity check after a new device, restore or migration (CLEO-INJECTION.md 2.20.7 + ct-cleo)
---

Adds a Triggers row to CLEO-INJECTION.md: on a new device, restore or migration,
or when a known repo reports "Not inside a CLEO project", registry paths are
unreachable, or nexus hits ENOENT on an old path, run `cleo doctor
project-identity`, `cleo doctor --all-projects`, `cleo nexus projects clean
--orphans --dry-run` and `cleo doctor credentials`, then report. Replaces the
path-derived "Default ID" line: the portable `project_id` is the identity and a
path is only a per-device hint. ct-cleo gains the same model and steps.
