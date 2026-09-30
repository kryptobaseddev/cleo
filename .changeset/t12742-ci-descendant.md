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

`ci:<pr>` now lets the first later default-branch commit with a decisive `push`
verdict stand in for a required check whose merge-commit run was only
`cancelled` or `skipped`. The stand-in must descend from the merge commit
(`git merge-base --is-ancestor`), be among the first 10 first-parent commits
within 7 days, and carry the PR's changed files as merged or changed only by
later merge commits. The atom records `descendantSha`, and checks judged there
carry that SHA.

Still refused: a failed or timed-out merge-commit run, any failed job on the
merge commit (even inside a cancelled run), a missing run, a non-merge commit on
main touching the PR's files, and a red first decisive descendant. A later green
run is never shopped for past a red one.
