---
id: ci-satisfies-merge-commit
tasks: [T12634]
kind: feat
summary: "New `ci:<pr>` evidence atom: required CI green on a merged PR's merge commit satisfies testsPassed and qaPassed when the project sets `evidence.ciSatisfies` (on for cleocode)"
---
Owner decision D11149.

- `ci:<pr>` is valid for `testsPassed` and `qaPassed`, and for no other gate.
  `resolveCiEvidenceAtom` (core `release/ci-evidence.ts`) first verifies the PR
  through the existing `pr:` provenance code. It then takes the required-check list
  from the same resolver: env, then `release.prRequiredWorkflows`, then branch
  protection. An undetermined list refuses.
- Each required name is judged on the merge commit's own check runs and workflow
  runs, by SHA. Only the latest attempt counts. A run on any other SHA, including
  the PR head, never counts.
- Pending, failed, cancelled, skipped and missing required checks are each refused,
  and the refusal names the check and its state.
- It is off by default. Only `"evidence": { "ciSatisfies": true }` in
  `.cleo/project-context.json` enables it. It is enabled for cleocode.
- `cleo done` / `--plan`: when the change set is a merged PR that is not stacked,
  and the project has opted in, testsPassed and qaPassed plan `ci:<pr>` and no
  local tool run. This removes the post-merge full-suite rerun.
- A `ci:` atom counts as an actual verification result for code tasks. At complete
  time it is trusted as captured, like `pr:`.
- A PR-head `pull_request` run counts for a check that failed, or is missing, on
  the merge commit only when both of these hold:
  - the head's tree is identical to the merge commit's tree;
  - the merge commit's first parent is an ancestor of the head. The base only
    advances, so the tested merge was exactly the head.

  GitHub deletes `refs/pull/<n>/merge` after merge, so the head stands in for the
  test merge. Push runs on the head never count.
- `ci:` is linked to its task the way `pr:` is: the PR's title, body or branch
  cites the task, or its diff intersects the task's declared files. The atom
  records `taskId`, and `checkTaskEvidenceContext` refuses it for any other task.
- Check identity: runs are grouped by source and event, and only the latest attempt
  in each group counts. A required check can be pinned to its GitHub App and
  workflow file. Pins come from branch protection's `checks[].app_id`, or from an
  object entry `{ name, app, workflow }` in `release.prRequiredWorkflows`. A pinned
  name never counts from another app. The atom records each check's commit, app,
  workflow and event.
- `evidence.ciChecks: { tests, qa }` declares which required checks attest
  testsPassed and which attest qaPassed. Each list must be a subset of the required
  checks. A gate without a list refuses `ci:`. For cleocode: tests=["CI"],
  qa=["CI","Lockfile Check","Contracts Dep Lint"], with all three pinned to
  `github-actions` and their workflow files.
- Code tasks need their real jobs. `evidence.ciChecks.jobs` lists job-name globs
  per gate; cleocode uses tests=["Unit Tests*"] and qa=["Type Check", "Lint &
  Format"]. Every glob must match a job from the pinned workflows, and that job
  must have succeeded. A skipped or missing job is refused by name, because the
  "CI" aggregate counts skipped jobs as a pass. Documentation, research and spike
  tasks keep the honest skip, as does a PR whose whole diff is documentation.
- A PR that edits a pinned workflow file is refused, because its pull_request run
  executed its own edit. `cleo done` falls back to local tools.
- Every check mapped in `ciChecks` must be pinned to an app. Otherwise `ci:` is
  refused and the message names the fix.
- The work must have landed: the PR's merge commit must be an ancestor of
  `origin/<default>`. A PR merged into an integration branch counts once that
  branch reaches the default branch, and never before; otherwise it is refused
  with "not on <default>". An undeterminable default branch is also refused.
- Only the diff decides whether skipped jobs are honest; a task label never does.
  A diff made entirely of documentation outside `packages/`, `crates/`, `scripts/`
  and `.github/` keeps the honest skip. A Markdown file under `packages/**` (for
  example a runtime template) counts as code.
- The default branch is resolved with `gh repo view --json defaultBranchRef`
  first, then `origin/HEAD`.
