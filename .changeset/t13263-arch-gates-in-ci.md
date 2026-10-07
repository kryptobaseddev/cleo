---
id: t13263-arch-gates-in-ci
tasks: [T13263]
kind: fix
summary: the architecture gates and the other lint workflows now run inside CI, so a failing gate blocks the merge; a lint keeps any new standalone gating workflow from reopening the gap
---

Branch protection requires only the `CI` check. The architecture gates (`Arch Boundary
Check`) and eight other lint workflows ran as separate workflows that nothing required,
so a pull request with a failing gate could still merge green. That happened with #1881.

They now run as reusable workflows (`on: workflow_call`) called from `ci.yml`, and the
`CI` aggregate needs each one, so a failure blocks the merge. The workflows are: AI SDK
Surface, Boundary Registry, Dual Implementation, Dual-Scope Reads, Duplicate Test
Filenames, Envelope Compliance, Generated Artifact Drift and Identity Pollution. They no
longer run separately as well, which ran each of them twice.

Their checks now appear as `<caller> / <job>`, for example `Arch Gates / Arch Boundary
Check`. Do not add the old `Arch Boundary Check` context to branch protection: it no
longer reports under that name, so requiring it would block every merge.

`scripts/lint-merge-bar-aggregate.mjs` now fails on any `pull_request` workflow that is
not one of:

- a required context;
- called from `ci.yml`, triggering only on `workflow_call` and with no workflow-level
  concurrency;
- listed as advisory with a reason.

`Lockfile Check` and the path-scoped native builds stay standalone for now (T13279).
