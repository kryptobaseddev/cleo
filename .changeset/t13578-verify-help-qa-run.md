---
id: t13578-verify-help-qa-run
tasks: [T13578]
kind: docs
summary: "cleo verify --help lists the qa-run atom and its receipt shape"
---

`qa-run:` shipped in v2026.10.7 (T13427), but the `--evidence` help in `cleo verify` never named it, so agents assumed it was unsupported. The atom list now includes `qa-run:<receipt.json>` with its receipt shape (`kind`, `command`, `exitCode`, `diagnostics.errors`, `roots`, `startTime`), and ct-task-executor points to it for adopting a native typecheck or lint run.
