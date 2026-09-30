---
id: t12742-ci-descendant
tasks: [T12742]
kind: fix
summary: ci:<pr> evidence accepts green main CI on a descendant when the merge commit's push run was cancelled by concurrency
---

With branch protection `strict: false`, merges land back to back and the CI
concurrency group cancels the earlier merge commit's push run. `ci:<pr>` judged
only that run (or a tree-equal PR head), so tasks whose PRs landed cleanly could
not close even though main was green a few commits later.

`ci:<pr>` now lets a later default-branch commit's green `push` run stand in
for a required check whose merge-commit run was only `cancelled` or `skipped`.
That run tested the DESCENDANT's tree, not the merge tree, so it is accepted
only when every condition holds:

- no run or job on the merge commit failed or timed out, and none is missing;
- the PR's final head has a green latest `pull_request` run for every check
  the descendant stands in for, so a later fix never rescues a broken PR;
- the descendant descends from the merge commit (`git merge-base
  --is-ancestor`) and is one of the first 10 first-parent commits within 7 days;
- no commit between the merge and the descendant, merge commits included,
  touched the PR's changed files, a pinned workflow file or `.github/actions`
  (the whole `.github/workflows` directory when a required check has no pinned
  workflow), so nothing fixed the PR's code or weakened the CI that judged it;
- it is the first candidate with a decisive verdict: a red run refuses, and a
  pending run refuses with "wait for <sha>". Only cancelled, skipped or
  never-started runs move on to the next candidate.

The atom records `descendantSha`, `descendantRange` and `descendantPrHeadSha`,
and checks judged on the descendant carry its SHA. `cleo complete` re-fetches
the latest attempt of those runs on the descendant and the PR head, because a
GitHub re-run can turn a completed check red.
