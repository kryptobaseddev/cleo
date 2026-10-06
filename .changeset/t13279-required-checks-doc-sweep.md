---
id: t13279-required-checks-doc-sweep
tasks: [T13279]
kind: docs
summary: release docs no longer tell anyone to require a Lockfile Check context; required checks are CI and Contracts Dep Lint
---

Four release docs still listed `Lockfile Check` as a required branch-protection context:
the CI hooks parity matrix, the CI hooks taxonomy runbook, the job inventory and the main
branch-protection evidence. Copying their commands would require a context that never
reports, which would block every merge.

Every desired-state list and copyable command now names `CI` and `Contracts Dep Lint`,
with `strict=false`. The dated 2026-05-25 observations are kept as history and labelled,
and each doc carries a note on the current live state: only `CI` is required, and the
gating workflows, Lockfile Check included, run inside `CI` (T13263, T13279).
