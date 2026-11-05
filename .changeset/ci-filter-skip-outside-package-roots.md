---
id: ci-filter-skip-outside-package-roots
tasks: [T14260]
kind: fix
summary: "ci evidence trusts CI's own change-filter skip for a diff outside packages/ and crates/; the evidence.ciChecks.covering table is removed"
---

`ci:<pr>` no longer needs `evidence.ciChecks.covering` to attest a non-code
PR. When the required checks (the `CI` aggregate) are green and a gate's
required jobs were skipped by CI's change filter, that skip is CI's verdict
that the change touches nothing those jobs test, but only for a diff entirely
outside the package code roots (`packages/`, `crates/`). A cancelled, failed,
pending or missing job never counts, and the atom records the skipped jobs as
`filterSkippedJobs`. Scripts-only, workflow-only and `.cleo/`-only PRs (the
#1568 and #1772 shapes) now close on merged CI with no per-path config.

The `covering` table, its schema entry and `evaluateCoveringJobs` are
deleted; a `covering` key left in a project context is ignored. CI's `code`
filter now runs the unit shards for every file under `crates/` as well as
`packages/`, and a test pins the filter to the shared `PACKAGE_CODE_ROOTS`.
