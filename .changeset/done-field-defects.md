---
id: done-field-defects
tasks: [T12671, T12672]
kind: fix
summary: "cleo done: a component PR landed by an integration PR closes on the integration PR's CI with the component's files; --plan and done share one readiness check; ci-only closes need no worktree; no cwd noise after worktree prune"
---
Field defects hit while closing tasks for the release (main fc42e9d7d):

- **Component and integration PRs (T12671, T12672).** A task PR merged into an
  integration branch is a component. New evidence form:
  `pr:<component>@<integration>` and `ci:<component>@<integration>`. The
  integration PR supplies the merge commit on the default branch and the CI.
  The component PR supplies the task linkage and the changed files: only the
  ones its merge commit changed that survive in the integration merge.
  - `cleo done` derives this whether it is given `--pr <component>` or
    `--pr <integration>`, and also by discovery.
  - A landed component is no longer treated as stacked. It plans `ci:` with no
    local tool run and no checkout.
  - An integration PR records the component's files instead of its whole diff.
  - One module, `tasks/component-pr.ts`, holds the rule. The `pr:` and `ci:`
    validators and the change set all use it.
- **One readiness check (T12672).** `cleo done --plan` and `cleo done` now
  share a single readiness function:
  - `run-from-worktree` and `checkout-required` are plan blockers.
  - The derived evidence goes through the write's own validators in the new
    `validateGateVerify` preview mode, which runs no tool and writes nothing.
    A refusal shows up as an `evidence-refused` plan blocker.
  - `ready: true` therefore no longer meets a plan-visible refusal at `done`,
    such as "PR does not establish a relationship to task".
- **No worktree for ci-only closes (T12671).** When no tool or typed gate
  runs, `done` works from any checkout, even if a stale task worktree is
  registered.
- **No "No CLEO project found" noise (T12671).** Completing a task from inside
  its canonical worktree prunes that worktree. Later resolutions then ran from
  a deleted cwd. `pruneWorktree` now moves the process to the repository root
  before removing a worktree the process stands in.
