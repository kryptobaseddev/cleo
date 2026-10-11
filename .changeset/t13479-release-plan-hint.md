---
id: t13479-release-plan-hint
tasks: [T13479]
kind: fix
summary: release plan --tasks on a store holding none of the ids names the local-only scope and the plan-blob-sha256 dispatch path.
---

`cleo release plan --tasks …` on a checkout with no task store (a CI runner: `.cleo/cleo.db` is untracked) returned a bare `E_NOT_FOUND` with `fix: cleo exists <id>`. When every requested id is missing, the error (same code) now says task-scoped planning is local-only and that CI must dispatch `release-prepare` with the committed plan's `plan-blob-sha256`. A partial miss keeps the `cleo exists` remedy. Closes #1475.
